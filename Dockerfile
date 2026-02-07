# Dockerfile for Alternate Futures Backend (Multi-stage, Akash-optimized)
# Note: Using Debian-based images instead of Alpine for Prisma 6.x WASM compatibility

# Stage 1: Dependencies
FROM node:22-slim AS deps
WORKDIR /app/service-cloud-api

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy package files
COPY service-cloud-api/package*.json ./
COPY service-cloud-api/prisma ./prisma/

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Stage 1b: Build akash-mcp (needed for Akash deployments)
FROM node:22-slim AS akash-mcp-builder
WORKDIR /app/akash-mcp

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy akash-mcp sources
COPY akash-mcp/package*.json ./
COPY akash-mcp/tsconfig.json ./
COPY akash-mcp/src ./src
COPY akash-mcp/scripts ./scripts
COPY akash-mcp/awesome-akash ./awesome-akash

# Install all dependencies (dev needed for tsc build), build, then prune to production only
RUN npm ci
RUN npm run build
RUN npm prune --omit=dev

# Stage 2: Builder
FROM node:22-slim AS builder
WORKDIR /app/service-cloud-api

# Install system dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Copy dependencies from deps stage
COPY --from=deps /app/service-cloud-api/node_modules ./node_modules
COPY --from=deps /app/service-cloud-api/prisma ./prisma

# Copy source code
COPY service-cloud-api/package*.json ./
COPY service-cloud-api/tsconfig.json ./
COPY service-cloud-api/src ./src

# Generate Prisma client with binary engine (instead of WASM)
ENV PRISMA_CLIENT_ENGINE_TYPE=binary
RUN npx prisma generate

# Build the application
RUN npm run build

# Stage 3: Production Runner
FROM node:22-slim AS runner
WORKDIR /app/service-cloud-api

# Install required system dependencies for production
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    openssl \
    ca-certificates \
    dumb-init && \
    rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

# Copy package files for production install
COPY service-cloud-api/package*.json ./
COPY service-cloud-api/prisma ./prisma/

# Install production dependencies only
RUN npm ci --omit=dev && \
    npm cache clean --force

# Copy generated Prisma client from builder (instead of regenerating)
COPY --from=builder /app/service-cloud-api/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/service-cloud-api/node_modules/@prisma/client ./node_modules/@prisma/client

# Copy built application from builder
COPY --from=builder --chown=nodejs:nodejs /app/service-cloud-api/dist ./dist

# Copy akash-mcp runtime + dependencies (used by Akash orchestrator)
COPY --from=akash-mcp-builder --chown=nodejs:nodejs /app/akash-mcp/dist /app/akash-mcp/dist
COPY --from=akash-mcp-builder --chown=nodejs:nodejs /app/akash-mcp/node_modules /app/akash-mcp/node_modules
COPY --from=akash-mcp-builder --chown=nodejs:nodejs /app/akash-mcp/package.json /app/akash-mcp/package.json

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
