import type { PrismaClient } from '@prisma/client'
import jwt from 'jsonwebtoken'

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
 * Validate token via auth service (for PATs)
 */
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
  const authServiceUrl = process.env.AUTH_SERVICE_URL
  const introspectionSecret = process.env.AUTH_INTROSPECTION_SECRET

  if (!authServiceUrl) {
    throw new Error('AUTH_SERVICE_URL not configured')
  }

  try {
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
        return null // Invalid token
      }
      throw new Error(`Auth service error: ${response.status}`)
    }

    const data = await response.json()

    if (!data.valid) {
      return null
    }

    return {
      userId: data.userId,
      tokenId: data.tokenId,
      organizationId: data.organizationId,
      email: data.email ?? null,
      displayName: data.displayName ?? null,
      avatarUrl: data.avatarUrl ?? null,
    }
  } catch (error) {
    console.error('Auth service validation error:', error)
    throw error
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

    return {
      userId: validationResult.userId,
      organizationId,
      projectId,
    }
  } catch (error) {
    console.error('Auth error:', error)
    return {}
  }
}
