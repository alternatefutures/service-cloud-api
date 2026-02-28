# Dockerfile for Alternate Futures Backend (Multi-stage, K3s-optimized)
# Note: Using Debian-based images instead of Alpine for Prisma 6.x WASM compatibility

# Stage 1: Dependencies
FROM node:22-slim AS deps
WORKDIR /app/service-cloud-api

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY service-cloud-api/package.json service-cloud-api/pnpm-lock.yaml ./
COPY service-cloud-api/prisma ./prisma/

RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM node:22-slim AS builder
WORKDIR /app/service-cloud-api

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY --from=deps /app/service-cloud-api/node_modules ./node_modules
COPY --from=deps /app/service-cloud-api/prisma ./prisma

COPY service-cloud-api/package.json service-cloud-api/pnpm-lock.yaml ./
COPY service-cloud-api/tsconfig.json ./
COPY service-cloud-api/src ./src

ENV PRISMA_CLIENT_ENGINE_TYPE=binary
RUN pnpm exec prisma generate

RUN pnpm run build

# Prune dev dependencies but keep generated Prisma client
RUN pnpm prune --prod

# Stage 3: Production Runner (Ubuntu 24.04 for GLIBC 2.39 - needed by provider-services)
FROM ubuntu:24.04 AS runner
WORKDIR /app/service-cloud-api

# Install Node.js 22 and system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    curl \
    dumb-init \
    unzip && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Akash CLI (used by AkashOrchestrator for user deployments)
RUN curl -sSfL -o /tmp/akash.zip https://github.com/akash-network/node/releases/download/v1.1.1/akash_linux_amd64.zip && \
    unzip /tmp/akash.zip -d /tmp/akash && \
    mv /tmp/akash/akash /usr/local/bin/akash && \
    chmod +x /usr/local/bin/akash && \
    rm -rf /tmp/akash /tmp/akash.zip

# Install provider-services CLI
RUN curl -sSfL -o /tmp/provider-services.zip https://github.com/akash-network/provider/releases/download/v0.10.5/provider-services_linux_amd64.zip && \
    unzip /tmp/provider-services.zip -d /tmp/ps && \
    mv /tmp/ps/provider-services /usr/local/bin/provider-services && \
    chmod +x /usr/local/bin/provider-services && \
    rm -rf /tmp/ps /tmp/provider-services.zip && \
    apt-get purge -y unzip && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

# Create a non-root user with home directory (needed by akash CLI for ~/.akash)
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs -m -d /home/nodejs nodejs

# Install prisma CLI globally (needed for kubectl exec prisma migrate deploy)
# Version MUST match the prisma version in package.json
# chown so the nodejs user can access the engine binaries at runtime
RUN npm install -g prisma@6 && \
    chown -R nodejs:nodejs /usr/lib/node_modules/prisma

# Copy prod node_modules (already pruned with prisma client generated) from builder
COPY --from=builder /app/service-cloud-api/package.json ./
COPY --from=builder /app/service-cloud-api/node_modules ./node_modules
COPY --from=builder /app/service-cloud-api/prisma ./prisma

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/service-cloud-api/dist ./dist

# Copy entrypoint script
COPY --chown=nodejs:nodejs service-cloud-api/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

# Change ownership to non-root user
RUN chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:4000/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Use dumb-init to handle signals properly
ENTRYPOINT ["/usr/bin/dumb-init", "--"]

# Run migrations and start application
CMD ["./docker-entrypoint.sh"]
