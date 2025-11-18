import type { RouteConfig } from '../../utils/routeValidation.js'

export interface CacheEntry {
  routes: RouteConfig
  timestamp: number
}

/**
 * Route Cache Service
 * Caches function route configurations for performance
 */
export class RouteCache {
  private cache: Map<string, CacheEntry>
  private ttl: number // Time to live in milliseconds

  constructor(ttlSeconds: number = 300) {
    // Default 5 minutes
    this.cache = new Map()
    this.ttl = ttlSeconds * 1000
  }

  /**
   * Get routes from cache
   * Returns null if not cached or expired
   */
  get(functionId: string): RouteConfig | null {
    const entry = this.cache.get(functionId)

    if (!entry) {
      return null
    }

    // Check if expired
    const now = Date.now()
    if (now - entry.timestamp > this.ttl) {
      this.cache.delete(functionId)
      return null
    }

    return entry.routes
  }

  /**
   * Store routes in cache
   */
  set(functionId: string, routes: RouteConfig): void {
    this.cache.set(functionId, {
      routes,
      timestamp: Date.now(),
    })
  }

  /**
   * Invalidate cache for a specific function
   */
  invalidate(functionId: string): void {
    this.cache.delete(functionId)
  }

  /**
   * Clear all cached routes
   */
  clear(): void {
    this.cache.clear()
  }

  /**
   * Get cache statistics
   */
  getStats() {
    return {
      size: this.cache.size,
      ttl: this.ttl,
    }
  }

  /**
   * Clean up expired entries
   */
  cleanup(): number {
    const now = Date.now()
    let removed = 0

    for (const [functionId, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttl) {
        this.cache.delete(functionId)
        removed++
      }
    }

    return removed
  }
}
