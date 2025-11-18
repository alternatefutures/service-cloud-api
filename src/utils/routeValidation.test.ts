import { describe, it, expect } from 'vitest'
import { validateRoutes, normalizeRoutes } from './routeValidation.js'
import { GraphQLError } from 'graphql'

describe('Route Validation', () => {
  describe('validateRoutes', () => {
    it('should accept valid route configuration', () => {
      const validRoutes = {
        '/api/users/*': 'https://users-service.com',
        '/api/products/*': 'https://products-service.com',
        '/*': 'https://default.com',
      }

      expect(() => validateRoutes(validRoutes)).not.toThrow()
    })

    it('should accept null or undefined routes', () => {
      expect(() => validateRoutes(null)).not.toThrow()
      expect(() => validateRoutes(undefined)).not.toThrow()
    })

    it('should reject non-object routes', () => {
      expect(() => validateRoutes('invalid')).toThrow(GraphQLError)
      expect(() => validateRoutes(123)).toThrow(GraphQLError)
      expect(() => validateRoutes(true)).toThrow(GraphQLError)
    })

    it('should reject array as routes', () => {
      expect(() => validateRoutes([])).toThrow(GraphQLError)
      expect(() => validateRoutes(['/path', 'url'])).toThrow(GraphQLError)
    })

    it('should reject empty routes object', () => {
      expect(() => validateRoutes({})).toThrow(GraphQLError)
      expect(() => validateRoutes({})).toThrow('Routes object cannot be empty')
    })

    it('should reject path patterns not starting with /', () => {
      const invalidRoutes = {
        'api/users': 'https://example.com',
      }

      expect(() => validateRoutes(invalidRoutes)).toThrow(GraphQLError)
      expect(() => validateRoutes(invalidRoutes)).toThrow('must start with "/"')
    })

    it('should reject non-string target URLs', () => {
      const invalidRoutes = {
        '/api': 123 as any,
      }

      expect(() => validateRoutes(invalidRoutes)).toThrow(GraphQLError)
      expect(() => validateRoutes(invalidRoutes)).toThrow(
        'Target must be a string'
      )
    })

    it('should reject invalid URL format', () => {
      const invalidRoutes = {
        '/api': 'not-a-url',
      }

      expect(() => validateRoutes(invalidRoutes)).toThrow(GraphQLError)
      expect(() => validateRoutes(invalidRoutes)).toThrow('Must be a valid URL')
    })

    it('should reject URLs without http/https protocol', () => {
      const invalidRoutes = {
        '/api': 'ftp://example.com',
      }

      expect(() => validateRoutes(invalidRoutes)).toThrow(GraphQLError)
      expect(() => validateRoutes(invalidRoutes)).toThrow(
        'Must use http:// or https:// protocol'
      )
    })

    it('should accept routes with wildcards', () => {
      const validRoutes = {
        '/api/*': 'https://example.com',
        '/users/*/profile': 'https://profiles.com',
        '/*': 'https://default.com',
      }

      expect(() => validateRoutes(validRoutes)).not.toThrow()
    })

    it('should accept routes with query parameters in target URL', () => {
      const validRoutes = {
        '/api': 'https://example.com?key=value',
      }

      expect(() => validateRoutes(validRoutes)).not.toThrow()
    })

    it('should accept routes with path in target URL', () => {
      const validRoutes = {
        '/api': 'https://example.com/some/path',
      }

      expect(() => validateRoutes(validRoutes)).not.toThrow()
    })

    it('should accept both http and https protocols', () => {
      const validRoutes = {
        '/api1': 'http://example.com',
        '/api2': 'https://example.com',
      }

      expect(() => validateRoutes(validRoutes)).not.toThrow()
    })
  })

  describe('normalizeRoutes', () => {
    it('should return null for null or undefined input', () => {
      expect(normalizeRoutes(null)).toBeNull()
      expect(normalizeRoutes(undefined)).toBeNull()
    })

    it('should return validated routes for valid input', () => {
      const validRoutes = {
        '/api/*': 'https://example.com',
      }

      const result = normalizeRoutes(validRoutes)
      expect(result).toEqual(validRoutes)
    })

    it('should throw for invalid routes', () => {
      const invalidRoutes = {
        invalid: 'not-a-url',
      }

      expect(() => normalizeRoutes(invalidRoutes)).toThrow(GraphQLError)
    })
  })
})
