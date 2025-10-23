# Route Configuration API

This document describes the native routing/proxy feature for Alternate Futures Functions. This feature allows you to configure route mappings directly in your function configuration without needing external packages.

## Overview

The route configuration feature enables you to define path-based routing rules that map incoming request paths to target URLs. This is useful for:

- Creating API gateways
- Proxying requests to multiple backend services
- Implementing service mesh patterns
- Path-based routing and load distribution

## Data Model

### Prisma Schema

The `AFFunction` model includes an optional `routes` field that stores route configuration as JSON:

```prisma
model AFFunction {
  id                  String               @id @default(cuid())
  name                String
  slug                String               @unique
  invokeUrl           String?
  routes              Json?                // Route configuration
  status              FunctionStatus       @default(ACTIVE)
  // ... other fields
}
```

### Route Configuration Format

Routes are defined as a JSON object where:
- **Keys**: Path patterns (must start with `/`)
- **Values**: Target URLs (must be valid HTTP/HTTPS URLs)

Example:
```json
{
  "/api/users/*": "https://users-service.com",
  "/api/products/*": "https://products-service.com",
  "/*": "https://default.com"
}
```

## GraphQL API

### Types

```graphql
scalar JSON

type AFFunction {
  id: ID!
  name: String!
  slug: String!
  invokeUrl: String
  routes: JSON          # Route configuration
  status: FunctionStatus!
  # ... other fields
}
```

### Mutations

#### Create Function with Routes

```graphql
mutation CreateFunction {
  createAFFunction(
    name: "API Gateway"
    routes: {
      "/api/users/*": "https://users-service.com"
      "/api/products/*": "https://products-service.com"
      "/*": "https://default.com"
    }
  ) {
    id
    name
    routes
  }
}
```

#### Update Function Routes

```graphql
mutation UpdateRoutes {
  updateAFFunction(
    id: "func-123"
    routes: {
      "/v2/api/*": "https://v2-api.com"
      "/*": "https://default.com"
    }
  ) {
    id
    routes
  }
}
```

#### Clear Routes

To remove all route configuration, set routes to `null`:

```graphql
mutation ClearRoutes {
  updateAFFunction(
    id: "func-123"
    routes: null
  ) {
    id
    routes
  }
}
```

## Validation Rules

The route configuration is validated according to these rules:

### Path Patterns

1. **Must start with `/`**: All path patterns must begin with a forward slash
   ```javascript
   // ✓ Valid
   "/api/users/*"
   "/products"
   "/*"

   // ✗ Invalid
   "api/users"    // Missing leading slash
   "users/*"      // Missing leading slash
   ```

2. **Wildcards supported**: Use `*` for wildcard matching
   ```javascript
   "/api/*"           // Matches /api/anything
   "/users/*/posts"   // Matches /users/123/posts
   "/*"               // Matches all paths
   ```

### Target URLs

1. **Must be valid URLs**: Target must be a properly formatted URL
   ```javascript
   // ✓ Valid
   "https://example.com"
   "http://localhost:3000"
   "https://api.example.com/base/path"

   // ✗ Invalid
   "not-a-url"
   "example.com"     // Missing protocol
   ```

2. **Must use HTTP/HTTPS**: Only HTTP and HTTPS protocols are allowed
   ```javascript
   // ✓ Valid
   "http://example.com"
   "https://example.com"

   // ✗ Invalid
   "ftp://example.com"
   "ws://example.com"
   ```

3. **Query parameters allowed**: Target URLs can include query parameters
   ```javascript
   "https://example.com/api?key=value&foo=bar"
   ```

### General Rules

1. **Must be an object**: Routes must be a JSON object (not an array or primitive)
2. **Cannot be empty**: If provided, routes object must have at least one entry
3. **Keys must be strings**: All path patterns must be strings
4. **Values must be strings**: All target URLs must be strings

## Error Handling

The API will throw `GraphQLError` exceptions for invalid route configurations:

```javascript
// Empty routes object
{
  "errors": [{
    "message": "Routes object cannot be empty"
  }]
}

// Invalid path pattern
{
  "errors": [{
    "message": "Invalid path pattern \"api/users\". Path patterns must start with \"/\""
  }]
}

// Invalid URL
{
  "errors": [{
    "message": "Invalid target URL \"not-a-url\" for path \"/api\". Must be a valid URL"
  }]
}

// Invalid protocol
{
  "errors": [{
    "message": "Invalid target URL \"ftp://example.com\" for path \"/api\". Must use http:// or https:// protocol"
  }]
}
```

## Examples

### Simple API Gateway

Route requests to different microservices:

```graphql
mutation CreateGateway {
  createAFFunction(
    name: "API Gateway"
    routes: {
      "/api/users/*": "https://users.example.com"
      "/api/products/*": "https://products.example.com"
      "/api/orders/*": "https://orders.example.com"
      "/*": "https://default.example.com"
    }
  ) {
    id
    invokeUrl
    routes
  }
}
```

### Version-based Routing

Route requests to different API versions:

```graphql
mutation CreateVersionRouter {
  createAFFunction(
    name: "Version Router"
    routes: {
      "/v1/*": "https://api-v1.example.com"
      "/v2/*": "https://api-v2.example.com"
      "/v3/*": "https://api-v3.example.com"
      "/*": "https://api-v3.example.com"
    }
  ) {
    id
    routes
  }
}
```

### Legacy Path Support

Handle legacy paths while migrating to new endpoints:

```graphql
mutation CreateLegacyRouter {
  createAFFunction(
    name: "Legacy Router"
    routes: {
      "/old/api/*": "https://legacy.example.com"
      "/new/api/*": "https://modern.example.com"
      "/*": "https://modern.example.com"
    }
  ) {
    id
    routes
  }
}
```

## Implementation Notes

### Validation Utility

Route validation is handled by the `routeValidation.ts` utility:

```typescript
import { validateRoutes, normalizeRoutes } from '../utils/routeValidation.js';

// Validate routes
validateRoutes(routes); // Throws GraphQLError if invalid

// Normalize and validate
const normalizedRoutes = normalizeRoutes(routes); // Returns null or validated routes
```

### Resolver Integration

Routes are validated in both `createAFFunction` and `updateAFFunction` mutations before database operations:

```typescript
// In createAFFunction
if (routes) {
  validateRoutes(routes);
}

// In updateAFFunction
if (routes !== undefined && routes !== null) {
  validateRoutes(routes);
}
```

## Testing

Comprehensive test coverage is provided in:
- `src/utils/routeValidation.test.ts` - Validation logic tests (16 tests)
- `src/resolvers/routeConfiguration.test.ts` - Resolver integration tests (13 tests)

Run tests with:
```bash
npm test
npm run test:watch    # Watch mode
npm run test:coverage # With coverage report
```

## Future Enhancements

Potential future improvements to the route configuration feature:

1. **Method-based routing**: Route based on HTTP methods (GET, POST, etc.)
2. **Header-based routing**: Route based on request headers
3. **Rate limiting**: Per-route rate limiting configuration
4. **Authentication**: Per-route authentication requirements
5. **Caching**: Per-route caching policies
6. **Load balancing**: Multiple target URLs with load balancing strategies
7. **Regex patterns**: Support regex patterns in addition to wildcards
8. **Route priorities**: Explicit ordering when patterns overlap

## Related Issues

- Linear Issue: ALT-7 - Implement native routing/proxy feature for Functions
