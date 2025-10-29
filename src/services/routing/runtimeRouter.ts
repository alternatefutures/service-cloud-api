import type { PrismaClient } from '@prisma/client';
import { RouteMatcher } from './routeMatcher.js';
import { RequestProxy, ProxyError } from './requestProxy.js';
import { RouteCache } from './routeCache.js';
import type { RouteConfig } from '../../utils/routeValidation.js';
import type { ProxyRequest, ProxyResponse } from './requestProxy.js';

export interface RuntimeRouterOptions {
  cacheTTL?: number; // Cache TTL in seconds
  proxyTimeout?: number; // Proxy timeout in milliseconds
}

/**
 * Runtime Router Service
 * Main service that handles routing logic for function invocations
 */
export class RuntimeRouter {
  private matcher: RouteMatcher;
  private proxy: RequestProxy;
  private cache: RouteCache;
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient, options: RuntimeRouterOptions = {}) {
    this.prisma = prisma;
    this.matcher = new RouteMatcher();
    this.proxy = new RequestProxy({ timeout: options.proxyTimeout });
    this.cache = new RouteCache(options.cacheTTL);
  }

  /**
   * Load function configuration including routes
   * Uses cache for performance
   */
  private async loadFunctionConfig(functionId: string): Promise<RouteConfig | null> {
    // Check cache first
    const cached = this.cache.get(functionId);
    if (cached) {
      return cached;
    }

    // Load from database
    const func = await this.prisma.aFFunction.findUnique({
      where: { id: functionId },
      select: { routes: true, status: true },
    });

    if (!func || func.status !== 'ACTIVE') {
      return null;
    }

    const routes = func.routes as RouteConfig | null;

    // Cache the result
    if (routes) {
      this.cache.set(functionId, routes);
    }

    return routes;
  }

  /**
   * Handle an incoming request with routing
   * Returns ProxyResponse if route matches, null if no match
   */
  async handleRequest(
    functionId: string,
    request: ProxyRequest
  ): Promise<ProxyResponse | null> {
    // Load function configuration
    const routes = await this.loadFunctionConfig(functionId);

    if (!routes) {
      // No routes configured, fall through to normal function execution
      return null;
    }

    // Match request path against routes
    const match = this.matcher.match(request.path, routes);

    if (!match) {
      // No route matched, fall through to normal function execution
      return null;
    }

    // Build target URL
    const targetUrl = this.matcher.buildTargetUrl(match);

    try {
      // Proxy the request
      return await this.proxy.proxy(match, request, targetUrl);
    } catch (error) {
      // Handle proxy errors
      if (error instanceof ProxyError) {
        // Return error response
        return {
          status: error.statusCode,
          statusText: error.message,
          headers: {
            'content-type': 'application/json',
          },
          body: {
            error: error.message,
            target: targetUrl,
          },
        };
      }

      // Re-throw unexpected errors
      throw error;
    }
  }

  /**
   * Invalidate cache for a function
   * Call this when routes are updated
   */
  invalidateCache(functionId: string): void {
    this.cache.invalidate(functionId);
  }

  /**
   * Clear all route caches
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get router statistics
   */
  getStats() {
    return {
      cache: this.cache.getStats(),
    };
  }

  /**
   * Cleanup expired cache entries
   */
  cleanup(): number {
    return this.cache.cleanup();
  }
}
