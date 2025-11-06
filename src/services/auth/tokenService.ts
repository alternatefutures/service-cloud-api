/**
 * Personal Access Token Service
 *
 * Handles creation, validation, and deletion of API tokens.
 * Tokens follow the format: af_live_<random_base62_string> or af_test_<random_base62_string>
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { rateLimiter } from './rateLimiter.js';

const TOKEN_PREFIX = 'af';
const TOKEN_LENGTH = 32; // Length of the random part

export class TokenService {
  private prisma: PrismaClient;

  // Rate limit: 50 tokens per day per user
  private static readonly RATE_LIMIT = 50;
  private static readonly RATE_LIMIT_WINDOW = 24 * 60 * 60; // 24 hours in seconds

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Generate a secure random token
   * Format: af_live_<base62_random_string>
   */
  private generateToken(environment: 'live' | 'test' = 'live'): string {
    const base62Chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const bytes = randomBytes(TOKEN_LENGTH);

    let token = '';
    for (let i = 0; i < TOKEN_LENGTH; i++) {
      token += base62Chars[bytes[i] % base62Chars.length];
    }

    return `${TOKEN_PREFIX}_${environment}_${token}`;
  }

  /**
   * Create a new personal access token
   * Enforces rate limiting of 50 tokens per day
   */
  async createToken(
    userId: string,
    name: string,
    expiresAt?: Date
  ): Promise<{
    token: string;
    id: string;
    name: string;
    expiresAt: Date | null;
    createdAt: Date;
  }> {
    // Check rate limit
    const rateLimitKey = `api_key_creation:${userId}`;
    const rateLimit = await rateLimiter.checkLimit(
      rateLimitKey,
      TokenService.RATE_LIMIT,
      TokenService.RATE_LIMIT_WINDOW
    );

    if (!rateLimit.allowed) {
      const error = new Error(
        `Rate limit exceeded. You can only create ${TokenService.RATE_LIMIT} API keys per day. ` +
        `Limit resets at ${rateLimit.resetAt.toISOString()}`
      ) as Error & { code: string; resetAt: Date };
      error.code = 'RATE_LIMIT_EXCEEDED';
      (error as any).resetAt = rateLimit.resetAt;
      throw error;
    }

    // Generate token
    const token = this.generateToken();

    // Verify token is unique (extremely unlikely collision, but good practice)
    const existing = await this.prisma.personalAccessToken.findUnique({
      where: { token },
    });

    if (existing) {
      // Recursive retry on collision
      return this.createToken(userId, name, expiresAt);
    }

    // Create token in database
    const tokenRecord = await this.prisma.personalAccessToken.create({
      data: {
        name,
        token,
        userId,
        expiresAt,
      },
    });

    return {
      token: tokenRecord.token,
      id: tokenRecord.id,
      name: tokenRecord.name,
      expiresAt: tokenRecord.expiresAt,
      createdAt: tokenRecord.createdAt,
    };
  }

  /**
   * Delete a personal access token
   */
  async deleteToken(tokenId: string, userId: string): Promise<boolean> {
    const token = await this.prisma.personalAccessToken.findUnique({
      where: { id: tokenId },
    });

    if (!token) {
      throw new Error('Token not found');
    }

    if (token.userId !== userId) {
      throw new Error('Unauthorized: Token does not belong to user');
    }

    await this.prisma.personalAccessToken.delete({
      where: { id: tokenId },
    });

    return true;
  }

  /**
   * Validate a token and return the associated user
   * Also updates lastUsedAt timestamp
   */
  async validateToken(token: string): Promise<{ userId: string; tokenId: string } | null> {
    const tokenRecord = await this.prisma.personalAccessToken.findUnique({
      where: { token },
    });

    if (!tokenRecord) {
      return null;
    }

    // Check if token is expired
    if (tokenRecord.expiresAt && tokenRecord.expiresAt < new Date()) {
      return null;
    }

    // Update last used timestamp (don't await to not block the request)
    this.prisma.personalAccessToken
      .update({
        where: { id: tokenRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => {
        console.error('[TokenService] Error updating lastUsedAt:', err);
      });

    return {
      userId: tokenRecord.userId,
      tokenId: tokenRecord.id,
    };
  }

  /**
   * List all tokens for a user (excluding the token value itself)
   */
  async listTokens(userId: string): Promise<
    Array<{
      id: string;
      name: string;
      expiresAt: Date | null;
      lastUsedAt: Date | null;
      createdAt: Date;
    }>
  > {
    const tokens = await this.prisma.personalAccessToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        expiresAt: true,
        lastUsedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return tokens;
  }

  /**
   * Get remaining rate limit for a user
   */
  async getRemainingLimit(userId: string): Promise<{
    remaining: number;
    limit: number;
    resetAt: Date;
  }> {
    const rateLimitKey = `api_key_creation:${userId}`;
    const rateLimit = await rateLimiter.checkLimit(
      rateLimitKey,
      TokenService.RATE_LIMIT,
      TokenService.RATE_LIMIT_WINDOW
    );

    return {
      remaining: rateLimit.remaining,
      limit: TokenService.RATE_LIMIT,
      resetAt: rateLimit.resetAt,
    };
  }
}
