# Hyperscape game server — cross-platform build-friendly variant
# Based on upstream Dockerfile.server but handles better-sqlite3 compilation
# failure under QEMU (Apple Silicon → linux/amd64 cross-compilation).
# Uses split Bun versions: 1.1.38 builder (reliable --ignore-scripts linking)
# + 1.3.10 runtime (BigInt crypto fix for @noble/curves).
#
# Build from the hyperscape repo root:
#   docker build --platform linux/amd64 \
#     -f /path/to/this/Dockerfile \
#     -t ghcr.io/alternatefutures/hyperscape:v2 .

FROM oven/bun:1.1.38-debian AS builder

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
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV CI=true \
    SKIP_ASSETS=true \
    HYPERSCAPE_SKIP_BROWSER_INSTALL=true

# Root manifests
COPY package.json bun.lock turbo.json tsconfig.json ./

# Workspace manifests
COPY packages/physx-js-webidl/package.json ./packages/physx-js-webidl/
COPY packages/decimation/package.json ./packages/decimation/
COPY packages/impostors/package.json ./packages/impostors/
COPY packages/procgen/package.json ./packages/procgen/
COPY packages/shared/package.json ./packages/shared/
COPY packages/plugin-hyperscape/package.json ./packages/plugin-hyperscape/
COPY packages/web3/package.json ./packages/web3/
COPY packages/server/package.json ./packages/server/

# Scripts for install hooks
COPY scripts ./scripts

# PhysX prebuilt WASM
COPY packages/client/public/web/physx-js-webidl.js ./packages/client/public/web/
COPY packages/client/public/web/physx-js-webidl.wasm ./packages/client/public/web/

# Workspace sources
COPY packages/physx-js-webidl ./packages/physx-js-webidl
COPY packages/decimation ./packages/decimation
COPY packages/impostors ./packages/impostors
COPY packages/procgen ./packages/procgen
COPY packages/shared ./packages/shared
COPY packages/plugin-hyperscape ./packages/plugin-hyperscape
COPY packages/web3 ./packages/web3
COPY packages/server ./packages/server

# Install without lifecycle scripts to avoid better-sqlite3 compilation failure
# under QEMU cross-compilation. Bun 1.1.x properly links all packages with this flag.
RUN bun install --ignore-scripts

# Rebuild only the native modules actually needed at runtime (canvas for image
# pipelines). Skip better-sqlite3 since the server uses PostgreSQL exclusively.
RUN cd node_modules/canvas 2>/dev/null && npx node-gyp rebuild --release || true

# Build in dependency order
RUN cd /app/packages/physx-js-webidl && bun run build && \
    cd /app/packages/decimation && bun run build && \
    cd /app/packages/impostors && bun run build && \
    cd /app/packages/procgen && (bun run build || true) && \
    cd /app/packages/shared && bun run build && \
    cd /app/packages/plugin-hyperscape && bun run build && \
    cd /app/packages/web3 && bun run build && \
    cd /app/packages/server && bun run build

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

COPY --from=builder /app/node_modules ./node_modules

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

RUN mkdir -p ./packages/server/public/live

EXPOSE 5555

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=5 \
    CMD curl -fsS http://localhost:${PORT:-5555}/status >/dev/null || exit 1

CMD ["bun", "--preload", "/app/packages/server/src/shared/polyfills.ts", "/app/packages/server/dist/index.js"]
