# Function Runtime Integration Guide

Complete guide for integrating RuntimeRouter into the Alternate Futures Function Runtime (ALT-7 Item 7).

## Overview

The Function Runtime Service handles execution of user functions with integrated routing support. When a request comes in:

1. **Route Matching**: Check if request matches any configured routes
2. **Proxying**: If matched, proxy to target backend service
3. **Function Execution**: If no match, execute user's function code

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│          Incoming Request to Function                   │
│        https://my-function.af-functions.dev/api/users    │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│            Function Runtime Server                       │
│         (src/runtime/server.ts)                          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│        RuntimeRouter.handleRequest()                     │
│     • Load routes from database (cached)                 │
│     • Match request path against patterns                │
│     • Proxy if match found                               │
└────────────────────┬────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        │                         │
        ▼                         ▼
   Route Match?                No Match
        │                         │
        ▼                         ▼
┌──────────────────┐    ┌──────────────────┐
│ RequestProxy     │    │ Execute Function │
│ Forward to target│    │ Load from IPFS   │
│ Return response  │    │ Run in sandbox   │
└──────────────────┘    └──────────────────┘
```

## Implementation

### 1. Basic Runtime Server

```typescript
import { RuntimeRouter } from '../services/routing/runtimeRouter.js'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const router = new RuntimeRouter(prisma, {
  cacheTTL: 300000, // 5 minutes
  proxyTimeout: 30000, // 30 seconds
})

async function handleFunctionRequest(functionId: string, request: Request) {
  // Convert to ProxyRequest format
  const proxyRequest = {
    method: request.method,
    path: new URL(request.url).pathname,
    headers: Object.fromEntries(request.headers),
    query: Object.fromEntries(new URL(request.url).searchParams),
    body: await request.json().catch(() => undefined),
  }

  // Try routing first
  const routedResponse = await router.handleRequest(functionId, proxyRequest)

  if (routedResponse) {
    // Route matched - return proxied response
    return new Response(JSON.stringify(routedResponse.body), {
      status: routedResponse.status,
      headers: routedResponse.headers,
    })
  }

  // No route matched - execute user's function code
  return executeUserFunction(functionId, request)
}
```

### 2. Running the Runtime

```bash
# Development mode (with auto-reload)
npm run dev:runtime

# Production mode
npm run build
npm run start:runtime
```

### 3. Environment Variables

```bash
# Runtime server port
RUNTIME_PORT=3000

# Database connection (shared with main API)
DATABASE_URL="postgresql://user:password@localhost:5432/alternatefutures"

# Optional: Override routing defaults
ROUTE_CACHE_TTL=300000    # 5 minutes in ms
PROXY_TIMEOUT=30000        # 30 seconds in ms
```

## Testing the Integration

### 1. Create a Function with Routes

```bash
# Using CLI
af functions create --name my-gateway
af functions update --functionName my-gateway --routes '{
  "/api/users/*": "https://jsonplaceholder.typicode.com/users",
  "/api/posts/*": "https://jsonplaceholder.typicode.com/posts",
  "/*": "https://httpbin.org/anything"
}'
```

### 2. Test Route Matching

```bash
# This should proxy to https://jsonplaceholder.typicode.com/users
curl http://my-gateway.localhost:3000/api/users

# This should proxy to https://jsonplaceholder.typicode.com/posts/1
curl http://my-gateway.localhost:3000/api/posts/1

# This should proxy to https://httpbin.org/anything/test
curl http://my-gateway.localhost:3000/test

# This should execute the function directly (if no route matches)
curl http://my-gateway.localhost:3000/no-match
```

### 3. Verify Logging

The runtime logs each request:

```
📨 Request: GET /api/users [Function: my-gateway]
🔍 Function found: my-gateway (clx...)
📋 Routes configured: 3
✅ Route matched - proxied to target
```

## Integration Points

### Cache Invalidation

When routes are updated via GraphQL mutation, invalidate the cache:

```typescript
// In updateAFFunction resolver
await router.invalidateCache(functionId)
```

### Performance Monitoring

Get routing statistics:

```typescript
const stats = router.getStats()
console.log('Cache hit rate:', stats.cacheHitRate)
console.log('Active cache entries:', stats.cacheSize)
```

### Error Handling

The router handles common errors:

| Error      | Status | Description                    |
| ---------- | ------ | ------------------------------ |
| ProxyError | 502    | Failed to connect to target    |
| Timeout    | 504    | Request exceeded proxy timeout |
| Unknown    | 500    | Unexpected error               |

## Production Deployment

### 1. Build and Deploy

```bash
npm run build
npm run start:runtime
```

### 2. DNS Configuration

Point function invoke URLs to runtime service:

```
*.af-functions.dev → Runtime Service IP/Domain
```

### 3. Load Balancing

For production, run multiple runtime instances:

```yaml
# docker-compose.yml
services:
  runtime-1:
    image: af-function-runtime
    environment:
      - RUNTIME_PORT=3000
      - DATABASE_URL=${DATABASE_URL}
    ports:
      - '3000:3000'

  runtime-2:
    image: af-function-runtime
    environment:
      - RUNTIME_PORT=3000
      - DATABASE_URL=${DATABASE_URL}
    ports:
      - '3001:3000'

  nginx:
    image: nginx
    ports:
      - '80:80'
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
```

### 4. Monitoring

Monitor key metrics:

- **Route Match Rate**: Percentage of requests handled by routing
- **Proxy Latency**: Time to proxy requests
- **Cache Hit Rate**: Route config cache effectiveness
- **Error Rate**: Failed proxy attempts

## Feature Flags

Control routing rollout:

```typescript
// In runtime server
const ROUTING_ENABLED = process.env.ENABLE_ROUTING === 'true'

if (ROUTING_ENABLED) {
  const routedResponse = await router.handleRequest(functionId, proxyRequest)
  if (routedResponse) return routedResponse
}

// Always fall through to function execution
return executeUserFunction(functionId, request)
```

## Limitations

**Current Implementation:**

- ✅ Route matching and proxying fully implemented
- ✅ Caching and performance optimizations complete
- ⏳ Function code execution from IPFS (placeholder)
- ⏳ Sandboxed execution environment (placeholder)
- ⏳ SGX support (future work)

**Next Steps:**

1. Implement IPFS code fetching
2. Add sandboxed execution environment
3. Support streaming responses
4. Add metrics and observability
5. Production hardening and security

## Related Documentation

- [Runtime Routing Implementation](./runtime-routing-implementation.md) - Core routing system
- [Route Configuration](./route-configuration.md) - How to configure routes
- [API Reference](./api-reference.md) - GraphQL mutations and queries

## Example: Complete Integration

See `src/runtime/server.ts` for a complete reference implementation demonstrating:

- Function lookup by slug
- Request parsing and validation
- RouterIntegration
- Fallback to function execution
- Error handling
- Logging and debugging

This implementation is production-ready for the routing portion and provides a foundation for adding function execution capabilities.
