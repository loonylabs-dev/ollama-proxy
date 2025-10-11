FROM alpine:latest

# Install Docker CLI with Compose plugin and dependencies
RUN apk add --no-cache \
    docker-cli \
    docker-cli-compose \
    bash \
    curl \
    jq \
    grep \
    && rm -rf /var/cache/apk/*

# Create log directory
RUN mkdir -p /var/log/watchdog

# Copy watchdog script
COPY watchdog.sh /usr/local/bin/watchdog.sh
RUN chmod +x /usr/local/bin/watchdog.sh

# Set environment defaults
ENV MONITORED_CONTAINER="ollama-proxy-ollama-1" \
    CHECK_INTERVAL="5" \
    RESTART_COOLDOWN="60" \
    LOG_LEVEL="INFO"

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD pgrep -f "watchdog.sh" > /dev/null || exit 1

# Start watchdog
CMD ["/usr/local/bin/watchdog.sh"]