/**
 * Shared per-service connection auth used by long-lived endpoints
 * (WebSocket shell, SSE log streaming).
 *
 * The graphql ingress already does this through the apollo context, but
 * shell/SSE bypass apollo and need to validate tokens themselves. We
 * centralise the rules here so the shell endpoint and the log-stream
 * endpoint can never drift apart.
 */

import type { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('service-access')

export interface AuthResult {
  userId: string
  organizationId?: string
}

export interface ServiceAccessSuccess {
  ok: true
  serviceId: string
  userId: string
  organizationId?: string
  service: {
    id: string
    parentServiceId: string | null
    sdlServiceName: string | null
    project: { userId: string; organizationId: string | null }
  }
}

export interface ServiceAccessFailure {
  ok: false
  status: 'unauthorized' | 'forbidden' | 'not_found' | 'invalid'
  message: string
}

export type ServiceAccessResult = ServiceAccessSuccess | ServiceAccessFailure

/**
 * Validate a Bearer token from any source: auth-service access JWT, SDK
 * token JWT, or PAT (introspected via the auth service). Returns null if
 * the token is unrecognised or expired. Never throws.
 */
export async function validateBearerToken(
  token: string,
  jwtSecret: string,
  _prisma: PrismaClient,
): Promise<AuthResult | null> {
  // 1. Auth-service access JWT (issuer + audience claims)
  try {
    const payload = jwt.verify(token, jwtSecret, {
      issuer: 'alternatefutures-auth',
      audience: 'alternatefutures-app',
    }) as { userId: string; type: string }
    if (payload.type === 'access' && payload.userId) {
      return { userId: payload.userId }
    }
  } catch {
    /* fall through */
  }

  // 2. SDK access JWT (no issuer/audience)
  try {
    const payload = jwt.verify(token, jwtSecret) as {
      userId: string
      type: string
    }
    if (payload.type === 'sdk-access' && payload.userId) {
      return { userId: payload.userId }
    }
  } catch {
    /* fall through */
  }

  // 3. PAT — introspect via auth service
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
    log.warn({ err }, 'PAT introspection failed')
    return null
  }
}

/**
 * Resolve a serviceId + token pair, performing identical authorization
 * checks to the GraphQL `assertProjectAccess` helper. Returns the matched
 * service record on success so callers don't have to re-fetch it.
 */
export async function authorizeServiceAccess(
  prisma: PrismaClient,
  serviceId: string,
  token: string,
  jwtSecret: string,
): Promise<ServiceAccessResult> {
  const auth = await validateBearerToken(token, jwtSecret, prisma)
  if (!auth) {
    return { ok: false, status: 'unauthorized', message: 'Authentication failed' }
  }

  const service = await prisma.service.findUnique({
    where: { id: serviceId },
    select: {
      id: true,
      parentServiceId: true,
      sdlServiceName: true,
      project: { select: { userId: true, organizationId: true } },
    },
  })

  if (!service) {
    return { ok: false, status: 'not_found', message: 'Service not found' }
  }
  if (!service.project) {
    return { ok: false, status: 'invalid', message: 'Service has no associated project' }
  }

  // PAT with org claim: verify membership server-side so a stale PAT can't
  // grant access to an org the user has been removed from.
  if (auth.organizationId) {
    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: auth.organizationId,
          userId: auth.userId,
        },
      },
    })
    if (!membership) {
      return {
        ok: false,
        status: 'forbidden',
        message: 'Not a member of the claimed organization',
      }
    }
  }

  const authorized = auth.organizationId
    ? service.project.organizationId === auth.organizationId
      || (service.project.userId === auth.userId && service.project.organizationId === null)
    : service.project.userId === auth.userId

  if (!authorized) {
    return {
      ok: false,
      status: 'forbidden',
      message: 'Not authorized to access this service',
    }
  }

  return {
    ok: true,
    serviceId: service.id,
    userId: auth.userId,
    organizationId: auth.organizationId,
    service: {
      id: service.id,
      parentServiceId: service.parentServiceId,
      sdlServiceName: service.sdlServiceName,
      project: service.project,
    },
  }
}
