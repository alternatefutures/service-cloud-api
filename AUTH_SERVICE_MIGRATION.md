# Auth Service Migration Plan (ALT-92)

## Overview

Migrate Personal Access Token (PAT) authentication from `alternatefutures-backend` to `alternatefutures-auth` to establish a single source of truth for all authentication concerns.

## Current Architecture

```
┌─────────────────────────────────────┐
│   alternatefutures-backend          │
│                                      │
│   • Personal Access Tokens (PATs)   │
│   • Token validation                │
│   • Rate limiting                   │
│   • User management (partial)       │
│   • GraphQL API                     │
└─────────────────────────────────────┘
```

## Target Architecture

```
┌──────────────────────────────────────────────┐
│           alternatefutures-auth              │
│                                               │
│   • User Authentication (Email, SMS, Web3)   │
│   • JWT Sessions                             │
│   • Personal Access Tokens (PATs)  ← NEW    │
│   • Token validation               ← NEW    │
│   • Rate limiting                  ← NEW    │
│   • Unified user identity                    │
└──────────────────────────────────────────────┘
                       ↓ (validates tokens)
┌──────────────────────────────────────────────┐
│        alternatefutures-backend              │
│                                               │
│   • GraphQL API                              │
│   • Business logic                           │
│   • Calls auth service for validation        │
└──────────────────────────────────────────────┘
```

## Migration Steps

### Phase 1: Prepare Auth Service

#### 1.1. Copy PAT functionality to alternatefutures-auth

**Files to copy/adapt:**
- `src/services/auth/tokenService.ts` → Copy token generation, validation, cleanup
- `src/services/auth/rateLimiter.ts` → Copy rate limiting logic
- `src/services/auth/logger.ts` → Copy structured logging
- `src/jobs/cleanupExpiredTokens.ts` → Copy cleanup job

#### 1.2. Add PAT database schema to auth service

**Prisma schema additions:**
```prisma
model PersonalAccessToken {
  id         String    @id @default(cuid())
  name       String
  token      String    @unique
  userId     String
  user       User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt  DateTime?
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  @@index([userId])
  @@index([userId, createdAt(sort: Desc)])
  @@index([expiresAt])
}
```

#### 1.3. Add PAT API endpoints to auth service

**New REST endpoints:**
```
POST   /api/tokens              # Create new PAT
GET    /api/tokens              # List user's PATs
DELETE /api/tokens/:id          # Delete PAT
POST   /api/tokens/validate     # Validate PAT (internal)
GET    /api/tokens/limits       # Get rate limits
```

#### 1.4. Add environment variables

**Auth service `.env`:**
```bash
# Redis for rate limiting
REDIS_URL=redis://localhost:6379

# Database
DATABASE_URL=postgresql://...

# JWT secrets (already exists)
JWT_SECRET=...
```

### Phase 2: Update Backend to Use Auth Service

#### 2.1. Update authentication middleware

**Current (`src/auth/middleware.ts`):**
```typescript
// Validates PATs directly from database
const pat = await prisma.personalAccessToken.findUnique({
  where: { token },
});
```

**New (calls auth service):**
```typescript
// Validates PATs via auth service API
const response = await fetch(`${AUTH_SERVICE_URL}/api/tokens/validate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ token }),
});
```

#### 2.2. Update GraphQL resolvers

**Current:** Resolvers directly manage PATs
**New:** Resolvers proxy requests to auth service

```typescript
// Example: createPersonalAccessToken resolver
const response = await fetch(`${AUTH_SERVICE_URL}/api/tokens`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${userJwt}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ name, expiresAt })
});
```

#### 2.3. Environment variables

**Backend `.env`:**
```bash
# Auth Service URL
AUTH_SERVICE_URL=http://localhost:3001  # Dev
# AUTH_SERVICE_URL=https://auth.alternatefutures.ai  # Prod

# Internal service secret for service-to-service auth
AUTH_SERVICE_SECRET=...
```

### Phase 3: Database Migration

#### 3.1. Data migration strategy

**Option A: Fresh start (recommended for development)**
- Deploy auth service with empty PAT table
- Users create new PATs via auth service
- Deprecate old PATs in backend

**Option B: Migrate existing data**
```sql
-- Export from backend
COPY personal_access_token TO '/tmp/pats.csv' CSV HEADER;

-- Import to auth service
COPY personal_access_token FROM '/tmp/pats.csv' CSV HEADER;
```

#### 3.2. Backwards compatibility period

Maintain both systems running in parallel for 1-2 weeks:
- Backend validates tokens locally (old PATs)
- Backend also accepts tokens from auth service (new PATs)
- Gradually migrate users to new PATs
- Deprecate old PAT system

### Phase 4: Remove Old Auth Code

After migration is complete and stable:

**Files to remove from backend:**
- `src/services/auth/tokenService.ts`
- `src/services/auth/rateLimiter.ts`
- `src/services/auth/logger.ts`
- `src/services/auth/index.ts`
- `src/jobs/cleanupExpiredTokens.ts`
- Tests: `src/services/auth/*.test.ts`

**Database schema changes:**
```prisma
// Remove from backend schema
model PersonalAccessToken {
  // ... remove entire model
}
```

**GraphQL schema changes:**
```graphql
# Update mutations to note they proxy to auth service
type Mutation {
  # Proxies to auth service
  createPersonalAccessToken(name: String!, expiresAt: Date): PersonalAccessTokenCreated!
  deletePersonalAccessToken(id: ID!): Boolean!
}
```

## Implementation Checklist

### Auth Service (alternatefutures-auth)

- [ ] Add PersonalAccessToken model to Prisma schema
- [ ] Copy token service with generation/validation logic
- [ ] Copy rate limiter with Redis support
- [ ] Copy structured logger
- [ ] Add REST API endpoints for PAT management
- [ ] Add token validation endpoint (internal)
- [ ] Add tests for PAT functionality
- [ ] Add cleanup job for expired tokens
- [ ] Update README with PAT documentation
- [ ] Deploy auth service to staging

### Backend (alternatefutures-backend)

- [ ] Add AUTH_SERVICE_URL environment variable
- [ ] Update auth middleware to call auth service
- [ ] Update GraphQL resolvers to proxy to auth service
- [ ] Add error handling for auth service unavailability
- [ ] Add fallback mechanism (optional)
- [ ] Update tests to mock auth service
- [ ] Update README to reference auth service
- [ ] Deploy backend to staging
- [ ] Test end-to-end authentication flow
- [ ] Monitor for 1-2 weeks
- [ ] Remove old auth code
- [ ] Remove PersonalAccessToken from schema
- [ ] Deploy to production

### Documentation

- [ ] Update API documentation
- [ ] Update deployment guides
- [ ] Create migration guide for users
- [ ] Update architecture diagrams
- [ ] Add auth service setup instructions

## Rollback Plan

If issues arise during migration:

1. **Immediate rollback:** Revert backend to validate PATs locally
2. **Database rollback:** Keep old PAT table until fully migrated
3. **Gradual rollback:** Disable auth service validation, fall back to local

## Testing Strategy

### Unit Tests
- Auth service: Test PAT creation, validation, rate limiting
- Backend: Test middleware with mocked auth service responses

### Integration Tests
- End-to-end: CLI → Backend → Auth Service
- Token validation flow
- Rate limiting across service boundary

### Load Tests
- Auth service under load (1000 req/s)
- Latency impact of service-to-service calls
- Redis performance for rate limiting

## Performance Considerations

### Latency
- **Before:** Local DB query (~5-10ms)
- **After:** HTTP call to auth service (~20-50ms)
- **Mitigation:** Cache validated tokens (5-minute TTL)

### Availability
- Auth service becomes critical dependency
- **Mitigation:** Implement circuit breaker pattern
- **Mitigation:** Local token cache for graceful degradation

### Cost
- Additional service to deploy (~$5-10/month)
- Redis for rate limiting (~$5/month)

## Timeline

- **Week 1:** Copy PAT functionality to auth service
- **Week 2:** Add API endpoints and tests
- **Week 3:** Update backend to call auth service
- **Week 4:** Deploy to staging and test
- **Week 5-6:** Parallel run with monitoring
- **Week 7:** Remove old auth code
- **Week 8:** Production deployment

## Success Metrics

- [ ] 100% of PAT validations routed through auth service
- [ ] <50ms p95 latency for token validation
- [ ] Zero authentication failures due to service issues
- [ ] All tests passing (528+ tests)
- [ ] Documentation updated

## Dependencies

- **alternatefutures-auth:** Must be deployed and accessible
- **Redis:** Required for rate limiting
- **Database:** Auth service needs its own database

## Security Considerations

- Service-to-service authentication (internal API key)
- Token storage security (hashed/encrypted in transit)
- Rate limiting to prevent abuse
- Audit logging for all PAT operations

## Next Steps

1. Review and approve this migration plan
2. Create Linear ticket (ALT-92)
3. Begin Phase 1 implementation
4. Regular progress updates

---

**Created:** 2025-11-06
**Status:** Planning
**Assignee:** TBD
**Linear Ticket:** ALT-92
