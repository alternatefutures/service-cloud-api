/**
 * WebSocket Shell Endpoint
 *
 * Provides interactive shell access to running deployments via WebSocket.
 * Auth is handled via the first message (no tokens in URL).
 *
 * Protocol:
 *   1. Client connects to /ws/shell?serviceId=<id>
 *   2. Client sends: { type: "auth", token: "<jwt-or-pat>" }
 *   3. Server validates, spawns shell, sends: { type: "ready" }
 *   4. Bidirectional binary data piping (stdin/stdout)
 *   5. Control messages: { type: "resize", cols: N, rows: N }
 *
 * Security:
 *   - 15-minute idle timeout per session
 *   - Max 3 concurrent sessions per user
 *   - Audit logging of session lifecycle (no content logging)
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'http'
import type { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { getProvider } from '../providers/registry.js'
import type { ShellSession } from '../providers/types.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('shell-endpoint')

const IDLE_TIMEOUT_MS = 15 * 60 * 1000
const MAX_SESSIONS_PER_USER = 3
const AUTH_TIMEOUT_MS = 10_000

const activeSessions = new Map<string, Set<WebSocket>>()

function getSessionCount(userId: string): number {
  return activeSessions.get(userId)?.size ?? 0
}

function trackSession(userId: string, ws: WebSocket): void {
  let sessions = activeSessions.get(userId)
  if (!sessions) {
    sessions = new Set()
    activeSessions.set(userId, sessions)
  }
  sessions.add(ws)
}

function untrackSession(userId: string, ws: WebSocket): void {
  const sessions = activeSessions.get(userId)
  if (sessions) {
    sessions.delete(ws)
    if (sessions.size === 0) activeSessions.delete(userId)
  }
}

interface AuthResult {
  userId: string
  organizationId?: string
}

async function validateToken(
  token: string,
  jwtSecret: string,
  prisma: PrismaClient
): Promise<AuthResult | null> {
  // Try JWT (auth-service access token)
  try {
    const payload = jwt.verify(token, jwtSecret, {
      issuer: 'alternatefutures-auth',
      audience: 'alternatefutures-app',
    }) as { userId: string; type: string }

    if (payload.type === 'access' && payload.userId) {
      return { userId: payload.userId }
    }
  } catch {
    // Not a valid auth access JWT — try other methods
  }

  // Try SDK access token (JWT without issuer/audience)
  try {
    const payload = jwt.verify(token, jwtSecret) as {
      userId: string
      type: string
    }
    if (payload.type === 'sdk-access' && payload.userId) {
      return { userId: payload.userId }
    }
  } catch {
    // Not a valid SDK JWT
  }

  // Fall back to PAT validation via auth service
  const authServiceUrl = process.env.AUTH_SERVICE_URL
  const introspectionSecret = process.env.AUTH_INTROSPECTION_SECRET
  if (!authServiceUrl) return null

  try {
    const res = await fetch(`${authServiceUrl}/tokens/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(introspectionSecret
          ? { 'x-af-introspection-secret': introspectionSecret }
          : {}),
      },
      body: JSON.stringify({ token }),
    })

    if (!res.ok) return null
    const data = (await res.json()) as {
      valid: boolean
      userId?: string
      organizationId?: string
    }
    if (!data.valid || !data.userId) return null
    return { userId: data.userId, organizationId: data.organizationId }
  } catch (err) {
    log.warn({ err }, 'PAT validation failed')
    return null
  }
}

function sendJson(ws: WebSocket, data: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data))
  }
}

export class ShellEndpoint {
  private wss: WebSocketServer
  private prisma: PrismaClient
  private jwtSecret: string

  constructor(prisma: PrismaClient, jwtSecret: string) {
    this.prisma = prisma
    this.jwtSecret = jwtSecret
    this.wss = new WebSocketServer({ noServer: true })

    this.wss.on('connection', (ws, request) => {
      this.handleConnection(ws, request)
    })
  }

  handleUpgrade(request: IncomingMessage, socket: any, head: Buffer): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request)
    })
  }

  private handleConnection(ws: WebSocket, request: IncomingMessage): void {
    const url = new URL(request.url || '/', `http://${request.headers.host}`)
    const serviceId = url.searchParams.get('serviceId')

    if (!serviceId) {
      sendJson(ws, { type: 'error', message: 'Missing serviceId query parameter' })
      ws.close(1008, 'Missing serviceId')
      return
    }

    let authenticated = false
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        sendJson(ws, { type: 'error', message: 'Authentication timeout' })
        ws.close(1008, 'Auth timeout')
      }
    }, AUTH_TIMEOUT_MS)

    ws.on('message', async (data) => {
      if (authenticated) return

      clearTimeout(authTimer)

      try {
        const message = JSON.parse(data.toString())
        if (message.type !== 'auth' || !message.token) {
          sendJson(ws, { type: 'error', message: 'First message must be { type: "auth", token: "..." }' })
          ws.close(1008, 'Bad auth message')
          return
        }

        const auth = await validateToken(message.token, this.jwtSecret, this.prisma)
        if (!auth) {
          sendJson(ws, { type: 'error', message: 'Authentication failed' })
          ws.close(1008, 'Auth failed')
          return
        }

        if (getSessionCount(auth.userId) >= MAX_SESSIONS_PER_USER) {
          sendJson(ws, {
            type: 'error',
            message: `Maximum ${MAX_SESSIONS_PER_USER} concurrent shell sessions reached. Close an existing session first.`,
          })
          ws.close(1008, 'Session limit')
          return
        }

        await this.startShellSession(ws, auth.userId, serviceId, auth.organizationId)
        authenticated = true
      } catch (err) {
        log.error({ err }, 'Shell auth error')
        sendJson(ws, { type: 'error', message: 'Authentication error' })
        ws.close(1011, 'Auth error')
      }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
    })
  }

  private async startShellSession(
    ws: WebSocket,
    userId: string,
    serviceId: string,
    organizationId?: string
  ): Promise<void> {
    const startTime = Date.now()

    // Validate service ownership
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { select: { userId: true, organizationId: true } } },
    })

    if (!service) {
      sendJson(ws, { type: 'error', message: 'Service not found' })
      ws.close(1008, 'Service not found')
      return
    }

    const project = (service as any).project
    if (project) {
      const authorized = organizationId
        ? project.organizationId === organizationId ||
          (project.userId === userId && project.organizationId === null)
        : project.userId === userId
      if (!authorized) {
        sendJson(ws, { type: 'error', message: 'Not authorized to access this service' })
        ws.close(1008, 'Unauthorized')
        return
      }
    }

    // Resolve active deployment and its provider type
    const deploymentServiceId = service.parentServiceId || serviceId

    const akashDep = await this.prisma.akashDeployment.findFirst({
      where: { serviceId: deploymentServiceId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    })

    const phalaDep = !akashDep
      ? await this.prisma.phalaDeployment.findFirst({
          where: { serviceId: deploymentServiceId, status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
        })
      : null

    const deployment = akashDep || phalaDep
    const providerName = akashDep ? 'akash' : phalaDep ? 'phala' : null

    if (!deployment || !providerName) {
      sendJson(ws, { type: 'error', message: 'No active deployment found for this service' })
      ws.close(1008, 'No deployment')
      return
    }

    const provider = getProvider(providerName)
    const capabilities = provider.getCapabilities()

    if (!capabilities.supportsShell || !provider.getShell) {
      sendJson(ws, {
        type: 'error',
        message: `Shell access is not supported for ${provider.displayName} deployments yet.`,
      })
      ws.close(1008, 'Shell not supported')
      return
    }

    let session: ShellSession
    try {
      session = await provider.getShell(deployment.id, {
        service: service.sdlServiceName ?? undefined,
      })
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 200) ?? 'unknown error'
      log.error({ err, serviceId, deploymentId: deployment.id }, 'Failed to spawn shell')
      sendJson(ws, { type: 'error', message: `Failed to open shell: ${msg}` })
      ws.close(1011, 'Shell spawn failed')
      return
    }

    trackSession(userId, ws)
    log.info(
      { userId, serviceId, providerType: providerName, deploymentId: deployment.id },
      'SHELL_OPEN'
    )

    // Start in home directory with a clean screen
    session.write('cd ~ 2>/dev/null; clear\r')

    sendJson(ws, { type: 'ready' })

    // Idle timeout management
    let idleTimer = setTimeout(() => {
      cleanup('idle_timeout')
    }, IDLE_TIMEOUT_MS)

    const resetIdle = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => cleanup('idle_timeout'), IDLE_TIMEOUT_MS)
    }

    let cleanedUp = false
    const cleanup = (reason: string) => {
      if (cleanedUp) return
      cleanedUp = true
      clearTimeout(idleTimer)
      session.kill()
      untrackSession(userId, ws)
      const durationSec = Math.round((Date.now() - startTime) / 1000)
      log.info(
        { userId, serviceId, providerType: providerName, reason, duration: durationSec },
        'SHELL_CLOSE'
      )
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, reason)
      }
    }

    // Pipe shell stdout → WebSocket
    session.onData((chunk) => {
      resetIdle()
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(chunk)
      }
    })

    session.onExit((code) => {
      cleanup(`process_exit(${code})`)
    })

    // Replace the message handler: now pipe WebSocket → shell stdin
    ws.removeAllListeners('message')
    ws.on('message', (data, isBinary) => {
      resetIdle()

      // Check for JSON control messages (resize)
      if (!isBinary && data.toString().startsWith('{')) {
        try {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'resize' && session.resize) {
            session.resize(msg.cols, msg.rows)
            return
          }
        } catch {
          // Not valid JSON — treat as regular stdin data
        }
      }

      session.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
    })

    ws.on('close', () => {
      cleanup('user_disconnect')
    })

    ws.on('error', (err) => {
      log.warn({ err, userId, serviceId }, 'Shell WebSocket error')
      cleanup('ws_error')
    })
  }

  shutdown(): void {
    for (const [userId, sessions] of activeSessions) {
      for (const ws of sessions) {
        sendJson(ws, { type: 'error', message: 'Server shutting down' })
        ws.close(1001, 'Server shutdown')
      }
      sessions.clear()
    }
    activeSessions.clear()
    this.wss.close()
  }
}
