/**
 * Rate Limiter Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from './rateLimiter.js';

describe('RateLimiter', () => {
  let rateLimiter: RateLimiter;
  const testKey = 'test-rate-limit';

  beforeEach(async () => {
    rateLimiter = new RateLimiter();
    await rateLimiter.reset(testKey);
  });

  afterEach(async () => {
    await rateLimiter.reset(testKey);
  });

  describe('Sliding Window Algorithm', () => {
    it('should allow requests within the limit', async () => {
      const limit = 5;
      const windowSeconds = 60;

      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.checkLimit(testKey, limit, windowSeconds);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(5 - i - 1);
      }
    });

    it('should block requests after exceeding limit', async () => {
      const limit = 3;
      const windowSeconds = 60;

      // Use up the limit
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      }

      // Next request should be blocked
      const result = await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should return resetAt timestamp', async () => {
      const limit = 5;
      const windowSeconds = 60;
      const before = Date.now();

      const result = await rateLimiter.checkLimit(testKey, limit, windowSeconds);

      expect(result.resetAt).toBeInstanceOf(Date);
      expect(result.resetAt.getTime()).toBeGreaterThan(before);
      expect(result.resetAt.getTime()).toBeLessThanOrEqual(before + windowSeconds * 1000 + 1000);
    });

    it('should clean up old entries outside the window', async () => {
      const limit = 5;
      const windowSeconds = 2; // 2 second window

      // Make 3 requests
      await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      await rateLimiter.checkLimit(testKey, limit, windowSeconds);

      // Wait for window to expire
      await new Promise((resolve) => setTimeout(resolve, 2100));

      // Old entries should be cleaned up, so we should have full limit again
      const result = await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
    });
  });

  describe('Multiple Keys', () => {
    it('should maintain separate limits for different keys', async () => {
      const limit = 3;
      const windowSeconds = 60;
      const key1 = 'user1:api_key_creation';
      const key2 = 'user2:api_key_creation';

      // Use up limit for key1
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit(key1, limit, windowSeconds);
      }

      // key1 should be blocked
      const result1 = await rateLimiter.checkLimit(key1, limit, windowSeconds);
      expect(result1.allowed).toBe(false);

      // key2 should still be allowed
      const result2 = await rateLimiter.checkLimit(key2, limit, windowSeconds);
      expect(result2.allowed).toBe(true);

      // Cleanup
      await rateLimiter.reset(key1);
      await rateLimiter.reset(key2);
    });
  });

  describe('Reset Functionality', () => {
    it('should reset limit for a key', async () => {
      const limit = 3;
      const windowSeconds = 60;

      // Use up the limit
      for (let i = 0; i < 3; i++) {
        await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      }

      // Should be blocked
      let result = await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      expect(result.allowed).toBe(false);

      // Reset
      await rateLimiter.reset(testKey);

      // Should be allowed again
      result = await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(2);
    });
  });

  describe('Get Count', () => {
    it('should return current count for a key', async () => {
      const limit = 10;
      const windowSeconds = 60;

      // Make some requests
      await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      await rateLimiter.checkLimit(testKey, limit, windowSeconds);
      await rateLimiter.checkLimit(testKey, limit, windowSeconds);

      const count = await rateLimiter.getCount(testKey);
      expect(count).toBe(3);
    });

    it('should return 0 for non-existent key', async () => {
      const count = await rateLimiter.getCount('non-existent-key');
      expect(count).toBe(0);
    });
  });

  describe('Error Handling', () => {
    it('should fail open on Redis errors', async () => {
      // Create a rate limiter with invalid Redis URL to simulate connection error
      const faultyLimiter = new RateLimiter('redis://invalid:9999');

      // Wait a bit for connection to fail
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Should fail open (allow the request)
      const result = await faultyLimiter.checkLimit(testKey, 5, 60);
      expect(result.allowed).toBe(true);

      await faultyLimiter.close();
    });
  });
});
