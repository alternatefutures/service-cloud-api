/**
 * Authentication Resolvers
 *
 * GraphQL resolvers for Personal Access Token management
 */

import { GraphQLError } from 'graphql';
import { TokenService } from '../services/auth/index.js';
import type { Context } from './types.js';

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

    const tokenService = new TokenService(context.prisma);

    try {
      const token = await tokenService.createToken(
        context.userId,
        name,
        expiresAt ? new Date(expiresAt) : undefined
      );

      return token;
    } catch (error: any) {
      if (error.code === 'RATE_LIMIT_EXCEEDED') {
        throw new GraphQLError(error.message, {
          extensions: {
            code: 'RATE_LIMIT_EXCEEDED',
            resetAt: error.resetAt,
          },
        });
      }
      if (error.code === 'MAX_TOKENS_EXCEEDED') {
        throw new GraphQLError(error.message, {
          extensions: {
            code: 'MAX_TOKENS_EXCEEDED',
          },
        });
      }
      throw error;
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
    } catch (error: any) {
      throw new GraphQLError(error.message);
    }
  },
};

export const authResolvers = {
  Query: authQueries,
  Mutation: authMutations,
};
