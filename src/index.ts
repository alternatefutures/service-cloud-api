import './instrumentation.js'

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
  EscrowHealthMonitor,
} from './services/billing/index.js'
import { handleComputeResumeCheck } from './services/billing/resumeHandler.js'
import { handleSuspendOrg } from './services/billing/suspendOrgHandler.js'
import { handleMockDeployment, handleMockCleanup } from './services/testing/mockDeploymentHandler.js'
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
import {
  initQueueHandler,
  handleAkashWebhook,
  handlePhalaWebhook,
  handlePolicyWebhook,
} from './services/queue/index.js'
import { startStaleDeploymentSweeper, stopStaleDeploymentSweeper } from './services/queue/staleDeploymentSweeper.js'
import { ProviderRegistryScheduler } from './services/providers/providerRegistryScheduler.js'
import { ProviderVerificationScheduler } from './services/providers/providerVerificationScheduler.js'
import { handleProviderRegistryRequest } from './services/providers/providerRegistryEndpoint.js'
import { handlePhalaInstanceTypesRequest } from './services/providers/phalaInstanceTypesEndpoint.js'
import { reconcileActivePolicyExpirySchedules } from './services/policy/runtimeScheduler.js'
import { ShellEndpoint } from './services/shell/shellEndpoint.js'
import { createLogger } from './lib/logger.js'
import { requestContext, getRequestId } from './lib/requestContext.js'

const log = createLogger('server')

// Initialize Infisical (or dotenv fallback) before anything else
await initInfisical()

const prisma = new PrismaClient()

// Initialize billing schedulers
const storageSnapshotScheduler = new StorageSnapshotScheduler(prisma)
const invoiceScheduler = new InvoiceScheduler(prisma)
const usageAggregator = new UsageAggregator(prisma)
const computeBillingScheduler = new ComputeBillingScheduler(prisma)
const escrowHealthMonitor = new EscrowHealthMonitor(prisma)
const providerRegistryScheduler = new ProviderRegistryScheduler(prisma)
const providerVerificationScheduler = new ProviderVerificationScheduler(prisma)
const telemetryIngestionService = getTelemetryIngestionService(prisma)
const jwtSecret = process.env.JWT_SECRET
if (!jwtSecret) {
  if (process.env.NODE_ENV === 'production') {
    log.fatal('JWT_SECRET is not set — refusing to start in production without a proper secret')
    process.exit(1)
  }
  log.warn('JWT_SECRET not set — using insecure development default')
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

const gqlLog = createLogger('graphql')

const useLogging = (): Plugin => {
  return {
    onExecute({ args }) {
      const operationName = args.operationName || 'anonymous'
      const query = args.document?.loc?.source?.body?.substring(0, 300) || 'unknown'
      gqlLog.info({ operationName, query }, 'executing operation')
    },
    onResultProcess({ result }) {
      if ('errors' in result && result.errors) {
        gqlLog.error({ errors: result.errors }, 'operation returned errors')
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
    origin: process.env.APP_URL || (process.env.NODE_ENV === 'production'
      ? 'https://alternatefutures.ai'
      : 'http://localhost:3000'),
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
      connectSrc: ["'self'", process.env.APP_URL || (process.env.NODE_ENV === 'production' ? 'https://alternatefutures.ai' : 'http://localhost:3000')],
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

async function requestHandler(req: IncomingMessage, res: ServerResponse) {
  const requestId = getRequestId(req)
  res.setHeader('x-request-id', requestId)

  return requestContext.run({ requestId }, async () => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)

    // Subdomain proxy runs FIRST, before helmet/yoga
    const proxied = await subdomainProxy.handleRequest(req, res)
    if (proxied) return

    log.info({ method: req.method, path: url.pathname }, 'incoming request')

    await new Promise<void>(resolve => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      helmetMiddleware(req as any, res as any, resolve as any)
    })

    if (url.pathname === '/webhooks/stripe') {
      await handleStripeWebhook(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/telemetry/ingestion-webhook') {
      await handleTelemetryWebhook(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/telemetry/stats') {
      await handleTelemetryStats(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/compute/check-resume' && req.method === 'POST') {
      await handleComputeResumeCheck(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/compute/suspend-org' && req.method === 'POST') {
      await handleSuspendOrg(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/test/mock-deployment' && req.method === 'POST') {
      await handleMockDeployment(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/test/cleanup' && req.method === 'POST') {
      await handleMockCleanup(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/provider-registry' && req.method === 'GET') {
      await handleProviderRegistryRequest(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/phala-instance-types' && req.method === 'GET') {
      await handlePhalaInstanceTypesRequest(req, res)
      return
    }

    if (url.pathname === '/internal/proxy/flush-cache' && req.method === 'POST') {
      const expectedToken = process.env.INTERNAL_AUTH_TOKEN
      const authToken = req.headers['x-internal-auth']
      if (!expectedToken || authToken !== expectedToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Unauthorized' }))
        return
      }
      subdomainProxy.flushCache()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }

    if (url.pathname === '/queue/akash/step' && req.method === 'POST') {
      await handleAkashWebhook(req, res)
      return
    }
    if (url.pathname === '/queue/phala/step' && req.method === 'POST') {
      await handlePhalaWebhook(req, res)
      return
    }
    if (url.pathname === '/queue/policy/expire' && req.method === 'POST') {
      await handlePolicyWebhook(req, res)
      return
    }

    return yoga(req, res)
  })
}

const server = createServer(requestHandler)

// Initialize Chat WebSocket Server
const chatServer = new ChatServer(prisma, effectiveJwtSecret)

// Initialize Shell WebSocket Server
const shellEndpoint = new ShellEndpoint(prisma, effectiveJwtSecret)

// Handle WebSocket upgrade for /ws path and proxied subdomains
server.on('upgrade', async (request, socket, head) => {
  // Check if this is a proxied subdomain WebSocket upgrade
  const wsProxied = await subdomainProxy.handleUpgrade(request, socket, head)
  if (wsProxied) return

  const { pathname } = new URL(
    request.url || '/',
    `http://${request.headers.host}`
  )

  if (pathname === '/ws/shell') {
    shellEndpoint.handleUpgrade(request, socket, head)
  } else if (pathname === '/ws') {
    chatServer.handleUpgrade(request, socket, head)
  } else {
    socket.destroy()
  }
})

const port = process.env.PORT || 1602

server.listen(port, () => {
  log.info({ port, graphql: `/graphql`, ws: `/ws` }, 'server started')

  storageSnapshotScheduler.start()
  invoiceScheduler.start()
  usageAggregator.start()
  computeBillingScheduler.start()
  escrowHealthMonitor.start()
  providerRegistryScheduler.start()
  providerVerificationScheduler.start()
  telemetryIngestionService.start()
  log.info('billing + provider registry + verification schedulers started')

  startSslRenewalJob()
  log.info('SSL renewal job started')

  registerProvider(createAkashProvider(prisma))
  registerProvider(createPhalaProvider(prisma))
  log.info('deployment providers registered')

  initQueueHandler(prisma)
  log.info('QStash queue handler initialized')
  reconcileActivePolicyExpirySchedules(prisma).catch(err => {
    log.error({ err }, 'Failed to reconcile policy expiry schedules on startup')
  })

  const orchestrator = new AkashOrchestrator(prisma)
  orchestrator.resumeDeployingDeployments()
  orchestrator.resumePendingBackfills()

  startStaleDeploymentSweeper(prisma)
})

async function gracefulShutdown(signal: string) {
  log.info({ signal }, 'shutting down')
  storageSnapshotScheduler.stop()
  invoiceScheduler.stop()
  computeBillingScheduler.stop()
  escrowHealthMonitor.stop()
  providerRegistryScheduler.stop()
  providerVerificationScheduler.stop()

  const forceExitTimeout = setTimeout(() => {
    log.warn('Graceful shutdown timed out after 15s — forcing exit')
    process.exit(1)
  }, 15_000)
  forceExitTimeout.unref()

  // Wait for in-flight sweep before closing connections
  await stopStaleDeploymentSweeper()

  server.close(async () => {
    try {
      shellEndpoint.shutdown()
      await chatServer.shutdown()
      await usageAggregator.shutdown()
      await telemetryIngestionService.stop()
      await prisma.$disconnect()
    } catch (err) {
      log.error(err, 'Error during shutdown cleanup')
    }
    clearTimeout(forceExitTimeout)
    process.exit(0)
  })
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('\nSIGINT'))
