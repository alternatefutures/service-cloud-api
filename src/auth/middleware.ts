import type { PrismaClient } from '@prisma/client'

export interface AuthContext {
  userId?: string
  organizationId?: string
  projectId?: string
}

/**
 * Validate token via auth service
 */
async function validateTokenViaAuthService(
  token: string
): Promise<{ userId: string; tokenId: string; organizationId?: string } | null> {
  const authServiceUrl = process.env.AUTH_SERVICE_URL

  if (!authServiceUrl) {
    throw new Error('AUTH_SERVICE_URL not configured')
  }

  try {
    const response = await fetch(`${authServiceUrl}/tokens/validate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
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
    }
  } catch (error) {
    console.error('Auth service validation error:', error)
    throw error
  }
}

export async function getAuthContext(
  request: Request,
  _prisma: PrismaClient
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
    // Validate token via auth service
    const validationResult = await validateTokenViaAuthService(token)

    if (!validationResult) {
      return {}
    }

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
