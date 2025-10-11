#!/bin/bash

# Ollama GPU Watchdog Container Script
# Monitors Ollama logs for GPU fallback issues and automatically restarts the container

# Configuration from environment variables
MONITORED_CONTAINER=${MONITORED_CONTAINER:-"ollama-proxy-ollama-gpu-1"}
COMPOSE_SERVICE_NAME=${COMPOSE_SERVICE_NAME:-"ollama-gpu"}
LOG_FILE="/var/log/watchdog/ollama-gpu-watchdog.log"
CHECK_INTERVAL=${CHECK_INTERVAL:-5}
RESTART_COOLDOWN=${RESTART_COOLDOWN:-60}
LOG_LEVEL=${LOG_LEVEL:-"INFO"}

# Patterns that indicate GPU fallback or CUDA errors
PROBLEM_PATTERNS=(
    "insufficient VRAM to load any model layers"
    "offloaded 0/[0-9]* layers to GPU"
    "gpu VRAM usage didn't recover within timeout"
    "runner.vram=\"0 B\""
    "cuda driver library failed to get device context"
    "ggml_cuda_init: failed to initialize CUDA: no CUDA-capable device is detected"
    "Failed to initialize NVML: Unknown Error"
)

# Warning patterns (potential issues, don't trigger immediate restart)
WARNING_PATTERNS=(
    "context limit hit - shifting"
)

# Hung request detection (in seconds)
HUNG_REQUEST_TIMEOUT=${HUNG_REQUEST_TIMEOUT:-300}  # 5 minutes default

# Colors for console output (disabled in container by default)
if [ -t 1 ]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    NC=''
fi

# Initialize
RESTART_COUNT=0
LAST_RESTART=0

# Escalation tracking
LAST_ERROR_PATTERN=""
LAST_RESTART_METHOD=""
CONSECUTIVE_FAILURES=0

# Deduplication for log patterns (prevent spam)
declare -A SEEN_LOG_LINES
SEEN_LOG_COUNT=0
MAX_SEEN_LOGS=100

# Create log file
mkdir -p "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"

# JSON logging function for container environments
log_json() {
    local level=$1
    local message=$2
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")

    # Only log if level is appropriate
    if [[ "$level" == "DEBUG" && "$LOG_LEVEL" != "DEBUG" ]]; then
        return
    fi

    # JSON structured log
    echo "{\"timestamp\":\"$timestamp\",\"level\":\"$level\",\"service\":\"ollama-gpu-watchdog\",\"container\":\"$MONITORED_CONTAINER\",\"message\":\"$message\",\"restart_count\":$RESTART_COUNT}" | tee -a "$LOG_FILE"
}

# Legacy log function for backwards compatibility
log_message() {
    local level=$1
    local message=$2
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')

    # File logging
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"

    # Console logging with colors
    case $level in
        ERROR)
            echo -e "${RED}[$timestamp] [ERROR] $message${NC}" >&2
            ;;
        SUCCESS)
            echo -e "${GREEN}[$timestamp] [SUCCESS] $message${NC}"
            ;;
        WARNING)
            echo -e "${YELLOW}[$timestamp] [WARNING] $message${NC}"
            ;;
        INFO)
            if [[ "$LOG_LEVEL" == "INFO" || "$LOG_LEVEL" == "DEBUG" ]]; then
                echo -e "${BLUE}[$timestamp] [INFO] $message${NC}"
            fi
            ;;
        DEBUG)
            if [[ "$LOG_LEVEL" == "DEBUG" ]]; then
                echo "[$timestamp] [DEBUG] $message"
            fi
            ;;
        *)
            echo "[$timestamp] $message"
            ;;
    esac

    # Also send JSON log
    log_json "$level" "$message"
}

# Check if container exists and is running
check_container() {
    if ! docker ps --format '{{.Names}}' | grep -q "^${MONITORED_CONTAINER}$"; then
        log_message ERROR "Container $MONITORED_CONTAINER not found or not running!"
        return 1
    fi
    return 0
}

# Check if ollama runner process is hung (running too long)
check_runner_duration() {
    # Get ollama runner PID from container
    local runner_pid=$(docker exec "$MONITORED_CONTAINER" sh -c "ps aux | grep 'ollama runner' | grep -v grep | awk '{print \$2}' | head -1" 2>/dev/null)

    if [ -z "$runner_pid" ]; then
        # No runner process found - model not loaded, that's OK
        return 0
    fi

    # Get process elapsed time in seconds
    local etime=$(docker exec "$MONITORED_CONTAINER" sh -c "ps -o etimes= -p $runner_pid 2>/dev/null | tr -d ' '" 2>/dev/null)

    if [ -z "$etime" ]; then
        # Process info not available
        return 0
    fi

    if [ "$etime" -gt "$HUNG_REQUEST_TIMEOUT" ]; then
        log_message WARNING "Ollama runner process has been running for ${etime}s (threshold: ${HUNG_REQUEST_TIMEOUT}s)"
        log_message WARNING "Likely hung request detected - PID: $runner_pid"
        return 1  # Hung request detected
    fi

    return 0  # All good
}

# Restart container with escalation logic
restart_container() {
    local reason=$1
    local current_time=$(date +%s)

    # Check cooldown
    if [ $((current_time - LAST_RESTART)) -lt $RESTART_COOLDOWN ]; then
        local remaining=$((RESTART_COOLDOWN - (current_time - LAST_RESTART)))
        log_message WARNING "Skipping restart - cooldown active (${remaining}s remaining)"
        return
    fi

    # Escalation logic: Check if same error as before
    if [[ "$reason" == "$LAST_ERROR_PATTERN" ]]; then
        CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
        log_message WARNING "Same error detected again (failure #$CONSECUTIVE_FAILURES): $reason"
    else
        # Different error, reset counter
        CONSECUTIVE_FAILURES=1
        LAST_ERROR_PATTERN="$reason"
        log_message WARNING "New error detected: $reason"
    fi

    # Escalation: If 2nd+ consecutive failure, use full recreation
    if [ $CONSECUTIVE_FAILURES -ge 2 ]; then
        log_message WARNING "Quick restart didn't help, escalating to full recreation"
        recreate_container "$reason"
        return
    fi

    # First attempt: Quick restart
    RESTART_COUNT=$((RESTART_COUNT + 1))
    log_message WARNING "GPU fallback detected: $reason"
    log_message WARNING "Initiating quick container restart #$RESTART_COUNT (attempt $CONSECUTIVE_FAILURES)"

    # Restart the container
    if docker restart "$MONITORED_CONTAINER" > /dev/null 2>&1; then
        log_message SUCCESS "Container $MONITORED_CONTAINER restarted successfully"
        LAST_RESTART=$current_time
        LAST_RESTART_METHOD="restart"

        # Wait for container to be ready
        sleep 10

        # Verify container is running
        if docker ps --format '{{.Names}}' | grep -q "^${MONITORED_CONTAINER}$"; then
            log_message SUCCESS "Container is running after restart"

            # Try to verify GPU access (best effort)
            if docker exec "$MONITORED_CONTAINER" nvidia-smi > /dev/null 2>&1; then
                log_message SUCCESS "GPU access verified after restart"
                # Success! Reset consecutive failures
                CONSECUTIVE_FAILURES=0
            else
                log_message WARNING "Could not verify GPU access after restart (container may still be initializing)"
            fi
        else
            log_message ERROR "Container not running after restart!"
        fi
    else
        log_message ERROR "Failed to restart container $MONITORED_CONTAINER"
    fi
}

# Recreate container using docker compose (for stubborn GPU context errors)
recreate_container() {
    local reason=$1
    local current_time=$(date +%s)

    # Check cooldown
    if [ $((current_time - LAST_RESTART)) -lt $RESTART_COOLDOWN ]; then
        local remaining=$((RESTART_COOLDOWN - (current_time - LAST_RESTART)))
        log_message WARNING "Skipping recreation - cooldown active (${remaining}s remaining)"
        return
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    log_message WARNING "Escalating to full container recreation: $reason"
    log_message WARNING "Initiating container recreation #$RESTART_COUNT (via docker compose)"

    # Use docker compose to recreate the container
    if docker compose -p "$COMPOSE_PROJECT_NAME" up -d --force-recreate "$COMPOSE_SERVICE_NAME" > /dev/null 2>&1; then
        log_message SUCCESS "Container recreated successfully via docker compose"
        LAST_RESTART=$current_time
        LAST_RESTART_METHOD="recreate"

        # Wait longer for full recreation
        sleep 15

        # Verify container is running
        if docker ps --format '{{.Names}}' | grep -q "^${MONITORED_CONTAINER}$"; then
            log_message SUCCESS "Container is running after recreation"

            # Try to verify GPU access
            if docker exec "$MONITORED_CONTAINER" nvidia-smi > /dev/null 2>&1; then
                log_message SUCCESS "GPU access verified after recreation"
                # Success! Reset consecutive failures
                CONSECUTIVE_FAILURES=0
            else
                log_message WARNING "Could not verify GPU access after recreation (container may still be initializing)"
            fi
        else
            log_message ERROR "Container not running after recreation!"
        fi
    else
        log_message ERROR "Failed to recreate container via docker compose"
    fi
}

# Monitor logs
monitor_logs() {
    log_message INFO "Starting Ollama GPU Watchdog (Container Mode)"
    log_message INFO "Monitoring GPU container: $MONITORED_CONTAINER"
    log_message INFO "Compose service name: $COMPOSE_SERVICE_NAME"
    log_message INFO "Log file: $LOG_FILE"
    log_message INFO "Check interval: ${CHECK_INTERVAL}s"
    log_message INFO "Restart cooldown: ${RESTART_COOLDOWN}s"
    log_message INFO "Hung request timeout: ${HUNG_REQUEST_TIMEOUT}s"
    log_message INFO "Log level: $LOG_LEVEL"

    # Follow logs and check for patterns
    while true; do
        if ! check_container; then
            log_message ERROR "Container check failed, waiting 30s before retry..."
            sleep 30
            continue
        fi

        # Check for hung requests (long-running runner processes)
        if ! check_runner_duration; then
            log_message WARNING "Hung request detected - initiating restart"
            restart_container "hung request timeout (${HUNG_REQUEST_TIMEOUT}s)"
            sleep "$CHECK_INTERVAL"
            continue
        fi

        # Get recent logs and check for patterns (with deduplication)
        while read -r line; do
            # Create fingerprint for this log line to detect duplicates
            line_hash=$(echo "$line" | md5sum | awk '{print $1}')

            # Check if we've seen this exact log line before
            if [[ -n "${SEEN_LOG_LINES[$line_hash]}" ]]; then
                # Already seen, skip to prevent spam
                continue
            fi

            # Mark as seen
            SEEN_LOG_LINES[$line_hash]=1
            SEEN_LOG_COUNT=$((SEEN_LOG_COUNT + 1))

            # If we've seen too many lines, clear old ones to prevent memory issues
            if [ $SEEN_LOG_COUNT -gt $MAX_SEEN_LOGS ]; then
                SEEN_LOG_LINES=()
                SEEN_LOG_COUNT=0
                log_message DEBUG "Cleared deduplication cache (reached $MAX_SEEN_LOGS entries)"
            fi

            # Check warning patterns (log only, no restart)
            for pattern in "${WARNING_PATTERNS[@]}"; do
                if echo "$line" | grep -E "$pattern" > /dev/null 2>&1; then
                    log_message WARNING "Potential issue detected: $pattern"
                    log_message DEBUG "Warning log line: $line"
                fi
            done

            # Check problem patterns (trigger restart)
            for pattern in "${PROBLEM_PATTERNS[@]}"; do
                if echo "$line" | grep -E "$pattern" > /dev/null 2>&1; then
                    log_message WARNING "GPU fallback pattern detected in logs: $pattern"
                    log_message DEBUG "Matching log line: $line"
                    restart_container "$pattern"
                    break
                fi
            done
        done < <(docker logs --tail 50 "$MONITORED_CONTAINER" 2>&1)

        sleep "$CHECK_INTERVAL"
    done
}

# Signal handlers for graceful shutdown
cleanup() {
    log_message INFO "GPU Watchdog shutting down gracefully..."
    log_message INFO "Total restarts performed: $RESTART_COUNT"
    exit 0
}

trap cleanup SIGTERM SIGINT

# Health check endpoint (for Docker health check)
if [[ "$1" == "healthcheck" ]]; then
    if pgrep -f "watchdog.sh" > /dev/null; then
        echo "GPU Watchdog is running"
        exit 0
    else
        echo "GPU Watchdog is not running"
        exit 1
    fi
fi

# Main
main() {
    log_message INFO "============================================"
    log_message INFO "  Ollama GPU Watchdog Container Started  "
    log_message INFO "============================================"

    # Wait a moment for the monitored container to start
    sleep 5

    # Initial container check
    if ! check_container; then
        log_message ERROR "Monitored container not available at startup"
        log_message INFO "Waiting for container to start..."

        # Wait up to 2 minutes for container
        for i in {1..24}; do
            sleep 5
            if check_container; then
                log_message SUCCESS "Monitored container is now available"
                break
            fi

            if [ $i -eq 24 ]; then
                log_message ERROR "Monitored container did not start within 2 minutes"
                exit 1
            fi
        done
    fi

    # Initial GPU check (optional - don't fail if it doesn't work)
    if docker exec "$MONITORED_CONTAINER" nvidia-smi > /dev/null 2>&1; then
        log_message SUCCESS "Initial GPU check: OK"
    else
        log_message WARNING "Initial GPU check: Could not verify GPU access"
    fi

    # Start monitoring
    monitor_logs
}

# Run main function
main