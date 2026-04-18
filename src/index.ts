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
import { NoSchemaIntrospectionCustomRule } from 'graphql/validation/index.js'
import helmet from 'helmet'
import { initInfisical } from './config/infisical.js'
import { SubdomainProxy } from './services/proxy/subdomainProxy.js'
import { AkashOrchestrator } from './services/akash/orchestrator.js'
import { startHealthPrewarmer } from './services/providers/akashProvider.js'
import { startApplicationHealthRunner, stopApplicationHealthRunner } from './services/health/applicationHealthRunner.js'
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
import { runWithLeadership, stopAllLeaderSchedulers } from './services/leader/leaderElection.js'
import { setWalletMutexPrisma } from './services/akash/walletMutex.js'
import { ProviderRegistryScheduler } from './services/providers/providerRegistryScheduler.js'
import { ProviderVerificationScheduler } from './services/providers/providerVerificationScheduler.js'
import { AuditExportScheduler } from './services/audit/auditExportScheduler.js'
import { handleProviderRegistryRequest } from './services/providers/providerRegistryEndpoint.js'
import { handleAdminDeploymentStats } from './services/admin/deploymentStatsEndpoint.js'
import { handleAdminBillingStats } from './services/admin/billingStatsEndpoint.js'
import { handleAdminAuditEvents } from './services/admin/auditEventsEndpoint.js'
import { handlePhalaInstanceTypesRequest } from './services/providers/phalaInstanceTypesEndpoint.js'
import { reconcileActivePolicyExpirySchedules } from './services/policy/runtimeScheduler.js'
import { ShellEndpoint } from './services/shell/shellEndpoint.js'
import { LogStreamEndpoint } from './services/logs/logStreamEndpoint.js'
import { createLogger } from './lib/logger.js'
import { requestContext, getRequestId, getTraceId } from './lib/requestContext.js'
import { useAuditPlugin } from './lib/auditPlugin.js'
import { getAuditWriteStats } from './lib/audit.js'

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
const auditExportScheduler = new AuditExportScheduler(prisma)
let healthPrewarmerInterval: ReturnType<typeof setInterval> | null = null
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

const IS_PRODUCTION = process.env.NODE_ENV === 'production'
// Allow staging/internal envs to keep introspection (e.g. for SDK codegen
// against staging) by setting GRAPHQL_FORCE_ENABLE_INTROSPECTION=true.
// In production, default is to *block* introspection to reduce schema
// fingerprinting and to keep the GraphiQL landing page off.
const ALLOW_INTROSPECTION =
  !IS_PRODUCTION || process.env.GRAPHQL_FORCE_ENABLE_INTROSPECTION === 'true'

// Custom plugin to add validation rules for depth, complexity, and (in prod)
// introspection blocking.
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
      if (!ALLOW_INTROSPECTION) {
        addValidationRule(NoSchemaIntrospectionCustomRule)
      }
    },
  }
}

const gqlLog = createLogger('graphql')

/**
 * Defensive redactor for the GraphQL query body before it lands in the log.
 *
 * Tokens / secrets should never appear in a query string (they belong in
 * HTTP headers or variables, neither of which we log) but a buggy client
 * could embed one as a string literal. We strip the patterns we know about
 * so a single misbehaving caller can't leak a credential to our log
 * pipeline.
 *
 * Patterns covered:
 *  - AlternateFutures personal access tokens: `af_live_…`, `af_test_…`
 *    (see service-auth/src/services/token.service.ts:129)
 *  - JWT shaped tokens: `eyJ…\.eyJ…\.[A-Za-z0-9_-]+`
 *  - Bearer tokens: `Bearer <opaque>`
 *  - Stripe-style keys: `(sk|pk|rk)_(live|test)_…`
 *  - OpenAI/Anthropic-style keys: `sk-[A-Za-z0-9_-]{20,}`
 */
const TOKEN_REDACTORS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /af_(live|test)_[A-Za-z0-9]{8,}/g, replacement: 'af_$1_<redacted>' },
  { pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replacement: '<jwt:redacted>' },
  { pattern: /Bearer\s+[A-Za-z0-9._\-]+/gi, replacement: 'Bearer <redacted>' },
  { pattern: /(?<![A-Za-z0-9])(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, replacement: '$1_$2_<redacted>' },
  { pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, replacement: 'sk-<redacted>' },
]

function redactQueryForLogging(input: string): string {
  let out = input
  for (const { pattern, replacement } of TOKEN_REDACTORS) {
    out = out.replace(pattern, replacement)
  }
  return out
}

const useLogging = (): Plugin => {
  return {
    onExecute({ args }) {
      const operationName = args.operationName || 'anonymous'
      const rawQuery = args.document?.loc?.source?.body?.substring(0, 300) || 'unknown'
      const query = redactQueryForLogging(rawQuery)
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
  // In production, hide the GraphiQL landing page so unauthenticated users
  // browsing /graphql see a plain HTTP error rather than a UI that hints at
  // schema shape / sample queries. Yoga still serves the JSON API.
  landingPage: !IS_PRODUCTION,
  graphiql: !IS_PRODUCTION,
  maskedErrors: IS_PRODUCTION,
  // Order matters here: useAuditPlugin runs after useLogging so that any
  // audit write that itself errors out is logged via the gql logger
  // pipeline (and surfaced in /health/audit counters) instead of being
  // silently swallowed.
  plugins: [useValidationRules(), useLogging(), useAuditPlugin(prisma)],
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
  const traceId = getTraceId(req)
  res.setHeader('x-request-id', requestId)
  res.setHeader('x-af-trace-id', traceId)

  return requestContext.run({ requestId, traceId }, async () => {
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

    if (url.pathname === '/internal/admin/deployment-stats' && req.method === 'GET') {
      await handleAdminDeploymentStats(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/admin/billing-stats' && req.method === 'GET') {
      await handleAdminBillingStats(req, res, prisma)
      return
    }

    if (url.pathname === '/internal/admin/audit-events' && req.method === 'GET') {
      await handleAdminAuditEvents(req, res, prisma)
      return
    }

    // Liveness probe for Docker HEALTHCHECK + K8s readiness/liveness
    // probes. Intentionally ultra-cheap: no DB call, no upstream check.
    // (Deeper readiness — DB + Redis — lives in /internal/audit/health
    // because that's the alarm a silent-audit failure would trip.)
    if (url.pathname === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', service: 'cloud-api' }))
      return
    }

    // Per-side audit-write counter. Compared against the service-auth
    // equivalent by an external alert: any side reporting attempted=0
    // for >30min during business hours = silent failure, page on-call.
    if (url.pathname === '/internal/audit/health' && req.method === 'GET') {
      const stats = getAuditWriteStats()
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ source: 'cloud-api', ...stats }))
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

    {
      const sseServiceId = LogStreamEndpoint.matchPath(url.pathname)
      if (sseServiceId && req.method === 'GET') {
        await logStreamEndpoint.handle(req, res, sseServiceId)
        return
      }
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

// Initialize SSE log streaming endpoint (Phase 41)
const logStreamEndpoint = new LogStreamEndpoint(prisma, effectiveJwtSecret)

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

server.listen(port, async () => {
  log.info({ port, graphql: `/graphql`, ws: `/ws` }, 'server started')

  // Hand the shared Prisma client to walletMutex so the cross-replica
  // pg_advisory_xact_lock has a connection to use. Must run before any
  // chain TX is fired.
  setWalletMutexPrisma(prisma)

  // Singleton schedulers run under a leader lease so REPLICAS > 1 is
  // safe. The Akash provider verifier and audit exporter are still
  // best-effort even if leadership flips between pods because both are
  // idempotent / cron-style.
  await runWithLeadership(prisma, 'storage-snapshot', {
    onAcquire: () => storageSnapshotScheduler.start(),
    onRelease: () => storageSnapshotScheduler.stop(),
  })
  await runWithLeadership(prisma, 'invoice-scheduler', {
    onAcquire: () => invoiceScheduler.start(),
    onRelease: () => invoiceScheduler.stop(),
  })
  await runWithLeadership(prisma, 'compute-billing-scheduler', {
    onAcquire: () => computeBillingScheduler.start(),
    onRelease: () => computeBillingScheduler.stop(),
  })
  await runWithLeadership(prisma, 'escrow-health-monitor', {
    onAcquire: () => escrowHealthMonitor.start(),
    onRelease: () => escrowHealthMonitor.stop(),
  })
  await runWithLeadership(prisma, 'provider-registry-scheduler', {
    onAcquire: () => providerRegistryScheduler.start(),
    onRelease: () => providerRegistryScheduler.stop(),
  })
  await runWithLeadership(prisma, 'audit-export-scheduler', {
    onAcquire: () => auditExportScheduler.start(),
    onRelease: () => auditExportScheduler.stop(),
  })
  await runWithLeadership(prisma, 'provider-verification-scheduler', {
    onAcquire: () => providerVerificationScheduler.start(),
    onRelease: () => providerVerificationScheduler.stop(),
  })

  // Per-pod work (no chain TXs / no row-mutating singletons): runs
  // unconditionally on every replica.
  usageAggregator.start()
  telemetryIngestionService.start()
  log.info('billing + provider registry + verification schedulers started (leader-gated)')

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

  // Stale sweeper writes terminal-state rows + drives close TXs, so
  // it MUST be a singleton across replicas.
  await runWithLeadership(prisma, 'stale-deployment-sweeper', {
    onAcquire: () => startStaleDeploymentSweeper(prisma),
    onRelease: () => stopStaleDeploymentSweeper(),
  })

  healthPrewarmerInterval = startHealthPrewarmer(prisma)
  startApplicationHealthRunner(prisma)
})

async function gracefulShutdown(signal: string) {
  log.info({ signal }, 'shutting down')
  // Releases every leader lease (so a standby pod takes over within
  // its next poll) AND calls each scheduler's stop hook.
  await stopAllLeaderSchedulers(prisma)
  if (healthPrewarmerInterval) clearInterval(healthPrewarmerInterval)
  stopApplicationHealthRunner()

  const forceExitTimeout = setTimeout(() => {
    log.warn('Graceful shutdown timed out after 15s — forcing exit')
    process.exit(1)
  }, 15_000)
  forceExitTimeout.unref()

  // Wait for in-flight sweep before closing connections (the sweeper's
  // own onRelease was already called by stopAllLeaderSchedulers).
  await stopStaleDeploymentSweeper()

  server.close(async () => {
    try {
      shellEndpoint.shutdown()
      logStreamEndpoint.shutdown()
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
