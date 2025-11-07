/**
 * Rate Limiter Service
 *
 * Redis-based rate limiting for API operations.
 * Uses sliding window algorithm for accurate rate limiting.
 */

import Redis from 'ioredis';
import { rateLimiterLogger } from './logger.js';

export class RateLimiter {
  private redis: Redis;

  /**
   * Lua script for atomic rate limit check and increment
   * Returns: {allowed (0|1), remaining, resetAt}
   */
  private readonly CHECK_LIMIT_SCRIPT = `
    local key = KEYS[1]
    local now = tonumber(ARGV[1])
    local window_start = tonumber(ARGV[2])
    local limit = tonumber(ARGV[3])
    local window_seconds = tonumber(ARGV[4])
    local entry_id = ARGV[5]

    -- Remove old entries outside the time window
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    -- Count current entries in the window
    local count = redis.call('ZCARD', key)

    -- Check if over limit
    if count >= limit then
      -- Get oldest entry to determine when the window resets
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local reset_at = now + window_seconds * 1000
      if #oldest > 1 then
        reset_at = tonumber(oldest[2]) + window_seconds * 1000
      end
      return {0, 0, reset_at}
    end

    -- Add current request to the window
    redis.call('ZADD', key, now, entry_id)

    -- Set expiration to prevent memory leaks
    redis.call('EXPIRE', key, window_seconds)

    -- Return success
    return {1, limit - count - 1, now + window_seconds * 1000}
  `;

  constructor(redisUrl?: string) {
    this.redis = new Redis(redisUrl || process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.redis.on('error', (err) => {
      rateLimiterLogger.error('Redis connection error', {}, err);
    });

    this.redis.on('connect', () => {
      rateLimiterLogger.info('Connected to Redis');
    });
  }

  /**
   * Check if a user has exceeded their rate limit
   * Uses atomic Lua script to prevent race conditions
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
    const entryId = `${now}-${Math.random()}`; // Unique entry ID

    try {
      // Execute atomic Lua script
      // Returns: [allowed (0|1), remaining, resetAt]
      const result = await this.redis.eval(
        this.CHECK_LIMIT_SCRIPT,
        1, // number of keys
        key, // KEYS[1]
        now.toString(), // ARGV[1]
        windowStart.toString(), // ARGV[2]
        limit.toString(), // ARGV[3]
        windowSeconds.toString(), // ARGV[4]
        entryId // ARGV[5]
      ) as [number, number, number];

      const [allowed, remaining, resetAtMs] = result;

      return {
        allowed: allowed === 1,
        remaining: remaining,
        resetAt: new Date(resetAtMs),
      };
    } catch (error) {
      rateLimiterLogger.error('Error checking rate limit', { key, limit, windowSeconds }, error as Error);
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
