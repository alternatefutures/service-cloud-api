# Final published image name is always ghcr.io/alternatefutures/milady:<tag>.
# Build the upstream Milady source Dockerfile into a local base alias first,
# then build this wrapper on top of that local image.
ARG BASE_IMAGE=af-milady-base:latest
FROM ${BASE_IMAGE}

# Persistent volumes are often mounted root-owned (Akash, Phala, etc.).
# Milady runs as non-root `node` (uid 1000), so we must chown the mounted
# state directory on startup and then drop privileges.
USER root

# Base image is node:22-bookworm (Debian), so use gosu.
RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu && \
    rm -rf /var/lib/apt/lists/*

# Clear the baked-in MILADY_API_TOKEN from the base image's .env so the
# dashboard is accessible on first load. Users configure their own keys
# through the UI.
RUN sed -i '/^MILADY_API_TOKEN=/d' /app/.env 2>/dev/null || true

# UI reverse-proxy + static file server (serves dashboard + proxies /api)
COPY docker/milady-runtime/serve-with-ui.mjs /usr/local/bin/serve-with-ui.mjs
RUN chmod +x /usr/local/bin/serve-with-ui.mjs

COPY docker/milady-runtime/entrypoint.sh /usr/local/bin/milady-runtime-entrypoint
RUN chmod +x /usr/local/bin/milady-runtime-entrypoint

ENTRYPOINT ["/usr/local/bin/milady-runtime-entrypoint"]

# The entrypoint manages both the Milady API and the UI server.
# CMD is not used — the entrypoint starts both processes directly.
CMD []
