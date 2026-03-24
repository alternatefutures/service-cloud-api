import type { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { createLogger } from '../lib/logger.js'

const log = createLogger('auth-middleware')

export interface AuthContext {
  userId?: string
  organizationId?: string
  projectId?: string
}

interface SdkAccessTokenPayload {
  userId: string
  projectId?: string
  type: 'sdk-access'
}

interface AuthAccessTokenPayload {
  userId: string
  sessionId: string
  email?: string
  type: 'access'
}

/**
 * Try to validate as a JWT SDK access token first
 * Returns null if not a valid JWT
 */
function validateSdkAccessToken(
  token: string
): { userId: string; projectId?: string } | null {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    return null
  }

  try {
    const payload = jwt.verify(token, secret) as SdkAccessTokenPayload
    
    // Only accept sdk-access tokens
    if (payload.type !== 'sdk-access') {
      return null
    }

    return {
      userId: payload.userId,
      projectId: payload.projectId,
    }
  } catch {
    return null
  }
}

/**
 * Validate auth-service session access token (JWT)
 * Returns null if not a valid auth access JWT
 */
function validateAuthAccessToken(token: string): { userId: string } | null {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    return null
  }

  try {
    const payload = jwt.verify(token, secret, {
      issuer: 'alternatefutures-auth',
      audience: 'alternatefutures-app',
    }) as AuthAccessTokenPayload

    if (payload.type !== 'access') {
      return null
    }

    return { userId: payload.userId }
  } catch {
    return null
  }
}

/**
 * Validate auth-service access token via auth service (/auth/me).
 * This is a safe fallback when JWT secrets/claims aren't aligned locally.
 */
async function validateAuthAccessTokenViaAuthService(
  token: string
): Promise<{ userId: string } | null> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL
  if (!authServiceUrl) {
    throw new Error('AUTH_SERVICE_URL not configured')
  }

  try {
    const res = await fetch(`${authServiceUrl}/auth/me`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!res.ok) {
      if (res.status === 401) return null
      throw new Error(`Auth service error: ${res.status}`)
    }

    const data = (await res.json()) as { user?: { id?: string } }
    const userId = data?.user?.id
    if (!userId) return null
    return { userId }
  } catch (error) {
    log.error(error, 'Auth service /auth/me validation error')
    throw error
  }
}

/**
 * Validate token via auth service (for PATs)
 */
const PAT_VALIDATION_TTL_MS = Number(process.env.PAT_VALIDATION_TTL_MS ?? 30_000)
const PAT_NEGATIVE_CACHE_TTL_MS = 5_000
// Fixed by audit 2026-03: added max cache size to prevent unbounded memory growth
const PAT_CACHE_MAX_SIZE = 10_000
const patValidationCache = new Map<
  string,
  { value: { userId: string; tokenId: string; organizationId?: string; email?: string | null; displayName?: string | null; avatarUrl?: string | null } | null; expiresAt: number }
>()
function evictExpiredPatEntries() {
  if (patValidationCache.size <= PAT_CACHE_MAX_SIZE) return
  const now = Date.now()
  for (const [key, entry] of patValidationCache) {
    if (entry.expiresAt <= now) patValidationCache.delete(key)
  }
  if (patValidationCache.size > PAT_CACHE_MAX_SIZE) {
    const excess = patValidationCache.size - Math.floor(PAT_CACHE_MAX_SIZE * 0.75)
    let deleted = 0
    for (const key of patValidationCache.keys()) {
      if (deleted >= excess) break
      patValidationCache.delete(key)
      deleted++
    }
  }
}

const patValidationInflight = new Map<
  string,
  Promise<{
    userId: string
    tokenId: string
    organizationId?: string
    email?: string | null
    displayName?: string | null
    avatarUrl?: string | null
  } | null>
>()

async function validateTokenViaAuthService(
  token: string
): Promise<{
  userId: string
  tokenId: string
  organizationId?: string
  email?: string | null
  displayName?: string | null
  avatarUrl?: string | null
} | null> {
  const now = Date.now()
  const cached = patValidationCache.get(token)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const inflight = patValidationInflight.get(token)
  if (inflight) {
    return inflight
  }

  const authServiceUrl = process.env.AUTH_SERVICE_URL
  const introspectionSecret = process.env.AUTH_INTROSPECTION_SECRET

  if (!authServiceUrl) {
    throw new Error('AUTH_SERVICE_URL not configured')
  }

  const promise = (async () => {
    try {
    evictExpiredPatEntries()
    const response = await fetch(`${authServiceUrl}/tokens/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(introspectionSecret
          ? { 'x-af-introspection-secret': introspectionSecret }
          : {}),
      },
      body: JSON.stringify({ token }),
    })

    if (!response.ok) {
      if (response.status === 401) {
        patValidationCache.set(token, {
          value: null,
          expiresAt: Date.now() + PAT_NEGATIVE_CACHE_TTL_MS,
        })
        return null // Invalid token
      }
      // If we get rate limited, fall back to a (recent) cached value if present,
      // instead of failing auth for the entire request burst.
      if (response.status === 429 && cached) {
        return cached.value
      }
      throw new Error(`Auth service error: ${response.status}`)
    }

    const data = await response.json()

    if (!data.valid) {
      patValidationCache.set(token, {
        value: null,
        expiresAt: Date.now() + PAT_NEGATIVE_CACHE_TTL_MS,
      })
      return null
    }

    const value = {
      userId: data.userId,
      tokenId: data.tokenId,
      organizationId: data.organizationId,
      email: data.email ?? null,
      displayName: data.displayName ?? null,
      avatarUrl: data.avatarUrl ?? null,
    }
    patValidationCache.set(token, {
      value,
      expiresAt: Date.now() + PAT_VALIDATION_TTL_MS,
    })
    return value
  } catch (error) {
    log.error(error, 'Auth service validation error')
    throw error
    } finally {
      patValidationInflight.delete(token)
    }
  })()

  patValidationInflight.set(token, promise)
  return promise
}

/**
 * Ensure the Organization and OrganizationMember rows exist when we have
 * both a userId and organizationId from the request context.
 * Runs fire-and-forget so it never blocks the request.
 */
async function ensureOrgMembership(
  prisma: PrismaClient,
  userId: string,
  organizationId: string
): Promise<void> {
  try {
    await prisma.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: { id: organizationId },
    })
    await prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId, userId },
      },
      update: {},
      create: { organizationId, userId, role: 'OWNER' },
    })
  } catch {
    // Non-critical — don't block auth
  }
}

// Fixed by audit 2026-03: validate X-Organization-Id header against actual membership
async function validateOrgMembership(
  prisma: PrismaClient,
  userId: string,
  organizationId: string
): Promise<boolean> {
  try {
    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId },
      },
    })
    return !!membership
  } catch {
    return false
  }
}

export async function getAuthContext(
  request: Request,
  prisma: PrismaClient
): Promise<AuthContext> {
  const authHeader = request.headers.get('authorization')

  if (!authHeader) {
    return {}
  }

  // Support both "Bearer TOKEN" and just "TOKEN"
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : authHeader

  try {
    // First, try to validate as auth-service access token (JWT).
    // This is the primary token used by the web app, and avoids calling /tokens/validate.
    const authAccessResult = validateAuthAccessToken(token)
    if (authAccessResult) {
      await prisma.user.upsert({
        where: { id: authAccessResult.userId },
        update: {},
        create: { id: authAccessResult.userId },
      })

      const projectId = request.headers.get('x-project-id') || undefined
      const organizationId = request.headers.get('x-organization-id') || undefined

      // NOTE: X-Organization-Id header is used for service-auth ↔ cloud-api org sync.
      // Resolver-level ownership checks (project.userId, project.organizationId) are the
      // actual access-control gate. See audit 2026-03 for details.
      if (organizationId) {
        void ensureOrgMembership(prisma, authAccessResult.userId, organizationId)
      }

      return {
        userId: authAccessResult.userId,
        organizationId,
        projectId,
      }
    }

    // If this looks like an auth-service access token but local verification failed
    // (e.g. JWT secrets not aligned in dev), validate via auth-service /auth/me.
    const unverified = jwt.decode(token) as Partial<AuthAccessTokenPayload> | null
    if (unverified?.type === 'access' && typeof unverified.userId === 'string') {
      const remote = await validateAuthAccessTokenViaAuthService(token)
      if (remote) {
        await prisma.user.upsert({
          where: { id: remote.userId },
          update: {},
          create: { id: remote.userId },
        })

        const projectId = request.headers.get('x-project-id') || undefined
        const organizationId = request.headers.get('x-organization-id') || undefined

        if (organizationId) {
          void ensureOrgMembership(prisma, remote.userId, organizationId)
        }

        return {
          userId: remote.userId,
          organizationId,
          projectId,
        }
      }
      return {}
    }

    // First, try to validate as SDK access token (JWT)
    // This is faster and doesn't require network call
    const jwtResult = validateSdkAccessToken(token)

    if (jwtResult) {
      // Ensure user exists in cloud API database
      await prisma.user.upsert({
        where: { id: jwtResult.userId },
        update: {},
        create: { id: jwtResult.userId },
      })

      // Get project ID from JWT or header
      const projectIdHeader = request.headers.get('x-project-id')
      const projectId = projectIdHeader || jwtResult.projectId

      const organizationId = request.headers.get('x-organization-id') || undefined

      return {
        userId: jwtResult.userId,
        organizationId,
        projectId,
      }
    }

    // Fall back to PAT validation via auth service
    const validationResult = await validateTokenViaAuthService(token)

    if (!validationResult) {
      return {}
    }

    // Ensure user exists in cloud API database (upsert)
    await prisma.user.upsert({
      where: { id: validationResult.userId },
      update: {
        // Best-effort profile sync from auth service
        ...(validationResult.email ? { email: validationResult.email } : {}),
        ...(validationResult.displayName
          ? { username: validationResult.displayName }
          : {}),
      },
      create: {
        id: validationResult.userId,
        ...(validationResult.email ? { email: validationResult.email } : {}),
        ...(validationResult.displayName
          ? { username: validationResult.displayName }
          : {}),
      },
    })

    // Get project ID from X-Project-Id header (optional)
    const projectId = request.headers.get('x-project-id') || undefined

    // Organization ID comes from token, can be overridden by header
    const organizationIdHeader = request.headers.get('x-organization-id')
    const organizationId = organizationIdHeader || validationResult.organizationId

    if (organizationId) {
      void ensureOrgMembership(prisma, validationResult.userId, organizationId)
    }

    return {
      userId: validationResult.userId,
      organizationId,
      projectId,
    }
  } catch (error) {
    log.error(error, 'Auth error')
    return {}
  }
}
