# Hyperscape full-stack (server + embedded client) — cross-platform build
# Handles better-sqlite3 QEMU failure, Vite 7/rolldown compat, and @noble/curves BigInt fix.
#
# Build from the hyperscape repo root:
#   docker build --platform linux/amd64 \
#     -f /path/to/AlternateFutures/service-cloud-api/docker/hyperscape/Dockerfile \
#     -t ghcr.io/alternatefutures/hyperscape:v5 .

FROM oven/bun:1.1.38-debian AS builder

# Build toolchain, canvas native deps, and Node.js 22 LTS.
# Vite 7 (rolldown) checks process.version and rejects Bun 1.1.38 (Node 22.6.0).
# Real Node 22 LTS (>= 22.12) runs the build scripts; Bun handles package management.
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    pkg-config \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ca-certificates \
    git \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV CI=true \
    SKIP_ASSETS=true \
    HYPERSCAPE_SKIP_BROWSER_INSTALL=true

# Root manifests
COPY package.json bun.lock turbo.json tsconfig.json ./

# Workspace manifests (server + client)
COPY packages/physx-js-webidl/package.json ./packages/physx-js-webidl/
COPY packages/decimation/package.json ./packages/decimation/
COPY packages/impostors/package.json ./packages/impostors/
COPY packages/procgen/package.json ./packages/procgen/
COPY packages/shared/package.json ./packages/shared/
COPY packages/plugin-hyperscape/package.json ./packages/plugin-hyperscape/
COPY packages/web3/package.json ./packages/web3/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

# Scripts for install hooks
COPY scripts ./scripts

# PhysX prebuilt WASM
COPY packages/client/public/web/physx-js-webidl.js ./packages/client/public/web/
COPY packages/client/public/web/physx-js-webidl.wasm ./packages/client/public/web/

# Install without lifecycle scripts to avoid better-sqlite3 compilation failure
# under QEMU cross-compilation. Bun 1.1.x properly links all packages with this flag.
RUN bun install --ignore-scripts

# Rebuild only the native modules actually needed at runtime (canvas for image
# pipelines). Skip better-sqlite3 since the server uses PostgreSQL exclusively.
RUN cd node_modules/canvas 2>/dev/null && npx node-gyp rebuild --release || true

# Downgrade Vite 7 → 6.x for the client build. The lockfile resolves vite@7.3.1
# which uses rolldown (incompatible with vite.config.ts: manualChunks object,
# vite-plugin-node-polyfills exports). Vite 6 uses rollup — fully compatible.
# All shared deps (esbuild, rollup, postcss) are already in node_modules.
RUN npm pack vite@6.4.1 --pack-destination /tmp -q && \
    rm -rf node_modules/vite && \
    mkdir -p node_modules/vite && \
    tar xzf /tmp/vite-*.tgz --strip-components=1 -C node_modules/vite && \
    rm /tmp/vite-*.tgz

# Workspace sources
COPY packages/physx-js-webidl ./packages/physx-js-webidl
COPY packages/decimation ./packages/decimation
COPY packages/impostors ./packages/impostors
COPY packages/procgen ./packages/procgen
COPY packages/shared ./packages/shared
COPY packages/plugin-hyperscape ./packages/plugin-hyperscape
COPY packages/web3 ./packages/web3
COPY packages/server ./packages/server
COPY packages/client ./packages/client

# Build workspace packages using Node.js runtime (Vite 7 requires Node >= 22.12).
RUN cd /app/packages/physx-js-webidl && npm run build && \
    cd /app/packages/decimation && npm run build && \
    cd /app/packages/impostors && npm run build && \
    cd /app/packages/procgen && (npm run build || true) && \
    cd /app/packages/shared && npm run build && \
    cd /app/packages/plugin-hyperscape && npm run build && \
    cd /app/packages/web3 && npm run build && \
    cd /app/packages/server && npm run build

# Build the client. Runtime URLs are injected via /env.js at server startup,
# so build-time defaults don't matter — window.env overrides them in the browser.
RUN cd /app/packages/client && NODE_OPTIONS='--max-old-space-size=4096' npx vite build

# ---------------------------------------------------------------------------

FROM oven/bun:1.3.10-debian AS runtime

RUN apt-get update && apt-get install -y \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libjpeg62-turbo \
    libgif7 \
    librsvg2-2 \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    CI=true \
    SKIP_ASSETS=true \
    HYPERSCAPE_SKIP_BROWSER_INSTALL=true

COPY package.json bun.lock ./
COPY packages/physx-js-webidl/package.json ./packages/physx-js-webidl/
COPY packages/decimation/package.json ./packages/decimation/
COPY packages/impostors/package.json ./packages/impostors/
COPY packages/procgen/package.json ./packages/procgen/
COPY packages/shared/package.json ./packages/shared/
COPY packages/plugin-hyperscape/package.json ./packages/plugin-hyperscape/
COPY packages/web3/package.json ./packages/web3/
COPY packages/server/package.json ./packages/server/
COPY packages/client/package.json ./packages/client/

COPY --from=builder /app/node_modules ./node_modules

# Server runtime artifacts
COPY --from=builder /app/packages/physx-js-webidl/dist ./packages/physx-js-webidl/dist
COPY --from=builder /app/packages/decimation/dist ./packages/decimation/dist
COPY --from=builder /app/packages/impostors/dist ./packages/impostors/dist
COPY --from=builder /app/packages/procgen/dist ./packages/procgen/dist
COPY --from=builder /app/packages/shared/build ./packages/shared/build
COPY --from=builder /app/packages/plugin-hyperscape/dist ./packages/plugin-hyperscape/dist
COPY --from=builder /app/packages/web3/dist ./packages/web3/dist
COPY --from=builder /app/packages/server/dist ./packages/server/dist
COPY --from=builder /app/packages/server/src ./packages/server/src
COPY --from=builder /app/packages/server/world ./packages/server/world

# Client build output — served by the game server via resolvePublicRoot()
COPY --from=builder /app/packages/client/dist ./packages/client/dist

RUN mkdir -p ./packages/server/public/live

EXPOSE 5555

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
    CMD curl -fsS http://localhost:${PORT:-5555}/status >/dev/null || exit 1

CMD ["bun", "--preload", "/app/packages/server/src/shared/polyfills.ts", "/app/packages/server/dist/index.js"]
