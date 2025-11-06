/**
 * Rate Limiter Service
 *
 * Redis-based rate limiting for API operations.
 * Uses sliding window algorithm for accurate rate limiting.
 */

import Redis from 'ioredis';

export class RateLimiter {
  private redis: Redis;

  constructor(redisUrl?: string) {
    this.redis = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.redis.on('error', (err) => {
      console.error('[RateLimiter] Redis connection error:', err);
    });

    this.redis.on('connect', () => {
      console.log('[RateLimiter] Connected to Redis');
    });
  }

  /**
   * Check if a user has exceeded their rate limit
   * @param key Unique identifier for the rate limit (e.g., "api_key_creation:user_123")
   * @param limit Maximum number of requests allowed in the window
   * @param windowSeconds Time window in seconds
   * @returns Object with allowed status and remaining count
   */
  async checkLimit(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    try {
      // Remove old entries outside the time window
      await this.redis.zremrangebyscore(key, '-inf', windowStart);

      // Count current entries in the window
      const count = await this.redis.zcard(key);

      if (count >= limit) {
        // Get the oldest entry to determine when the window resets
        const oldest = await this.redis.zrange(key, 0, 0, 'WITHSCORES');
        const resetAt = oldest.length > 1
          ? new Date(parseInt(oldest[1]) + windowSeconds * 1000)
          : new Date(now + windowSeconds * 1000);

        return {
          allowed: false,
          remaining: 0,
          resetAt,
        };
      }

      // Add current request to the window
      await this.redis.zadd(key, now, `${now}-${Math.random()}`);

      // Set expiration on the key to prevent memory leaks
      await this.redis.expire(key, windowSeconds);

      return {
        allowed: true,
        remaining: limit - count - 1,
        resetAt: new Date(now + windowSeconds * 1000),
      };
    } catch (error) {
      console.error('[RateLimiter] Error checking limit:', error);
      // On Redis errors, fail open to prevent blocking legitimate requests
      return {
        allowed: true,
        remaining: limit,
        resetAt: new Date(now + windowSeconds * 1000),
      };
    }
  }

  /**
   * Reset rate limit for a specific key
   * Useful for testing or manual override
   */
  async reset(key: string): Promise<void> {
    await this.redis.del(key);
  }

  /**
   * Get current count for a key
   */
  async getCount(key: string): Promise<number> {
    return await this.redis.zcard(key);
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

// Singleton instance
export const rateLimiter = new RateLimiter();
