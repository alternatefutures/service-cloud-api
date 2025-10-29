import { describe, it, expect, beforeEach } from 'vitest';
import { RouteMatcher } from './routeMatcher.js';
import type { RouteConfig } from '../../utils/routeValidation.js';

describe('RouteMatcher', () => {
  let matcher: RouteMatcher;

  beforeEach(() => {
    matcher = new RouteMatcher();
  });

  describe('exact path matching', () => {
    it('should match exact paths', () => {
      const routes: RouteConfig = {
        '/api/users': 'https://users.example.com',
      };

      const match = matcher.match('/api/users', routes);

      expect(match).toEqual({
        target: 'https://users.example.com',
        pathPattern: '/api/users',
        matchedPath: '/api/users',
        wildcardPath: undefined,
      });
    });

    it('should not match partial paths', () => {
      const routes: RouteConfig = {
        '/api/users': 'https://users.example.com',
      };

      const match = matcher.match('/api/users/123', routes);

      expect(match).toBeNull();
    });

    it('should not match if path differs', () => {
      const routes: RouteConfig = {
        '/api/users': 'https://users.example.com',
      };

      const match = matcher.match('/api/products', routes);

      expect(match).toBeNull();
    });
  });

  describe('wildcard matching', () => {
    it('should match wildcard patterns', () => {
      const routes: RouteConfig = {
        '/api/*': 'https://api.example.com',
      };

      const match = matcher.match('/api/users/123', routes);

      expect(match).toEqual({
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users/123',
        wildcardPath: 'users/123',
      });
    });

    it('should match root wildcard', () => {
      const routes: RouteConfig = {
        '/*': 'https://default.example.com',
      };

      const match = matcher.match('/anything/goes/here', routes);

      expect(match).toEqual({
        target: 'https://default.example.com',
        pathPattern: '/*',
        matchedPath: '/anything/goes/here',
        wildcardPath: 'anything/goes/here',
      });
    });

    it('should extract wildcard path correctly', () => {
      const routes: RouteConfig = {
        '/api/v1/*': 'https://api.example.com',
      };

      const match = matcher.match('/api/v1/users/123/profile', routes);

      expect(match?.wildcardPath).toBe('users/123/profile');
    });
  });

  describe('route specificity and priority', () => {
    it('should prioritize exact matches over wildcards', () => {
      const routes: RouteConfig = {
        '/*': 'https://default.example.com',
        '/api/users': 'https://users.example.com',
      };

      const match = matcher.match('/api/users', routes);

      expect(match?.target).toBe('https://users.example.com');
      expect(match?.pathPattern).toBe('/api/users');
    });

    it('should prioritize more specific wildcards', () => {
      const routes: RouteConfig = {
        '/*': 'https://default.example.com',
        '/api/*': 'https://api.example.com',
        '/api/users/*': 'https://users.example.com',
      };

      const match = matcher.match('/api/users/123', routes);

      expect(match?.target).toBe('https://users.example.com');
      expect(match?.pathPattern).toBe('/api/users/*');
    });

    it('should use fallback route when no specific match', () => {
      const routes: RouteConfig = {
        '/api/*': 'https://api.example.com',
        '/*': 'https://default.example.com',
      };

      const match = matcher.match('/homepage', routes);

      expect(match?.target).toBe('https://default.example.com');
      expect(match?.pathPattern).toBe('/*');
    });

    it('should prioritize longer paths over shorter paths', () => {
      const routes: RouteConfig = {
        '/api/*': 'https://api.example.com',
        '/api/v2/*': 'https://api-v2.example.com',
        '/api/v2/users/*': 'https://users-v2.example.com',
      };

      const match = matcher.match('/api/v2/users/123', routes);

      expect(match?.target).toBe('https://users-v2.example.com');
      expect(match?.pathPattern).toBe('/api/v2/users/*');
    });
  });

  describe('buildTargetUrl', () => {
    it('should build URL without wildcard', () => {
      const match = {
        target: 'https://users.example.com',
        pathPattern: '/api/users',
        matchedPath: '/api/users',
        wildcardPath: undefined,
      };

      const url = matcher.buildTargetUrl(match);

      expect(url).toBe('https://users.example.com');
    });

    it('should append wildcard path to target', () => {
      const match = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users/123',
        wildcardPath: 'users/123',
      };

      const url = matcher.buildTargetUrl(match);

      expect(url).toBe('https://api.example.com/users/123');
    });

    it('should handle target URL with trailing slash', () => {
      const match = {
        target: 'https://api.example.com/',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      };

      const url = matcher.buildTargetUrl(match);

      expect(url).toBe('https://api.example.com/users');
    });

    it('should handle wildcard path without leading slash', () => {
      const match = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: 'users',
      };

      const url = matcher.buildTargetUrl(match);

      expect(url).toBe('https://api.example.com/users');
    });

    it('should handle wildcard path with leading slash', () => {
      const match = {
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users',
        wildcardPath: '/users',
      };

      const url = matcher.buildTargetUrl(match);

      expect(url).toBe('https://api.example.com/users');
    });
  });

  describe('edge cases', () => {
    it('should return null for empty routes', () => {
      const routes: RouteConfig = {};

      const match = matcher.match('/api/users', routes);

      expect(match).toBeNull();
    });

    it('should return null when no routes match', () => {
      const routes: RouteConfig = {
        '/api/users': 'https://users.example.com',
        '/api/products': 'https://products.example.com',
      };

      const match = matcher.match('/api/orders', routes);

      expect(match).toBeNull();
    });

    it('should handle paths with query parameters', () => {
      const routes: RouteConfig = {
        '/api/*': 'https://api.example.com',
      };

      const match = matcher.match('/api/users?page=1', routes);

      expect(match).toEqual({
        target: 'https://api.example.com',
        pathPattern: '/api/*',
        matchedPath: '/api/users?page=1',
        wildcardPath: 'users?page=1',
      });
    });

    it('should handle root path', () => {
      const routes: RouteConfig = {
        '/*': 'https://default.example.com',
      };

      const match = matcher.match('/', routes);

      expect(match).toEqual({
        target: 'https://default.example.com',
        pathPattern: '/*',
        matchedPath: '/',
        wildcardPath: '',
      });
    });
  });

  describe('multiple route scenarios', () => {
    it('should handle complex routing setup', () => {
      const routes: RouteConfig = {
        '/api/auth/login': 'https://auth.example.com/login',
        '/api/auth/*': 'https://auth.example.com',
        '/api/users/*': 'https://users.example.com',
        '/api/products/*': 'https://products.example.com',
        '/api/*': 'https://api.example.com',
        '/*': 'https://default.example.com',
      };

      // Exact match
      expect(matcher.match('/api/auth/login', routes)?.target).toBe(
        'https://auth.example.com/login'
      );

      // Auth wildcard
      expect(matcher.match('/api/auth/logout', routes)?.target).toBe('https://auth.example.com');

      // Users wildcard
      expect(matcher.match('/api/users/123', routes)?.target).toBe('https://users.example.com');

      // API fallback
      expect(matcher.match('/api/unknown', routes)?.target).toBe('https://api.example.com');

      // Root fallback
      expect(matcher.match('/homepage', routes)?.target).toBe('https://default.example.com');
    });
  });
});
