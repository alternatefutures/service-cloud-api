/**
 * Authentication Resolvers
 *
 * GraphQL resolvers for Personal Access Token management
 * All PAT operations now proxy to the auth service
 */

import { GraphQLError } from 'graphql'
import jwt from 'jsonwebtoken'
import type { Context } from './types.js'

/**
 * Get auth service URL from environment
 * Throws an error if not configured
 */
function getAuthServiceUrl(): string {
  const url = process.env.AUTH_SERVICE_URL
  if (!url) {
    throw new GraphQLError('Auth service not configured', {
      extensions: {
        code: 'AUTH_SERVICE_NOT_CONFIGURED',
      },
    })
  }
  return url
}

/**
 * Generate a short-lived JWT token that the auth-service accepts.
 *
 * The auth-service `authMiddleware` only accepts tokens that look like its own
 * access tokens (type=access, correct issuer/audience, signed with JWT_SECRET).
 */
function generateServiceToken(userId: string): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET not configured')
  }

  return jwt.sign(
    {
      userId,
      sessionId: 'cloud-api',
      type: 'access',
    },
    secret,
    {
      expiresIn: '5m',
      issuer: 'alternatefutures-auth',
      audience: 'alternatefutures-app',
    }
  )
}

/**
 * Make authenticated request to auth service
 * Uses JWT token for service-to-service authentication
 */
async function authServiceRequest(
  endpoint: string,
  options: RequestInit,
  userId: string
): Promise<Response> {
  const authServiceUrl = getAuthServiceUrl()

  // Generate JWT token for authentication
  const token = generateServiceToken(userId)

  const response = await fetch(`${authServiceUrl}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  })

  return response
}

/**
 * Validate token name input
 */
function validateTokenName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new GraphQLError('Token name is required')
  }

  if (name.length > 100) {
    throw new GraphQLError('Token name must be 100 characters or less')
  }

  // Check for potentially malicious patterns (XSS, etc.)
  const dangerousPatterns = /<script|javascript:|onerror=/i
  if (dangerousPatterns.test(name)) {
    throw new GraphQLError('Token name contains invalid characters')
  }
}

/**
 * Validate expiration date
 */
function validateExpiresAt(expiresAt: Date): void {
  const now = new Date()

  if (expiresAt <= now) {
    throw new GraphQLError('Expiration date must be in the future')
  }

  // Reasonable maximum: 10 years from now
  const maxDate = new Date()
  maxDate.setFullYear(maxDate.getFullYear() + 10)

  if (expiresAt > maxDate) {
    throw new GraphQLError(
      'Expiration date cannot be more than 10 years in the future'
    )
  }
}

export const authQueries = {
  /**
   * List all personal access tokens for the authenticated user
   */
  personalAccessTokens: async (_: unknown, __: unknown, context: Context) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    const authServiceUrl = getAuthServiceUrl()

    const response = await authServiceRequest(
      '/tokens',
      {
        method: 'GET',
      },
      context.userId
    )

    if (!response.ok) {
      throw new GraphQLError('Failed to list tokens', {
        extensions: {
          code: 'AUTH_SERVICE_ERROR',
        },
      })
    }

    const data = await response.json()
    const tokens = (data.tokens || []).map((t: any) => ({
      id: t.id,
      name: t.name,
      // SDK expects this field; we don't have a server-side masked value
      maskedToken: null,
      expiresAt: t.expiresAt ? new Date(t.expiresAt) : null,
      lastUsedAt: t.lastUsedAt ? new Date(t.lastUsedAt) : null,
      createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
      updatedAt: t.updatedAt ? new Date(t.updatedAt) : new Date(),
    }))

    // Return wrapped format for SDK compatibility
    return { data: tokens }
  },

  /**
   * Get remaining rate limit for API key creation
   */
  apiKeyRateLimit: async (_: unknown, __: unknown, context: Context) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    const authServiceUrl = getAuthServiceUrl()

    const response = await authServiceRequest(
      '/tokens/limits',
      {
        method: 'GET',
      },
      context.userId
    )

    if (!response.ok) {
      throw new GraphQLError('Failed to get rate limits', {
        extensions: {
          code: 'AUTH_SERVICE_ERROR',
        },
      })
    }

    const data = await response.json()

    // Transform response to match GraphQL schema
    return {
      remaining: data.rateLimit.remaining,
      limit: data.rateLimit.limit,
      resetAt: new Date(data.rateLimit.resetAt),
      activeTokens: data.tokenLimit.active,
      maxActiveTokens: data.tokenLimit.max,
    }
  },
}

/**
 * Validate token via auth service (for loginWithPersonalAccessToken)
 */
async function validateTokenViaAuthService(
  token: string
): Promise<{ userId: string; tokenId: string; organizationId?: string } | null> {
  const authServiceUrl = getAuthServiceUrl()
  const introspectionSecret = process.env.AUTH_INTROSPECTION_SECRET

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
      return null
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
    console.error('Token validation error:', error)
    return null
  }
}

/**
 * Generate a short-lived access token for the SDK
 * This token is used for subsequent GraphQL requests
 */
function generateAccessToken(userId: string, projectId?: string): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET not configured')
  }

  // SDK access tokens are short-lived (8 minutes by default, matching SDK expectations)
  return jwt.sign(
    {
      userId,
      projectId,
      type: 'sdk-access',
    },
    secret,
    { expiresIn: '8m' }
  )
}

export const authMutations = {
  /**
   * Exchange a Personal Access Token for a short-lived access token
   * This is used by the SDK to authenticate subsequent requests
   * Does NOT require prior authentication
   */
  loginWithPersonalAccessToken: async (
    _: unknown,
    { data }: { data: { personalAccessToken: string; projectId?: string } },
    context: Context
  ) => {
    const { personalAccessToken, projectId } = data
    
    if (!personalAccessToken) {
      throw new GraphQLError('Personal access token is required', {
        extensions: {
          code: 'INVALID_ARGUMENT',
          name: 'InvalidArgumentError',
        },
      })
    }

    // Validate the PAT via auth service
    const validationResult = await validateTokenViaAuthService(personalAccessToken)

    if (!validationResult) {
      throw new GraphQLError('Invalid or expired personal access token', {
        extensions: {
          code: 'UNAUTHORIZED',
          name: 'UnauthorizedError',
        },
      })
    }

    // Ensure user exists in our database
    await context.prisma.user.upsert({
      where: { id: validationResult.userId },
      update: {},
      create: { id: validationResult.userId },
    })

    // Generate a short-lived access token for subsequent requests
    const accessToken = generateAccessToken(validationResult.userId, projectId)

    return accessToken
  },

  /**
   * Create a new personal access token
   * Rate limited to 50 tokens per day per user
   */
  createPersonalAccessToken: async (
    _: unknown,
    { name, expiresAt }: { name: string; expiresAt?: string },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    // Validate inputs
    validateTokenName(name)

    let expirationDate: Date | undefined
    let expirationTimestamp: number | undefined
    if (expiresAt) {
      try {
        expirationDate = new Date(expiresAt)
        if (isNaN(expirationDate.getTime())) {
          throw new Error('Invalid date')
        }
        validateExpiresAt(expirationDate)
        expirationTimestamp = expirationDate.getTime()
      } catch (err) {
        throw new GraphQLError('Invalid expiration date format')
      }
    }

    const authServiceUrl = getAuthServiceUrl()

    const response = await authServiceRequest(
      '/tokens',
      {
        method: 'POST',
        body: JSON.stringify({
          name,
          expiresAt: expirationTimestamp,
        }),
      },
      context.userId
    )

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))

      if (response.status === 429) {
        throw new GraphQLError(errorData.error || 'Rate limit exceeded', {
          extensions: {
            code: 'RATE_LIMIT_EXCEEDED',
            resetAt: undefined,
          },
        })
      }

      if (errorData.code === 'MAX_TOKENS_EXCEEDED') {
        throw new GraphQLError(errorData.error || 'Maximum tokens exceeded', {
          extensions: {
            code: 'MAX_TOKENS_EXCEEDED',
          },
        })
      }

      throw new GraphQLError('Failed to create token', {
        extensions: {
          code: 'AUTH_SERVICE_ERROR',
        },
      })
    }

    const data = await response.json()
    return data.token
  },

  /**
   * Delete a personal access token
   */
  deletePersonalAccessToken: async (
    _: unknown,
    { id }: { id: string },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated')
    }

    const authServiceUrl = getAuthServiceUrl()

    const response = await authServiceRequest(
      `/tokens/${id}`,
      {
        method: 'DELETE',
      },
      context.userId
    )

    if (!response.ok) {
      if (response.status === 404) {
        throw new GraphQLError('Token not found', {
          extensions: {
            code: 'NOT_FOUND',
          },
        })
      }

      if (response.status === 403) {
        throw new GraphQLError('Not authorized to delete this token', {
          extensions: {
            code: 'UNAUTHORIZED',
          },
        })
      }

      throw new GraphQLError('Failed to delete token', {
        extensions: {
          code: 'AUTH_SERVICE_ERROR',
        },
      })
    }

    const data = await response.json()
    return data.success
  },
}

export const authResolvers = {
  Query: authQueries,
  Mutation: authMutations,
}
