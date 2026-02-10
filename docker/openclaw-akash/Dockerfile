FROM alpine/openclaw:main

# Akash persistent volumes are commonly mounted root-owned.
# OpenClaw runs as non-root `node` (uid 1000), so we must chown the mounted
# state directory on startup and then drop privileges.
USER root

# Install a tiny privilege-drop helper (gosu on Debian/Ubuntu; su-exec on Alpine).
RUN set -eux; \
  if command -v apt-get >/dev/null 2>&1; then \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
  elif command -v apk >/dev/null 2>&1; then \
    apk add --no-cache su-exec ca-certificates; \
  else \
    echo "No supported package manager found (need gosu or su-exec)" >&2; \
    exit 1; \
  fi

COPY docker/openclaw-akash/entrypoint.sh /usr/local/bin/openclaw-akash-entrypoint
RUN chmod +x /usr/local/bin/openclaw-akash-entrypoint

ENTRYPOINT ["/usr/local/bin/openclaw-akash-entrypoint"]

# Match our Akash template defaults.
CMD ["node","/app/openclaw.mjs","gateway","--allow-unconfigured","--bind","lan","--port","18789"]

