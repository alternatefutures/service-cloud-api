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
 * Generate a short-lived JWT token for service-to-service authentication
 * The auth service will validate this token to authenticate the backend
 */
function generateServiceToken(userId: string): string {
  const secret = process.env.JWT_SECRET
  if (!secret) {
    throw new Error('JWT_SECRET not configured')
  }

  // Generate a JWT token with 5-minute expiry for service-to-service auth
  return jwt.sign(
    {
      userId,
      service: 'alternatefutures-backend',
      type: 'service-to-service',
    },
    secret,
    { expiresIn: '5m' }
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
    return data.tokens
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

export const authMutations = {
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
