# nanobot-akash: Wrapper for Akash deployment
# - Generates ~/.nanobot/config.json from env vars at boot
# - Runs nanobot gateway (no web UI; CLI/Telegram/Discord channels)
#
# Base: official nanobot is pip-installable; we use minimal Python image.
FROM python:3.12-slim-bookworm

# Create nanobot user (uid 1000) for non-root runtime
RUN useradd -m -u 1000 -s /bin/sh nanobot

# Install gosu for privilege drop (Akash volumes mount root-owned)
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install nanobot
RUN pip install --no-cache-dir nanobot-ai

# Create config directory (will be overridden by persistent volume mount)
RUN mkdir -p /root/.nanobot

# Copy entrypoint
COPY docker/nanobot-akash/entrypoint.sh /usr/local/bin/nanobot-akash-entrypoint
RUN chmod +x /usr/local/bin/nanobot-akash-entrypoint

ENTRYPOINT ["/usr/local/bin/nanobot-akash-entrypoint"]
# Entrypoint handles CMD — runs nanobot gateway
CMD []
