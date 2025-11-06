/**
 * Authentication Resolvers
 *
 * GraphQL resolvers for Personal Access Token management
 */

import { GraphQLError } from 'graphql';
import { TokenService } from '../services/auth/index.js';
import type { Context } from './types.js';

/**
 * Custom error interface for token service errors
 */
interface TokenServiceError extends Error {
  code?: 'RATE_LIMIT_EXCEEDED' | 'MAX_TOKENS_EXCEEDED' | 'UNAUTHORIZED';
  resetAt?: Date;
}

/**
 * Validate token name input
 */
function validateTokenName(name: string): void {
  if (!name || name.trim().length === 0) {
    throw new GraphQLError('Token name is required');
  }

  if (name.length > 100) {
    throw new GraphQLError('Token name must be 100 characters or less');
  }

  // Check for potentially malicious patterns (XSS, etc.)
  const dangerousPatterns = /<script|javascript:|onerror=/i;
  if (dangerousPatterns.test(name)) {
    throw new GraphQLError('Token name contains invalid characters');
  }
}

/**
 * Validate expiration date
 */
function validateExpiresAt(expiresAt: Date): void {
  const now = new Date();

  if (expiresAt <= now) {
    throw new GraphQLError('Expiration date must be in the future');
  }

  // Reasonable maximum: 10 years from now
  const maxDate = new Date();
  maxDate.setFullYear(maxDate.getFullYear() + 10);

  if (expiresAt > maxDate) {
    throw new GraphQLError('Expiration date cannot be more than 10 years in the future');
  }
}

export const authQueries = {
  /**
   * List all personal access tokens for the authenticated user
   */
  personalAccessTokens: async (_: unknown, __: unknown, context: Context) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated');
    }

    const tokenService = new TokenService(context.prisma);
    return tokenService.listTokens(context.userId);
  },

  /**
   * Get remaining rate limit for API key creation
   */
  apiKeyRateLimit: async (_: unknown, __: unknown, context: Context) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated');
    }

    const tokenService = new TokenService(context.prisma);
    return tokenService.getRemainingLimit(context.userId);
  },
};

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
      throw new GraphQLError('Not authenticated');
    }

    // Validate inputs
    validateTokenName(name);

    let expirationDate: Date | undefined;
    if (expiresAt) {
      try {
        expirationDate = new Date(expiresAt);
        if (isNaN(expirationDate.getTime())) {
          throw new Error('Invalid date');
        }
        validateExpiresAt(expirationDate);
      } catch (err) {
        throw new GraphQLError('Invalid expiration date format');
      }
    }

    const tokenService = new TokenService(context.prisma);

    try {
      const token = await tokenService.createToken(
        context.userId,
        name,
        expirationDate
      );

      return token;
    } catch (error) {
      const tokenError = error as TokenServiceError;

      if (tokenError.code === 'RATE_LIMIT_EXCEEDED') {
        throw new GraphQLError(tokenError.message, {
          extensions: {
            code: 'RATE_LIMIT_EXCEEDED',
            // Don't expose exact resetAt to prevent timing attacks
            resetAt: undefined,
          },
        });
      }

      if (tokenError.code === 'MAX_TOKENS_EXCEEDED') {
        throw new GraphQLError(tokenError.message, {
          extensions: {
            code: 'MAX_TOKENS_EXCEEDED',
          },
        });
      }

      // Don't expose internal error details
      throw new GraphQLError('Failed to create token', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
        },
      });
    }
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
      throw new GraphQLError('Not authenticated');
    }

    const tokenService = new TokenService(context.prisma);

    try {
      return await tokenService.deleteToken(id, context.userId);
    } catch (error) {
      const tokenError = error as TokenServiceError;

      // Don't expose internal error details
      if (tokenError.code === 'UNAUTHORIZED') {
        throw new GraphQLError('Not authorized to delete this token', {
          extensions: {
            code: 'UNAUTHORIZED',
          },
        });
      }

      throw new GraphQLError('Failed to delete token', {
        extensions: {
          code: 'INTERNAL_SERVER_ERROR',
        },
      });
    }
  },
};

export const authResolvers = {
  Query: authQueries,
  Mutation: authMutations,
};
