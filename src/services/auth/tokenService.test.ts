/**
 * Token Service Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TokenService } from './tokenService.js';
import { rateLimiter } from './rateLimiter.js';

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL || 'postgresql://localhost:5432/af_test',
    },
  },
});

describe('TokenService', () => {
  let tokenService: TokenService;
  let testUserId: string;

  beforeEach(async () => {
    tokenService = new TokenService(prisma);

    // Create a test user
    const user = await prisma.user.create({
      data: {
        email: `test-${Date.now()}@example.com`,
        username: `test-user-${Date.now()}`,
        walletAddress: `0x${Date.now()}`,
      },
    });
    testUserId = user.id;

    // Reset rate limit for test user
    await rateLimiter.reset(`api_key_creation:${testUserId}`);
  });

  afterEach(async () => {
    // Clean up test data
    await prisma.personalAccessToken.deleteMany({
      where: { userId: testUserId },
    });
    await prisma.user.delete({
      where: { id: testUserId },
    });

    // Reset rate limit
    await rateLimiter.reset(`api_key_creation:${testUserId}`);
  });

  describe('Token Generation', () => {
    it('should generate a valid token with correct format', async () => {
      const token = await tokenService.createToken(testUserId, 'Test Token');

      expect(token.token).toMatch(/^af_live_[A-Za-z0-9]{32}$/);
      expect(token.name).toBe('Test Token');
      expect(token.id).toBeDefined();
      expect(token.createdAt).toBeInstanceOf(Date);
    });

    it('should generate unique tokens', async () => {
      const token1 = await tokenService.createToken(testUserId, 'Token 1');
      const token2 = await tokenService.createToken(testUserId, 'Token 2');

      expect(token1.token).not.toBe(token2.token);
    });

    it('should create token with expiration date', async () => {
      const expiresAt = new Date(Date.now() + 86400000); // 24 hours from now
      const token = await tokenService.createToken(testUserId, 'Expiring Token', expiresAt);

      expect(token.expiresAt).toEqual(expiresAt);
    });

    it('should create token without expiration date', async () => {
      const token = await tokenService.createToken(testUserId, 'Permanent Token');

      expect(token.expiresAt).toBeNull();
    });
  });

  describe('Rate Limiting', () => {
    it('should allow creating up to 50 tokens per day', async () => {
      const tokens: any[] = [];

      // Create 50 tokens (should all succeed)
      for (let i = 0; i < 50; i++) {
        const token = await tokenService.createToken(testUserId, `Token ${i + 1}`);
        tokens.push(token);
      }

      expect(tokens).toHaveLength(50);
    });

    it('should reject token creation after exceeding rate limit', async () => {
      // Create 50 tokens to hit the limit
      for (let i = 0; i < 50; i++) {
        await tokenService.createToken(testUserId, `Token ${i + 1}`);
      }

      // 51st token should fail
      await expect(tokenService.createToken(testUserId, 'Token 51')).rejects.toThrow(
        /Rate limit exceeded/
      );
    });

    it('should include resetAt in rate limit error', async () => {
      // Create 50 tokens to hit the limit
      for (let i = 0; i < 50; i++) {
        await tokenService.createToken(testUserId, `Token ${i + 1}`);
      }

      // Check error contains resetAt
      try {
        await tokenService.createToken(testUserId, 'Token 51');
        throw new Error('Expected rate limit error');
      } catch (error: any) {
        expect(error.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(error.resetAt).toBeInstanceOf(Date);
      }
    });
  });

  describe('Max Active Tokens', () => {
    it('should reject token creation after exceeding max active tokens', async () => {
      // This test would be very slow with 500 tokens, so we'll just test the logic
      // by mocking the count. In a real scenario, you'd need to create 500 tokens.

      // Create a few tokens
      await tokenService.createToken(testUserId, 'Token 1');
      await tokenService.createToken(testUserId, 'Token 2');

      // Mock the prisma count to simulate 500 existing tokens
      const originalCount = prisma.personalAccessToken.count;
      prisma.personalAccessToken.count = async () => 500;

      // Should fail due to max active tokens
      await expect(tokenService.createToken(testUserId, 'Token 501')).rejects.toThrow(
        /Maximum active API keys limit reached/
      );

      // Check error code
      try {
        await tokenService.createToken(testUserId, 'Token 501');
        throw new Error('Expected max tokens error');
      } catch (error: any) {
        expect(error.code).toBe('MAX_TOKENS_EXCEEDED');
      }

      // Restore original count
      prisma.personalAccessToken.count = originalCount;
    });

    it('should allow creating tokens when deleting brings count below max', async () => {
      // Create a couple of tokens
      const token1 = await tokenService.createToken(testUserId, 'Token 1');
      const token2 = await tokenService.createToken(testUserId, 'Token 2');

      // Mock to simulate being at max
      const originalCount = prisma.personalAccessToken.count;
      prisma.personalAccessToken.count = async () => 500;

      // Should fail
      await expect(tokenService.createToken(testUserId, 'Token 3')).rejects.toThrow(
        /Maximum active API keys limit reached/
      );

      // Restore count
      prisma.personalAccessToken.count = originalCount;

      // Delete one token
      await tokenService.deleteToken(token1.id, testUserId);

      // Now should be able to create again (we're back under the limit)
      const token3 = await tokenService.createToken(testUserId, 'Token 3');
      expect(token3).toBeDefined();
    });
  });

  describe('Token Validation', () => {
    it('should validate a valid token', async () => {
      const createdToken = await tokenService.createToken(testUserId, 'Valid Token');

      const validation = await tokenService.validateToken(createdToken.token);

      expect(validation).not.toBeNull();
      expect(validation?.userId).toBe(testUserId);
      expect(validation?.tokenId).toBe(createdToken.id);
    });

    it('should reject an invalid token', async () => {
      const validation = await tokenService.validateToken('af_live_invalidtoken123456789012');

      expect(validation).toBeNull();
    });

    it('should reject an expired token', async () => {
      const expiresAt = new Date(Date.now() - 1000); // Expired 1 second ago
      const createdToken = await tokenService.createToken(testUserId, 'Expired Token', expiresAt);

      const validation = await tokenService.validateToken(createdToken.token);

      expect(validation).toBeNull();
    });

    it('should update lastUsedAt timestamp on validation', async () => {
      const createdToken = await tokenService.createToken(testUserId, 'Token');

      // Wait a bit to ensure timestamp difference
      await new Promise((resolve) => setTimeout(resolve, 100));

      await tokenService.validateToken(createdToken.token);

      // Wait for async update to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const tokenRecord = await prisma.personalAccessToken.findUnique({
        where: { id: createdToken.id },
      });

      expect(tokenRecord?.lastUsedAt).not.toBeNull();
      expect(tokenRecord?.lastUsedAt!.getTime()).toBeGreaterThan(
        tokenRecord?.createdAt.getTime()!
      );
    });
  });

  describe('Token Deletion', () => {
    it('should delete a token', async () => {
      const createdToken = await tokenService.createToken(testUserId, 'Token to Delete');

      const result = await tokenService.deleteToken(createdToken.id, testUserId);

      expect(result).toBe(true);

      const tokenRecord = await prisma.personalAccessToken.findUnique({
        where: { id: createdToken.id },
      });

      expect(tokenRecord).toBeNull();
    });

    it('should reject deleting a non-existent token', async () => {
      await expect(tokenService.deleteToken('non-existent-id', testUserId)).rejects.toThrow(
        'Token not found'
      );
    });

    it('should reject deleting a token from another user', async () => {
      // Create another user
      const otherUser = await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          username: `other-user-${Date.now()}`,
          walletAddress: `0x${Date.now() + 1}`,
        },
      });

      const createdToken = await tokenService.createToken(testUserId, 'Token');

      await expect(tokenService.deleteToken(createdToken.id, otherUser.id)).rejects.toThrow(
        'Unauthorized'
      );

      // Cleanup
      await prisma.user.delete({ where: { id: otherUser.id } });
    });
  });

  describe('Token Listing', () => {
    it('should list all tokens for a user', async () => {
      await tokenService.createToken(testUserId, 'Token 1');
      await tokenService.createToken(testUserId, 'Token 2');
      await tokenService.createToken(testUserId, 'Token 3');

      const tokens = await tokenService.listTokens(testUserId);

      expect(tokens).toHaveLength(3);
      expect(tokens[0].name).toBe('Token 3'); // Most recent first
      expect(tokens[1].name).toBe('Token 2');
      expect(tokens[2].name).toBe('Token 1');
    });

    it('should not include token values in list', async () => {
      await tokenService.createToken(testUserId, 'Token 1');

      const tokens = await tokenService.listTokens(testUserId);

      expect(tokens[0]).not.toHaveProperty('token');
    });
  });

  describe('Rate Limit Info', () => {
    it('should return correct remaining limit and active tokens count', async () => {
      await tokenService.createToken(testUserId, 'Token 1');
      await tokenService.createToken(testUserId, 'Token 2');

      const rateLimit = await tokenService.getRemainingLimit(testUserId);

      expect(rateLimit.limit).toBe(50);
      expect(rateLimit.remaining).toBe(48);
      expect(rateLimit.resetAt).toBeInstanceOf(Date);
      expect(rateLimit.activeTokens).toBe(2);
      expect(rateLimit.maxActiveTokens).toBe(500);
    });
  });
});
