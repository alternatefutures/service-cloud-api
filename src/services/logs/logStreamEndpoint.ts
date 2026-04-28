/**
 * Server-Sent Events (SSE) Log Streaming Endpoint
 *
 * Phase 41 — Live log streaming. Replaces the 3s-poll fallback with a
 * push-based stream so the Logs tab updates within ~1s of new output.
 *
 * Path: GET /sse/services/:id/logs?token=<jwt-or-pat>[&service=<name>][&tail=<n>]
 *
 * Auth: token is taken from the query string because EventSource
 * cannot set custom headers. The caller is responsible for treating
 * its access token as URL-bound (do not log query strings on the
 * gateway). The same validateToken pipeline that backs WebSocket
 * shell access is used here.
 *
 * Wire protocol (text/event-stream):
 *   event: ready                             — connection established, stream starting
 *   data: {"deploymentId":"<id>","provider":"akash"}
 *
 *   data: <log-line>                         — one event per line of provider output
 *
 *   event: error                             — transient or fatal stream error
 *   data: {"message":"..."}
 *
 *   event: close                             — provider stream ended (container exited)
 *   data: {"code":<exit-code>}
 *
 *   : keepalive                              — comment frame every 15s to defeat proxy idle timeouts
 *
 * Resource limits:
 *   - MAX_STREAMS_PER_USER = 5 concurrent CLI subprocesses
 *   - IDLE_TIMEOUT_MS = 30 minutes from last delivered byte (counted client→client)
 *   - HARD_TIMEOUT_MS = 4 hours absolute (defence against zombie sessions)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { authorizeServiceAccess } from '../auth/serviceAccess.js'
import { getProvider } from '../providers/registry.js'
import type { LogStream } from '../providers/types.js'
import { audit } from '../../lib/audit.js'
import { createLogger } from '../../lib/logger.js'

/**
 * All first-party AF service origins that are permitted to open SSE
 * log streams.  APP_URL (single override) and CORS_ALLOWED_ORIGINS
 * (comma-separated list) can extend the set at deploy time without
 * touching this file.
 */
const BASE_ORIGINS = [
  'https://app.alternatefutures.ai',
  'https://api.alternatefutures.ai',
  'https://auth.alternatefutures.ai',
  'https://docs.alternatefutures.ai',
  'https://alternatefutures.ai',
]

export function getAllowedOrigins(): string[] {
  const origins = new Set<string>(BASE_ORIGINS)

  // Single-origin override (legacy / local dev convenience)
  const appUrl = process.env.APP_URL
  if (appUrl) origins.add(appUrl)

  // Comma-separated extra allowlist (e.g. staging URLs)
  const extra = process.env.CORS_ALLOWED_ORIGINS
  if (extra) {
    for (const o of extra.split(',')) {
      const trimmed = o.trim()
      if (trimmed) origins.add(trimmed)
    }
  }

  return Array.from(origins)
}

/**
 * Returns CORS headers to include in SSE and error responses.
 * Echoes the request Origin only when it matches the allowlist so we never
 * reflect an arbitrary third-party origin.  Returns an empty object for
 * non-browser (no Origin header) or disallowed requests.
 */
export function getCorsHeaders(req: IncomingMessage): Record<string, string> {
  const requestOrigin = req.headers['origin'] as string | undefined
  if (!requestOrigin) return {}
  if (!getAllowedOrigins().includes(requestOrigin)) return {}
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

const log = createLogger('log-stream-endpoint')

const MAX_STREAMS_PER_USER = 5
const HEARTBEAT_INTERVAL_MS = 15_000
const IDLE_TIMEOUT_MS = 30 * 60 * 1000
const HARD_TIMEOUT_MS = 4 * 60 * 60 * 1000

const activeStreams = new Map<string, Set<ServerResponse>>()

function trackStream(userId: string, res: ServerResponse): void {
  let set = activeStreams.get(userId)
  if (!set) {
    set = new Set()
    activeStreams.set(userId, set)
  }
  set.add(res)
}

function untrackStream(userId: string, res: ServerResponse): void {
  const set = activeStreams.get(userId)
  if (!set) return
  set.delete(res)
  if (set.size === 0) activeStreams.delete(userId)
}

function streamCount(userId: string): number {
  return activeStreams.get(userId)?.size ?? 0
}

function writeSse(
  res: ServerResponse,
  event: string | null,
  data: string
): boolean {
  if (res.writableEnded) return false
  let frame = ''
  if (event) frame += `event: ${event}\n`
  // SSE requires every line of `data` to be its own `data:` field.
  for (const line of data.split('\n')) {
    frame += `data: ${line}\n`
  }
  frame += '\n'
  return res.write(frame)
}

function writeComment(res: ServerResponse, text: string): void {
  if (res.writableEnded) return
  res.write(`: ${text}\n\n`)
}

function endError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string
): void {
  if (res.headersSent) {
    writeSse(res, 'error', JSON.stringify({ message }))
    res.end()
    return
  }
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...getCorsHeaders(req),
  })
  res.end(JSON.stringify({ error: message }))
}

const AKASH_LOG_ELIGIBLE_STATUSES = [
  'ACTIVE',
  'DEPLOYING',
  'SENDING_MANIFEST',
  'CREATING_LEASE',
  'FAILED',
  'SUSPENDED',
  'PERMANENTLY_FAILED',
] as const

const PHALA_LOG_ELIGIBLE_STATUSES = [
  'ACTIVE',
  'STARTING',
  'FAILED',
  'PERMANENTLY_FAILED',
] as const

async function pickLogEligibleDeployment(
  prisma: PrismaClient,
  serviceId: string
): Promise<{ deploymentId: string; provider: 'akash' | 'phala' } | null> {
  // Pass 1: prefer ACTIVE deployments (tiebreaker — healthy beats stale/failed)
  const akashActive = await prisma.akashDeployment.findFirst({
    where: { serviceId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (akashActive) return { deploymentId: akashActive.id, provider: 'akash' }

  const phalaActive = await prisma.phalaDeployment.findFirst({
    where: { serviceId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (phalaActive) return { deploymentId: phalaActive.id, provider: 'phala' }

  // Pass 2: fall back to any log-eligible deployment (has a lease, can be tailed)
  const akash = await prisma.akashDeployment.findFirst({
    where: {
      serviceId,
      status: { in: AKASH_LOG_ELIGIBLE_STATUSES as unknown as string[] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (akash) return { deploymentId: akash.id, provider: 'akash' }

  const phala = await prisma.phalaDeployment.findFirst({
    where: {
      serviceId,
      status: { in: PHALA_LOG_ELIGIBLE_STATUSES as unknown as string[] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (phala) return { deploymentId: phala.id, provider: 'phala' }

  return null
}

/**
 * Test-only injection seam. Replacing these lets us drive the SSE endpoint
 * with a fake provider + fake authorizer without touching the real registry,
 * Prisma, or the auth service. NEVER call from production code.
 */
export interface LogStreamEndpointDeps {
  authorize?: typeof authorizeServiceAccess
  resolveProvider?: typeof getProvider
  emitAudit?: typeof audit
}

export class LogStreamEndpoint {
  private prisma: PrismaClient
  private jwtSecret: string
  private deps: Required<LogStreamEndpointDeps>

  constructor(
    prisma: PrismaClient,
    jwtSecret: string,
    deps: LogStreamEndpointDeps = {}
  ) {
    this.prisma = prisma
    this.jwtSecret = jwtSecret
    this.deps = {
      authorize: deps.authorize ?? authorizeServiceAccess,
      resolveProvider: deps.resolveProvider ?? getProvider,
      emitAudit: deps.emitAudit ?? audit,
    }
  }

  /**
   * Match `/sse/services/<serviceId>/logs`. Returns the serviceId or null.
   */
  static matchPath(pathname: string): string | null {
    const m = /^\/sse\/services\/([A-Za-z0-9_-]+)\/logs\/?$/.exec(pathname)
    return m ? m[1] : null
  }

  async handle(
    req: IncomingMessage,
    res: ServerResponse,
    serviceId: string
  ): Promise<void> {
    if (req.method !== 'GET') {
      endError(req, res, 405, 'Method not allowed')
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    const sdlServiceOverride = url.searchParams.get('service') || undefined
    const tailParam = url.searchParams.get('tail')
    const tail = tailParam
      ? Math.max(0, Math.min(2000, Number(tailParam) || 0))
      : 50

    if (!token) {
      endError(req, res, 401, 'Missing token query parameter')
      return
    }

    const access = await this.deps.authorize(
      this.prisma,
      serviceId,
      token,
      this.jwtSecret
    )
    if (!access.ok) {
      const code =
        access.status === 'unauthorized'
          ? 401
          : access.status === 'forbidden'
            ? 403
            : access.status === 'not_found'
              ? 404
              : 400
      endError(req, res, code, access.message)
      return
    }

    if (streamCount(access.userId) >= MAX_STREAMS_PER_USER) {
      endError(
        req,
        res,
        429,
        `Maximum ${MAX_STREAMS_PER_USER} concurrent log streams reached`
      )
      return
    }

    // Companion services share their parent's deployment; logs are filtered
    // server-side by SDL service name (matches the existing serviceLogs query).
    const deploymentServiceId = access.service.parentServiceId || serviceId
    const logServiceFilter =
      sdlServiceOverride || access.service.sdlServiceName || undefined

    const target = await pickLogEligibleDeployment(this.prisma, deploymentServiceId)
    if (!target) {
      endError(req, res, 404, 'No log-eligible deployment found for this service')
      return
    }

    const provider = this.deps.resolveProvider(target.provider)
    const capabilities = provider.getCapabilities()
    if (!capabilities.supportsLogStreaming || !provider.streamLogs) {
      endError(
        req,
        res,
        501,
        `Live log streaming is not supported for ${provider.displayName} deployments yet`
      )
      return
    }

    // Open the SSE response. From here on, errors must be reported through
    // the SSE channel, not as HTTP error responses.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Defeat nginx response buffering — without this, lines arrive in
      // bursts every few seconds even though we flushed them immediately.
      'X-Accel-Buffering': 'no',
      ...getCorsHeaders(req),
    })
    res.flushHeaders?.()

    const startTime = Date.now()
    let lastDeliveredAt = Date.now()
    let cleanedUp = false
    let stream: LogStream | null = null
    trackStream(access.userId, res)

    const heartbeat = setInterval(() => {
      if (cleanedUp) return
      writeComment(res, 'keepalive')
    }, HEARTBEAT_INTERVAL_MS)

    const idleTimer = setInterval(() => {
      if (cleanedUp) return
      const idleFor = Date.now() - lastDeliveredAt
      if (idleFor >= IDLE_TIMEOUT_MS) {
        cleanup('idle_timeout')
      }
    }, 60_000)

    const hardTimer = setTimeout(() => {
      cleanup('hard_timeout')
    }, HARD_TIMEOUT_MS)

    const cleanup = (reason: string): void => {
      if (cleanedUp) return
      cleanedUp = true
      clearInterval(heartbeat)
      clearInterval(idleTimer)
      clearTimeout(hardTimer)
      try {
        stream?.close()
      } catch (e) {
        log.warn(
          { err: e, userId: access.userId, serviceId },
          'stream.close() threw'
        )
      }
      untrackStream(access.userId, res)
      const durationSec = Math.round((Date.now() - startTime) / 1000)
      log.info(
        {
          userId: access.userId,
          serviceId,
          providerType: target.provider,
          reason,
          duration: durationSec,
        },
        'LOG_STREAM_CLOSE'
      )
      this.deps.emitAudit(this.prisma, {
        category: 'logs',
        action: 'log-stream.close',
        status: reason.startsWith('error') ? 'error' : 'ok',
        userId: access.userId,
        orgId: access.organizationId ?? undefined,
        serviceId,
        deploymentId: target.deploymentId,
        durationMs: Date.now() - startTime,
        payload: { reason, provider: target.provider },
      })
      try {
        res.end()
      } catch {
        /* swallow */
      }
    }

    req.once('close', () => cleanup('client_disconnect'))
    req.once('error', () => cleanup('request_error'))
    res.once('error', err => {
      log.warn({ err, userId: access.userId, serviceId }, 'SSE response error')
      cleanup('response_error')
    })

    try {
      stream = await provider.streamLogs(target.deploymentId, {
        service: logServiceFilter,
        tail,
      })
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 300) ?? 'unknown error'
      log.error(
        {
          err,
          userId: access.userId,
          serviceId,
          deploymentId: target.deploymentId,
        },
        'streamLogs() failed'
      )
      writeSse(
        res,
        'error',
        JSON.stringify({ message: `Failed to open log stream: ${msg}` })
      )
      cleanup('stream_open_failed')
      return
    }

    // Connection accepted — let the client know what they're tailing.
    writeSse(
      res,
      'ready',
      JSON.stringify({
        deploymentId: target.deploymentId,
        provider: target.provider,
      })
    )

    log.info(
      {
        userId: access.userId,
        serviceId,
        providerType: target.provider,
        deploymentId: target.deploymentId,
      },
      'LOG_STREAM_OPEN'
    )
    this.deps.emitAudit(this.prisma, {
      category: 'logs',
      action: 'log-stream.open',
      status: 'ok',
      userId: access.userId,
      orgId: access.organizationId ?? undefined,
      serviceId,
      deploymentId: target.deploymentId,
      payload: {
        provider: target.provider,
        sdlServiceName: logServiceFilter ?? null,
        tail,
      },
    })

    stream.onLine(line => {
      if (cleanedUp) return
      lastDeliveredAt = Date.now()
      writeSse(res, null, line)
    })

    stream.onError(err => {
      if (cleanedUp) return
      writeSse(
        res,
        'error',
        JSON.stringify({
          message: err.message?.slice(0, 300) ?? 'stream error',
        })
      )
    })

    stream.onClose(code => {
      if (cleanedUp) return
      writeSse(res, 'close', JSON.stringify({ code }))
      cleanup(`provider_exit(${code})`)
    })
  }

  /**
   * Server shutdown: politely terminate every open stream so we don't leave
   * orphaned `provider-services lease-logs` children around.
   */
  shutdown(): void {
    for (const [userId, set] of activeStreams) {
      for (const res of set) {
        try {
          writeSse(
            res,
            'error',
            JSON.stringify({ message: 'Server shutting down' })
          )
          res.end()
        } catch (err) {
          log.warn({ err, userId }, 'Failed to close stream during shutdown')
        }
      }
      set.clear()
    }
    activeStreams.clear()
  }
}
