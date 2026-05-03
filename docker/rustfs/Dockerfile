# Provider-agnostic RustFS image for AlternateFutures.
#
# Pure thin wrapper: takes the official upstream rustfs/rustfs image
# unmodified, layers our generic akash-entrypoint on top. NO rebranding,
# NO env aliases, NO log filtering. The binary, env-var names, default
# console UI and version string are all whatever upstream ships.
#
# The akash-entrypoint short-circuits to plain `exec "$@"` when
# `AKASH_CHOWN_PATHS` is unset, so the same image runs unchanged on
# Phala (CVM with no persistent volume), Spheron (when wired), local
# Docker, and any non-Akash environment. Only Akash needs the chown
# dance because k8s persistent volumes mount root-owned by default.
#
# Build:
#   docker build --platform linux/amd64 \
#     -f docker/rustfs/Dockerfile \
#     -t ghcr.io/alternatefutures/rustfs:1.0.0-beta.1 .
#
# Tag pinning: the image tag mirrors the upstream RustFS release tag
# verbatim so it's obvious which upstream version is wrapped. Bump in
# lockstep with `templates/definitions/rustfs.ts:dockerImage`.

FROM rustfs/rustfs:1.0.0-beta.1

USER root

# `su-exec` is the Alpine-native equivalent of `gosu`. Our generic
# akash-entrypoint prefers gosu, falls back to su-exec, then `su`.
RUN apk add --no-cache su-exec

COPY docker/akash-base/akash-entrypoint.sh /usr/local/bin/akash-entrypoint
RUN chmod +x /usr/local/bin/akash-entrypoint

# Tell akash-entrypoint which user to drop privileges to. These match
# the upstream image's USER directive (uid/gid 10001, name `rustfs`)
# so the upstream entrypoint that follows runs in the exact same
# context it would have run as upstream's USER.
ENV AKASH_RUN_USER=rustfs \
    AKASH_RUN_UID=10001

# Wrap upstream's entrypoint:
#   1. akash-entrypoint runs as root (because we removed USER)
#   2. If AKASH_CHOWN_PATHS is set, chown each path to uid 10001
#   3. Drop privileges to rustfs via su-exec
#   4. exec /entrypoint.sh rustfs  -> upstream's normalisation + boot
#
# CMD is preserved verbatim from upstream (`["rustfs"]`) — anything
# the user passes via SDL `args:` overrides it the same way it would
# have overridden the original CMD.
ENTRYPOINT ["/usr/local/bin/akash-entrypoint", "/entrypoint.sh"]
CMD ["rustfs"]
