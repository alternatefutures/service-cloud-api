# ALT-7: Native Routing Implementation Status

## Overview

This document tracks the implementation status of the native routing/proxy feature for Alternate Futures Functions (ALT-7).

## Completed Work

### 1. Backend API (✅ Complete)
**Repository:** `alternatefutures-backend`
**Branch:** `feature/function-routing`
**Commit:** 404eeb3

- ✅ Added `routes` JSON field to AFFunction Prisma model
- ✅ Added JSON scalar to GraphQL schema
- ✅ Updated AFFunction type with routes field
- ✅ Modified `createAFFunction` mutation to accept routes
- ✅ Modified `updateAFFunction` mutation to support routes
- ✅ Created comprehensive route validation utility
- ✅ Implemented validation for path patterns (must start with "/")
- ✅ Implemented validation for target URLs (must be HTTP/HTTPS)
- ✅ Added 29 passing tests (16 validation + 13 resolver tests)
- ✅ Created complete API documentation

**Route Format:**
```json
{
  "/api/users/*": "https://users-service.com",
  "/api/products/*": "https://products-service.com",
  "/*": "https://default.com"
}
```

### 2. SDK Support (✅ Complete)
**Repository:** `cloud-sdk`
**Branch:** `develop`
**Commit:** bc7a527

- ✅ Added `routes` parameter to CreateAFFunctionArgs type
- ✅ Added `routes` parameter to UpdateAFFunctionArgs type
- ✅ Updated AFFunction mapped properties to include routes
- ✅ Modified create mutation to pass routes
- ✅ Modified update mutation to pass routes
- ✅ Added test cases for route operations

### 3. GraphQL Client Schema (✅ Complete)
**Location:** `local-packages/@alternatefutures-utils-genql-client`

- ✅ Updated AFFunction type definition with `routes: JSON`
- ✅ Updated CreateAFFunctionDataInput with routes field
- ✅ Updated UpdateAFFunctionDataInput with routes field
- ✅ Regenerated TypeScript types with genql

## Remaining Work

### 4. GraphQL Client Package (⏳ Pending)
**Action Required:** Regenerate and publish utils-genql-client package

The genql client schema has been updated locally but needs to be:
1. Regenerated from the backend's deployed GraphQL schema
2. Published as a new version of `@alternatefutures/utils-genql-client`
3. SDK updated to use the new genql client version

**Current Status:** Local schema updated, needs proper regeneration workflow

### 5. CLI Support (⏳ Pending)
**Repository:** `cloud-cli`

**Required Changes:**
- Add `--routes` option to `functions create` command
- Add `--routes` option to `functions update` command
- Support routes in `af.config.js` file format
- Add route validation in CLI before sending to API
- Update function deployment flow to handle routes
- Add CLI tests for route commands

**Example CLI Usage:**
```bash
# Create function with routes from JSON string
af functions create --name api-gateway --routes '{""/api/*"": ""https://api.example.com""}'

# Create function with routes from config file
# af.config.js:
export default {
  name: 'my-gateway',
  type: 'function',
  routes: {
    '/api/users/*': 'https://users-service.com',
    '/api/products/*': 'https://products-service.com',
    '/*': 'https://default.com'
  }
}
```

### 6. Runtime Implementation (⏳ Pending)
**Critical:** This is the core functionality that makes routes work

**Required Changes:**
1. **Route Resolution Logic**
   - Implement path pattern matching (wildcards, exact matches)
   - Support path parameters (e.g., `/users/:id/*`)
   - Implement route priority/ordering
   - Handle overlapping patterns

2. **Request Proxying**
   - Fetch route configuration from database on function invocation
   - Match incoming request path against configured routes
   - Proxy request to target URL
   - Forward headers, query parameters, body
   - Return proxied response to client

3. **Runtime Injection**
   - Inject routing logic into Function runtime
   - Cache route configuration for performance
   - Handle route updates without function redeployment
   - Support both SGX and non-SGX functions

4. **Error Handling**
   - Handle missing routes (default behavior)
   - Handle proxy failures
   - Provide meaningful error messages
   - Timeout handling

**Example Runtime Pseudocode:**
```typescript
// Function runtime entry point
async function handleRequest(request, functionId) {
  // 1. Load function configuration including routes
  const config = await loadFunctionConfig(functionId);

  if (config.routes) {
    // 2. Match request path against routes
    const match = matchRoute(request.path, config.routes);

    if (match) {
      // 3. Proxy to target URL
      const targetUrl = buildTargetUrl(match.target, request);
      return await proxyRequest(targetUrl, request);
    }
  }

  // 4. Fall through to user's function code if no route matches
  return await executeUserFunction(request);
}
```

### 7. Dashboard UI (⏳ Pending - Waiting on Designs)
**Assignee:** Amy (Frontend)

**Required Features:**
- Routes configuration UI on Functions detail page
- Add/Edit/Delete route mappings
- Visual route editor with validation
- Test route patterns
- Display current active routes
- Route reordering (for priority)

**Waiting On:**
- UI/UX designs for route configuration interface
- Design decisions on route editor UX

## Implementation Priority

1. **High Priority:**
   - Runtime implementation (blocks all functionality)
   - CLI support (needed for developer workflow)

2. **Medium Priority:**
   - Genql client regeneration and publish
   - Dashboard UI (depends on designs)

3. **Future Enhancements:**
   - Method-based routing (GET, POST, etc.)
   - Header-based routing
   - Rate limiting per route
   - Authentication per route
   - Route-level caching policies
   - Load balancing across multiple targets
   - Regex pattern support
   - Route analytics and monitoring

## Testing Strategy

### Backend (✅ Complete)
- 29/29 tests passing
- Validation tests
- Resolver integration tests

### SDK (✅ Complete)
- Type definitions validated
- Build successful

### Runtime (⏳ Pending)
- Unit tests for route matching
- Integration tests for proxying
- E2E tests for full request flow
- Performance tests for route lookup

### CLI (⏳ Pending)
- Command option tests
- Config file parsing tests
- Validation tests

## Documentation

- ✅ Backend API documentation (`docs/route-configuration.md`)
- ⏳ Runtime implementation guide (needed)
- ⏳ CLI usage guide (needed)
- ⏳ Dashboard UI guide (needed after implementation)

## Related Issues

- Linear: ALT-7 - Implement native routing/proxy feature for Functions
- Backend PR: `feature/function-routing` branch
- SDK Commit: bc7a527

## Notes

- Backend changes are deployed behind feature flag until runtime is implemented
- Routes are stored but not yet functional until runtime implementation
- Validation ensures data integrity even before runtime is ready
- Design allows for future enhancements without schema changes
