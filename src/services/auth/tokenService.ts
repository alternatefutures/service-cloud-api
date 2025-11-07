/**
 * Personal Access Token Service
 *
 * Handles creation, validation, and deletion of API tokens.
 * Tokens follow the format: af_live_<random_base62_string> or af_test_<random_base62_string>
 */

import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'crypto';
import { rateLimiter } from './rateLimiter.js';
import { tokenServiceLogger } from './logger.js';

const TOKEN_PREFIX = 'af';
const TOKEN_LENGTH = 32; // Length of the random part

export class TokenService {
  private prisma: PrismaClient;

  // Rate limit: 50 tokens per day per user
  private static readonly RATE_LIMIT = 50;
  private static readonly RATE_LIMIT_WINDOW = 24 * 60 * 60; // 24 hours in seconds

  // Max active tokens: 500 per user
  private static readonly MAX_ACTIVE_TOKENS = 500;

  // Max retries for token generation
  private static readonly MAX_RETRIES = 5;

  // Token name validation constraints
  private static readonly MIN_NAME_LENGTH = 1;
  private static readonly MAX_NAME_LENGTH = 100;
  private static readonly VALID_NAME_PATTERN = /^[a-zA-Z0-9\s\-_\.]+$/;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Validate token name for security and correctness
   * Prevents XSS, injection attacks, and ensures reasonable constraints
   */
  private validateTokenName(name: string): void {
    // Check for null/undefined
    if (name === null || name === undefined) {
      const error = new Error('Token name is required') as Error & { code: string };
      error.code = 'INVALID_TOKEN_NAME';
      throw error;
    }

    // Trim whitespace
    const trimmedName = name.trim();

    // Check for empty or whitespace-only names
    if (trimmedName.length === 0) {
      const error = new Error('Token name cannot be empty or whitespace only') as Error & { code: string };
      error.code = 'INVALID_TOKEN_NAME';
      throw error;
    }

    // Check length constraints
    if (trimmedName.length < TokenService.MIN_NAME_LENGTH) {
      const error = new Error(
        `Token name must be at least ${TokenService.MIN_NAME_LENGTH} character(s)`
      ) as Error & { code: string };
      error.code = 'INVALID_TOKEN_NAME';
      throw error;
    }

    if (trimmedName.length > TokenService.MAX_NAME_LENGTH) {
      const error = new Error(
        `Token name must not exceed ${TokenService.MAX_NAME_LENGTH} characters`
      ) as Error & { code: string };
      error.code = 'INVALID_TOKEN_NAME';
      throw error;
    }

    // Check for invalid characters (prevents XSS and injection attacks)
    if (!TokenService.VALID_NAME_PATTERN.test(trimmedName)) {
      const error = new Error(
        'Token name contains invalid characters. Only alphanumeric characters, spaces, hyphens, underscores, and dots are allowed'
      ) as Error & { code: string };
      error.code = 'INVALID_TOKEN_NAME';
      throw error;
    }

    // Check for dangerous patterns (additional XSS prevention)
    const dangerousPatterns = [
      /<script/i,
      /<iframe/i,
      /javascript:/i,
      /on\w+=/i, // Event handlers like onclick=
      /data:text\/html/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmedName)) {
        const error = new Error(
          'Token name contains potentially dangerous content'
        ) as Error & { code: string };
        error.code = 'INVALID_TOKEN_NAME';
        throw error;
      }
    }
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
   * Enforces rate limiting of 50 tokens per day and max 500 active tokens
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
    // Validate token name first (before any rate limiting or database operations)
    this.validateTokenName(name);

    // Trim name for storage consistency
    const trimmedName = name.trim();

    return this.createTokenWithRetries(userId, trimmedName, expiresAt, 0);
  }

  /**
   * Internal method to create token with retry limiting and transaction safety
   * Prevents race conditions by checking limits and creating token atomically
   */
  private async createTokenWithRetries(
    userId: string,
    name: string,
    expiresAt: Date | undefined,
    retryCount: number
  ): Promise<{
    token: string;
    id: string;
    name: string;
    expiresAt: Date | null;
    createdAt: Date;
  }> {
    // Check retry limit
    if (retryCount >= TokenService.MAX_RETRIES) {
      throw new Error('Failed to generate unique token after multiple attempts');
    }

    // Check rate limit (outside transaction since it uses Redis)
    const rateLimitKey = `api_key_creation:${userId}`;
    const rateLimit = await rateLimiter.checkLimit(
      rateLimitKey,
      TokenService.RATE_LIMIT,
      TokenService.RATE_LIMIT_WINDOW
    );

    if (!rateLimit.allowed) {
      // Round resetAt to nearest hour to prevent timing attacks
      const resetHour = new Date(rateLimit.resetAt);
      resetHour.setMinutes(0, 0, 0);

      const error = new Error(
        `Rate limit exceeded. You can only create ${TokenService.RATE_LIMIT} API keys per day. ` +
        `Limit resets at approximately ${resetHour.toISOString()}`
      ) as Error & { code: string; resetAt: Date };
      error.code = 'RATE_LIMIT_EXCEEDED';
      (error as any).resetAt = resetHour; // Rounded timestamp
      throw error;
    }

    // Generate token
    const token = this.generateToken();

    // Use transaction to prevent race conditions
    try {
      const tokenRecord = await this.prisma.$transaction(async (tx) => {
        // Check max active tokens limit within transaction
        const activeTokensCount = await tx.personalAccessToken.count({
          where: { userId },
        });

        if (activeTokensCount >= TokenService.MAX_ACTIVE_TOKENS) {
          const error = new Error(
            `Maximum active API keys limit reached. You can have up to ${TokenService.MAX_ACTIVE_TOKENS} active keys. ` +
            `Please delete unused keys before creating new ones.`
          ) as Error & { code: string };
          error.code = 'MAX_TOKENS_EXCEEDED';
          throw error;
        }

        // Verify token is unique (extremely unlikely collision, but good practice)
        const existing = await tx.personalAccessToken.findUnique({
          where: { token },
        });

        if (existing) {
          // Token collision detected - signal retry
          const retryError = new Error('TOKEN_COLLISION') as Error & { retry: boolean };
          (retryError as any).retry = true;
          throw retryError;
        }

        // Create token in database
        return await tx.personalAccessToken.create({
          data: {
            name,
            token,
            userId,
            expiresAt,
          },
        });
      });

      return {
        token: tokenRecord.token,
        id: tokenRecord.id,
        name: tokenRecord.name,
        expiresAt: tokenRecord.expiresAt,
        createdAt: tokenRecord.createdAt,
      };
    } catch (error: any) {
      // If token collision, retry with incremented counter
      if (error.message === 'TOKEN_COLLISION' || error.retry) {
        return this.createTokenWithRetries(userId, name, expiresAt, retryCount + 1);
      }
      // Re-throw other errors
      throw error;
    }
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
    activeTokens: number;
    maxActiveTokens: number;
  }> {
    const rateLimitKey = `api_key_creation:${userId}`;

    // Use getCount instead of checkLimit to avoid consuming a rate limit slot
    const currentCount = await rateLimiter.getCount(rateLimitKey);
    const remaining = Math.max(0, TokenService.RATE_LIMIT - currentCount);

    // Calculate reset time
    const now = Date.now();
    const resetAt = new Date(now + TokenService.RATE_LIMIT_WINDOW * 1000);

    const activeTokensCount = await this.prisma.personalAccessToken.count({
      where: { userId },
    });

    return {
      remaining,
      limit: TokenService.RATE_LIMIT,
      resetAt,
      activeTokens: activeTokensCount,
      maxActiveTokens: TokenService.MAX_ACTIVE_TOKENS,
    };
  }
}
