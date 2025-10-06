#!/bin/bash

# Ollama GPU Watchdog Container Script
# Monitors Ollama logs for GPU fallback issues and automatically restarts the container

# Configuration from environment variables
MONITORED_CONTAINER=${MONITORED_CONTAINER:-"ollama-proxy-ollama-1"}
LOG_FILE="/var/log/watchdog/ollama-watchdog.log"
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
    echo "{\"timestamp\":\"$timestamp\",\"level\":\"$level\",\"service\":\"ollama-watchdog\",\"container\":\"$MONITORED_CONTAINER\",\"message\":\"$message\",\"restart_count\":$RESTART_COUNT}" | tee -a "$LOG_FILE"
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

# Restart container
restart_container() {
    local reason=$1
    local current_time=$(date +%s)

    # Check cooldown
    if [ $((current_time - LAST_RESTART)) -lt $RESTART_COOLDOWN ]; then
        local remaining=$((RESTART_COOLDOWN - (current_time - LAST_RESTART)))
        log_message WARNING "Skipping restart - cooldown active (${remaining}s remaining)"
        return
    fi

    RESTART_COUNT=$((RESTART_COUNT + 1))
    log_message WARNING "GPU fallback detected: $reason"
    log_message WARNING "Initiating container restart #$RESTART_COUNT"

    # Restart the container
    if docker restart "$MONITORED_CONTAINER" > /dev/null 2>&1; then
        log_message SUCCESS "Container $MONITORED_CONTAINER restarted successfully"
        LAST_RESTART=$current_time

        # Wait for container to be ready
        sleep 10

        # Verify container is running
        if docker ps --format '{{.Names}}' | grep -q "^${MONITORED_CONTAINER}$"; then
            log_message SUCCESS "Container is running after restart"

            # Try to verify GPU access (best effort)
            if docker exec "$MONITORED_CONTAINER" nvidia-smi > /dev/null 2>&1; then
                log_message SUCCESS "GPU access verified after restart"
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

# Monitor logs
monitor_logs() {
    log_message INFO "Starting Ollama GPU Watchdog (Container Mode)"
    log_message INFO "Monitoring container: $MONITORED_CONTAINER"
    log_message INFO "Log file: $LOG_FILE"
    log_message INFO "Check interval: ${CHECK_INTERVAL}s"
    log_message INFO "Restart cooldown: ${RESTART_COOLDOWN}s"
    log_message INFO "Log level: $LOG_LEVEL"

    # Follow logs and check for patterns
    while true; do
        if ! check_container; then
            log_message ERROR "Container check failed, waiting 30s before retry..."
            sleep 30
            continue
        fi

        # Get recent logs and check for patterns
        docker logs --tail 50 "$MONITORED_CONTAINER" 2>&1 | while read -r line; do
            for pattern in "${PROBLEM_PATTERNS[@]}"; do
                if echo "$line" | grep -E "$pattern" > /dev/null 2>&1; then
                    log_message WARNING "GPU fallback pattern detected in logs: $pattern"
                    log_message DEBUG "Matching log line: $line"
                    restart_container "$pattern"
                    break
                fi
            done
        done

        sleep "$CHECK_INTERVAL"
    done
}

# Signal handlers for graceful shutdown
cleanup() {
    log_message INFO "Watchdog shutting down gracefully..."
    log_message INFO "Total restarts performed: $RESTART_COUNT"
    exit 0
}

trap cleanup SIGTERM SIGINT

# Health check endpoint (for Docker health check)
if [[ "$1" == "healthcheck" ]]; then
    if pgrep -f "watchdog.sh" > /dev/null; then
        echo "Watchdog is running"
        exit 0
    else
        echo "Watchdog is not running"
        exit 1
    fi
fi

# Main
main() {
    log_message INFO "============================================"
    log_message INFO "Ollama GPU Watchdog Container Started"
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