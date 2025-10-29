import type { RouteConfig } from '../../utils/routeValidation.js';

export interface RouteMatch {
  target: string;
  pathPattern: string;
  matchedPath: string;
  wildcardPath?: string;
}

/**
 * Route Matcher Service
 * Matches incoming request paths against configured route patterns
 */
export class RouteMatcher {
  /**
   * Convert a route pattern to a regex pattern
   * Supports:
   * - Exact matches: /api/users
   * - Wildcard matches: /api/users/*
   * - Path parameters: /api/users/:id
   */
  private patternToRegex(pattern: string): RegExp {
    // Escape special regex characters except * and :
    let regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      // Convert :param to named capture group
      .replace(/:(\w+)/g, '(?<$1>[^/]+)')
      // Convert * to match anything
      .replace(/\*/g, '.*');

    // Ensure pattern matches from start to end
    regexPattern = `^${regexPattern}$`;

    return new RegExp(regexPattern);
  }

  /**
   * Match a request path against a single route pattern
   */
  private matchPattern(requestPath: string, pattern: string): boolean {
    const regex = this.patternToRegex(pattern);
    return regex.test(requestPath);
  }

  /**
   * Extract wildcard path from a matched route
   * For pattern "/api/*" matching "/api/users/123"
   * Returns "/users/123"
   */
  private extractWildcardPath(requestPath: string, pattern: string): string | undefined {
    if (!pattern.includes('*')) {
      return undefined;
    }

    const patternPrefix = pattern.substring(0, pattern.indexOf('*'));
    if (requestPath.startsWith(patternPrefix)) {
      return requestPath.substring(patternPrefix.length);
    }

    return undefined;
  }

  /**
   * Sort routes by specificity (most specific first)
   * Priority order:
   * 1. Exact matches (no wildcards or params)
   * 2. Path parameter matches (/users/:id)
   * 3. Wildcard matches (/*)
   * 4. Root wildcard (/*)
   */
  private sortRoutesBySpecificity(routes: RouteConfig): Array<[string, string]> {
    const entries = Object.entries(routes);

    return entries.sort((a, b) => {
      const [patternA] = a;
      const [patternB] = b;

      // Count path segments
      const segmentsA = patternA.split('/').filter(Boolean).length;
      const segmentsB = patternB.split('/').filter(Boolean).length;

      // Exact matches (no special characters)
      const isExactA = !patternA.includes('*') && !patternA.includes(':');
      const isExactB = !patternB.includes('*') && !patternB.includes(':');

      if (isExactA && !isExactB) return -1;
      if (!isExactA && isExactB) return 1;

      // Path parameters (contains :)
      const hasParamsA = patternA.includes(':');
      const hasParamsB = patternB.includes(':');

      if (hasParamsA && !hasParamsB && !isExactB) return -1;
      if (!hasParamsA && hasParamsB && !isExactA) return 1;

      // More segments = more specific
      if (segmentsA !== segmentsB) {
        return segmentsB - segmentsA;
      }

      // Wildcards last
      const hasWildcardA = patternA.includes('*');
      const hasWildcardB = patternB.includes('*');

      if (hasWildcardA && !hasWildcardB) return 1;
      if (!hasWildcardA && hasWildcardB) return -1;

      // Same specificity, maintain insertion order
      return 0;
    });
  }

  /**
   * Match a request path against route configuration
   * Returns the first matching route based on specificity
   */
  match(requestPath: string, routes: RouteConfig): RouteMatch | null {
    if (!routes || Object.keys(routes).length === 0) {
      return null;
    }

    // Sort routes by specificity
    const sortedRoutes = this.sortRoutesBySpecificity(routes);

    // Find first matching route
    for (const [pathPattern, target] of sortedRoutes) {
      if (this.matchPattern(requestPath, pathPattern)) {
        const wildcardPath = this.extractWildcardPath(requestPath, pathPattern);

        return {
          target,
          pathPattern,
          matchedPath: requestPath,
          wildcardPath,
        };
      }
    }

    return null;
  }

  /**
   * Build target URL for a matched route
   * Appends wildcard path if present
   */
  buildTargetUrl(match: RouteMatch): string {
    const { target, wildcardPath } = match;

    // Remove trailing slash from target
    const baseTarget = target.replace(/\/$/, '');

    // Append wildcard path if present
    if (wildcardPath) {
      // Ensure wildcard path starts with /
      const normalizedWildcard = wildcardPath.startsWith('/')
        ? wildcardPath
        : `/${wildcardPath}`;

      return `${baseTarget}${normalizedWildcard}`;
    }

    return baseTarget;
  }
}
