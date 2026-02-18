# Generic Akash Wrapper
#
# Wraps ANY upstream Docker image with persistent-volume permission fixing.
# Akash mounts persistent volumes as root-owned; this entrypoint chowns
# configured paths to the app user, then drops privileges and execs the
# original CMD.
#
# Usage:
#   docker build \
#     --build-arg BASE_IMAGE=ghcr.io/org/app:v1 \
#     --build-arg PACKAGE_MANAGER=apt \
#     --build-arg BASE_CMD='["node","app.js"]' \
#     -t ghcr.io/org/app-akash:v1 \
#     -f docker/akash-base/Dockerfile .
#
# Build args:
#   BASE_IMAGE        — upstream image to wrap (required)
#   PACKAGE_MANAGER   — "apt" (Debian/Ubuntu) or "apk" (Alpine). Default: apt
#   BASE_CMD          — JSON array of the original CMD to preserve. Docker resets
#                       CMD when ENTRYPOINT changes, so this must be passed explicitly.
#
# Runtime env vars (set in template definition):
#   AKASH_CHOWN_PATHS — colon-separated paths to fix ownership
#   AKASH_RUN_USER    — user to drop to (default: node)
#   AKASH_RUN_UID     — uid for chown (default: 1000)

ARG BASE_IMAGE
FROM ${BASE_IMAGE}

ARG PACKAGE_MANAGER=apt

USER root

RUN if [ "$PACKAGE_MANAGER" = "apt" ]; then \
      apt-get update && \
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gosu && \
      rm -rf /var/lib/apt/lists/*; \
    elif [ "$PACKAGE_MANAGER" = "apk" ]; then \
      apk add --no-cache su-exec; \
    else \
      echo "Unknown PACKAGE_MANAGER: $PACKAGE_MANAGER (expected apt or apk)" && exit 1; \
    fi

COPY docker/akash-base/akash-entrypoint.sh /usr/local/bin/akash-entrypoint
RUN chmod +x /usr/local/bin/akash-entrypoint

ENTRYPOINT ["/usr/local/bin/akash-entrypoint"]

# Docker resets CMD when ENTRYPOINT changes, so we store the original
# command in AKASH_DEFAULT_CMD. The entrypoint uses it as a fallback
# when no CMD/args are provided (i.e. $@ is empty).
ARG BASE_CMD="sh"
ENV AKASH_DEFAULT_CMD="${BASE_CMD}"
