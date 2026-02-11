# Base image: built from milady-ai/milaidy source (deploy/Dockerfile).
# Push the base first:
#   cd /path/to/milaidy
#   docker build -f deploy/Dockerfile -t ghcr.io/alternatefutures/milaidy:latest .
#   docker push ghcr.io/alternatefutures/milaidy:latest
FROM ghcr.io/alternatefutures/milaidy:latest

# Akash persistent volumes are commonly mounted root-owned.
# Milaidy runs as non-root `node` (uid 1000), so we must chown the mounted
# state directory on startup and then drop privileges.
USER root

# Base image is node:22-bookworm (Debian), so use gosu.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu && \
    rm -rf /var/lib/apt/lists/*

# Clear the baked-in MILAIDY_API_TOKEN from the base image's .env so the
# dashboard is accessible on first load.  Users configure their own keys
# through the UI (same pattern as Clawdbot).
RUN sed -i '/^MILAIDY_API_TOKEN=/d' /app/.env 2>/dev/null || true

# UI reverse-proxy + static file server (serves dashboard + proxies /api)
COPY docker/milaidy-akash/serve-with-ui.mjs /usr/local/bin/serve-with-ui.mjs
RUN chmod +x /usr/local/bin/serve-with-ui.mjs

COPY docker/milaidy-akash/entrypoint.sh /usr/local/bin/milaidy-akash-entrypoint
RUN chmod +x /usr/local/bin/milaidy-akash-entrypoint

ENTRYPOINT ["/usr/local/bin/milaidy-akash-entrypoint"]

# The entrypoint manages both the Milaidy API and the UI server.
# CMD is not used — the entrypoint starts both processes directly.
CMD []
