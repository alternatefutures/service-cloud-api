import { createYoga } from 'graphql-yoga'
import type { Plugin } from 'graphql-yoga'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PrismaClient } from '@prisma/client'
import { makeExecutableSchema } from '@graphql-tools/schema'
import { typeDefs } from './schema/typeDefs.js'
import { resolvers } from './resolvers/index.js'
import { getAuthContext } from './auth/middleware.js'
import { ChatServer } from './services/chat/chatServer.js'
import { handleStripeWebhook } from './services/billing/webhookHandler.js'
import {
  StorageSnapshotScheduler,
  InvoiceScheduler,
  UsageAggregator,
  ComputeBillingScheduler,
} from './services/billing/index.js'
import { handleComputeResumeCheck } from './services/billing/resumeHandler.js'
import {
  getTelemetryIngestionService,
  handleTelemetryWebhook,
  handleTelemetryStats,
} from './services/observability/index.js'
import { startSslRenewalJob } from './jobs/sslRenewal.js'
import depthLimit from 'graphql-depth-limit'
import { createComplexityLimitRule } from 'graphql-validation-complexity'
import helmet from 'helmet'
import { initInfisical } from './config/infisical.js'
import { SubdomainProxy } from './services/proxy/subdomainProxy.js'
import { AkashOrchestrator } from './services/akash/orchestrator.js'
import {
  registerProvider,
  createAkashProvider,
  createPhalaProvider,
} from './services/providers/index.js'

// Initialize Infisical (or dotenv fallback) before anything else
await initInfisical()

const prisma = new PrismaClient()

// Initialize billing schedulers
const storageSnapshotScheduler = new StorageSnapshotScheduler(prisma)
const invoiceScheduler = new InvoiceScheduler(prisma)
const usageAggregator = new UsageAggregator(prisma)
const computeBillingScheduler = new ComputeBillingScheduler(prisma)
const telemetryIngestionService = getTelemetryIngestionService(prisma)
const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    console.error('FATAL: JWT_SECRET is not set. Refusing to start in production without a proper secret.')
    process.exit(1)
  }
  console.warn('⚠️  JWT_SECRET not set — using insecure development default. Do NOT use in production.')
}
const effectiveJwtSecret = jwtSecret || 'development-secret-change-in-production'

const schema = makeExecutableSchema({
  typeDefs,
  resolvers,
})

// Security limits for GraphQL queries
const MAX_DEPTH = 10
// SDK-generated queries (notably Sites list) are fairly "wide" and can
// exceed conservative complexity limits in development.
const MAX_COMPLEXITY = 15000

// Custom plugin to add validation rules for depth and complexity limits
const useValidationRules = (): Plugin => {
  return {
    onValidate({ addValidationRule }) {
      addValidationRule(depthLimit(MAX_DEPTH))
      addValidationRule(
        createComplexityLimitRule(MAX_COMPLEXITY, {
          scalarCost: 1,
          objectCost: 2,
          listFactor: 10,
        })
      )
    },
  }
}

// Plugin to log GraphQL operations
const useLogging = (): Plugin => {
  return {
    onExecute({ args }) {
      const operationName = args.operationName || 'anonymous'
      const query = args.document?.loc?.source?.body?.substring(0, 300) || 'unknown'
      console.log(`[GraphQL] Executing: ${operationName}`)
      console.log(`[GraphQL] Query: ${query}`)
    },
    onResultProcess({ result }) {
      if ('errors' in result && result.errors) {
        console.log('[GraphQL] Errors:', JSON.stringify(result.errors))
      }
    },
  }
}

const yoga = createYoga({
  schema,
  context: async ({ request }) => {
    const authContext = await getAuthContext(request, prisma)
    return {
      prisma,
      ...authContext,
    }
  },
  cors: {
    origin: process.env.APP_URL || '*',
    credentials: true,
  },
  graphqlEndpoint: '/graphql',
  landingPage: true,
  maskedErrors: process.env.NODE_ENV === 'production',
  plugins: [useValidationRules(), useLogging()],
})

// Apply security headers middleware
const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"], // GraphiQL needs inline styles
      scriptSrc: ["'self'", "'unsafe-inline'"], // GraphiQL needs inline scripts
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", process.env.APP_URL || '*'],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow GraphiQL to work
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
})

// Subdomain reverse proxy for *.apps.alternatefutures.ai / *.agents.alternatefutures.ai
const subdomainProxy = new SubdomainProxy(prisma)

// Custom request handler to intercept webhook requests
async function requestHandler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)

  // ── Subdomain proxy (must run FIRST, before helmet/yoga) ──────────────
  // Requests arriving on *.apps.alternatefutures.ai or *.agents.alternatefutures.ai
  // are reverse-proxied directly to the Akash/Phala backend.
  const proxied = await subdomainProxy.handleRequest(req, res)
  if (proxied) return

  // Log all incoming requests (API traffic only — proxied requests logged by proxy)
  console.log(`<-- ${req.method} ${url.pathname}`)

  // Apply security headers
  await new Promise<void>(resolve => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    helmetMiddleware(req as any, res as any, resolve as any)
  })

  // Handle Stripe webhooks
  if (url.pathname === '/webhooks/stripe') {
    await handleStripeWebhook(req, res, prisma)
    return
  }

  // Handle telemetry ingestion webhook (internal - from OTEL Collector)
  if (url.pathname === '/internal/telemetry/ingestion-webhook') {
    await handleTelemetryWebhook(req, res, prisma)
    return
  }

  // Handle telemetry stats endpoint (internal - for monitoring)
  if (url.pathname === '/internal/telemetry/stats') {
    await handleTelemetryStats(req, res, prisma)
    return
  }

  // Handle compute resume check (internal - called by auth service after topup)
  if (url.pathname === '/internal/compute/check-resume' && req.method === 'POST') {
    await handleComputeResumeCheck(req, res, prisma)
    return
  }

  // Handle proxy cache flush (internal - for deployment updates)
  if (url.pathname === '/internal/proxy/flush-cache' && req.method === 'POST') {
    subdomainProxy.flushCache()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Pass all other requests to Yoga
  return yoga(req, res)
}

// Create HTTP server with custom request handler
const server = createServer(requestHandler)

// Initialize Chat WebSocket Server
const chatServer = new ChatServer(prisma, effectiveJwtSecret)

// Handle WebSocket upgrade for /ws path and proxied subdomains
server.on('upgrade', async (request, socket, head) => {
  // Check if this is a proxied subdomain WebSocket upgrade
  const wsProxied = await subdomainProxy.handleUpgrade(request, socket, head)
  if (wsProxied) return

  const { pathname } = new URL(
    request.url || '/',
    `http://${request.headers.host}`
  )

  if (pathname === '/ws') {
    chatServer.handleUpgrade(request, socket, head)
  } else {
    socket.destroy()
  }
})

const port = process.env.PORT || 1602

server.listen(port, () => {
  console.log(`🚀 GraphQL server running at http://localhost:${port}/graphql`)
  console.log(`💬 WebSocket chat server running at ws://localhost:${port}/ws`)

  // Start billing schedulers
  storageSnapshotScheduler.start()
  invoiceScheduler.start()
  usageAggregator.start()
  computeBillingScheduler.start()
  telemetryIngestionService.start()
  console.log(`📊 Billing schedulers started (invoices 2AM, compute 3AM)`)
  console.log(`⚡ Usage aggregator running (1-minute intervals)`)
  console.log(`📈 Telemetry ingestion service running`)

  // Start SSL renewal job
  startSslRenewalJob()
  console.log(`🔒 SSL renewal job started (runs daily at 2 AM)`)

  // Register deployment providers
  registerProvider(createAkashProvider(prisma))
  registerProvider(createPhalaProvider(prisma))
  console.log('🔌 Deployment providers registered')

  // Resume any interrupted URI backfills from previous pod lifecycle
  const orchestrator = new AkashOrchestrator(prisma)
  orchestrator.resumePendingBackfills()
})

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM signal received: closing HTTP server')
  server.close(async () => {
    await chatServer.shutdown()
    await usageAggregator.shutdown()
    await telemetryIngestionService.stop()
    await prisma.$disconnect()
    process.exit(0)
  })
})

process.on('SIGINT', async () => {
  console.log('\nSIGINT signal received: closing HTTP server')
  server.close(async () => {
    await chatServer.shutdown()
    await usageAggregator.shutdown()
    await telemetryIngestionService.stop()
    await prisma.$disconnect()
    process.exit(0)
  })
})
