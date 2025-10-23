import { GraphQLError } from 'graphql';

export interface RouteConfig {
  [pathPattern: string]: string;
}

/**
 * Validates a route configuration object
 * @param routes - The routes configuration to validate
 * @throws GraphQLError if validation fails
 */
export function validateRoutes(routes: any): void {
  if (!routes) {
    return;
  }

  // Check if routes is an object
  if (typeof routes !== 'object' || Array.isArray(routes)) {
    throw new GraphQLError('Routes must be an object mapping path patterns to target URLs');
  }

  const entries = Object.entries(routes);

  if (entries.length === 0) {
    throw new GraphQLError('Routes object cannot be empty');
  }

  for (const [pathPattern, targetUrl] of entries) {
    // Validate path pattern
    if (typeof pathPattern !== 'string' || !pathPattern.startsWith('/')) {
      throw new GraphQLError(
        `Invalid path pattern "${pathPattern}". Path patterns must start with "/"`
      );
    }

    // Validate target URL
    if (typeof targetUrl !== 'string') {
      throw new GraphQLError(
        `Invalid target URL for path "${pathPattern}". Target must be a string`
      );
    }

    // Validate URL format
    try {
      new URL(targetUrl);
    } catch (error) {
      throw new GraphQLError(
        `Invalid target URL "${targetUrl}" for path "${pathPattern}". Must be a valid URL`
      );
    }

    // Ensure URL has http or https protocol
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      throw new GraphQLError(
        `Invalid target URL "${targetUrl}" for path "${pathPattern}". Must use http:// or https:// protocol`
      );
    }
  }
}

/**
 * Validates and normalizes route configuration
 * @param routes - The routes configuration to normalize
 * @returns Normalized route configuration
 */
export function normalizeRoutes(routes: any): RouteConfig | null {
  if (!routes) {
    return null;
  }

  validateRoutes(routes);
  return routes as RouteConfig;
}
