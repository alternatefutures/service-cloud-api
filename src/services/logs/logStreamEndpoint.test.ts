/**
 * Tests for logStreamEndpoint.ts — focused on CORS header correctness.
 *
 * Issue #226: SSE endpoint was missing Access-Control-Allow-Origin, blocking
 * the Logs tab on app.alternatefutures.ai.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  LogStreamEndpoint,
  getCorsHeaders,
  getAllowedOrigins,
} from './logStreamEndpoint.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ALLOWED_ORIGIN = 'https://app.example.com'

function makeReq(
  origin?: string,
  extra: Partial<IncomingMessage> = {}
): IncomingMessage {
  const headers: Record<string, string> = {}
  if (origin) headers['origin'] = origin
  return {
    method: 'GET',
    url: '/sse/services/svc-123/logs?token=tok',
    headers,
    once: vi.fn(),
    ...extra,
  } as unknown as IncomingMessage
}

interface FakeRes {
  headersSent: boolean
  writableEnded: boolean
  statusCode?: number
  headers?: Record<string, string>
  body?: string
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  flushHeaders: ReturnType<typeof vi.fn>
  once: ReturnType<typeof vi.fn>
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    headersSent: false,
    writableEnded: false,
    writeHead: vi.fn(function (
      this: FakeRes,
      status: number,
      h?: Record<string, string>
    ) {
      this.statusCode = status
      this.headers = h
      this.headersSent = true
    }),
    end: vi.fn(function (this: FakeRes, body?: string) {
      this.body = body
      this.writableEnded = true
    }),
    write: vi.fn().mockReturnValue(true),
    flushHeaders: vi.fn(),
    once: vi.fn(),
  }
  res.writeHead = res.writeHead.bind(res)
  res.end = res.end.bind(res)
  return res
}

function makeSuccessAccess() {
  return {
    ok: true as const,
    userId: 'user-1',
    serviceId: 'svc-123',
    organizationId: 'org-1',
    service: {
      id: 'svc-123',
      parentServiceId: null as string | null,
      sdlServiceName: null as string | null,
      project: { userId: 'user-1', organizationId: 'org-1' },
    },
  }
}

function makeStream() {
  return {
    onLine: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    close: vi.fn(),
  }
}

function makePrisma(hasDeployment = true) {
  return {
    akashDeployment: {
      findFirst: vi
        .fn()
        .mockResolvedValue(hasDeployment ? { id: 'deploy-abc' } : null),
    },
    phalaDeployment: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
    spheronDeployment: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  } as unknown as Parameters<
    typeof LogStreamEndpoint.prototype.handle
  >[0] extends never
    ? never
    : any
}

// Base AF service origins that are always in the allowlist
const BASE_AF_ORIGINS = [
  'https://app.alternatefutures.ai',
  'https://api.alternatefutures.ai',
  'https://auth.alternatefutures.ai',
  'https://docs.alternatefutures.ai',
  'https://alternatefutures.ai',
]

// ---------------------------------------------------------------------------
// Unit tests for getAllowedOrigins()
// ---------------------------------------------------------------------------

describe('getAllowedOrigins', () => {
  afterEach(() => {
    delete process.env.APP_URL
    delete process.env.CORS_ALLOWED_ORIGINS
  })

  it('always includes all base AF service origins', () => {
    const origins = getAllowedOrigins()
    for (const o of BASE_AF_ORIGINS) {
      expect(origins).toContain(o)
    }
  })

  it('includes APP_URL when set and not already in base list', () => {
    process.env.APP_URL = 'https://staging.alternatefutures.ai'
    const origins = getAllowedOrigins()
    expect(origins).toContain('https://staging.alternatefutures.ai')
  })

  it('does not duplicate APP_URL when it equals an existing base origin', () => {
    process.env.APP_URL = 'https://app.alternatefutures.ai'
    const origins = getAllowedOrigins()
    expect(origins.filter(o => o === 'https://app.alternatefutures.ai')).toHaveLength(1)
  })

  it('includes comma-separated CORS_ALLOWED_ORIGINS entries', () => {
    process.env.CORS_ALLOWED_ORIGINS =
      'https://preview.alternatefutures.ai, https://beta.alternatefutures.ai'
    const origins = getAllowedOrigins()
    expect(origins).toContain('https://preview.alternatefutures.ai')
    expect(origins).toContain('https://beta.alternatefutures.ai')
  })
})

// ---------------------------------------------------------------------------
// Unit tests for getCorsHeaders()
// ---------------------------------------------------------------------------

describe('getCorsHeaders', () => {
  afterEach(() => {
    delete process.env.APP_URL
    delete process.env.CORS_ALLOWED_ORIGINS
  })

  it.each(BASE_AF_ORIGINS)(
    'returns CORS headers when Origin is base AF origin: %s',
    origin => {
      const req = makeReq(origin)
      const headers = getCorsHeaders(req)
      expect(headers['Access-Control-Allow-Origin']).toBe(origin)
      expect(headers['Access-Control-Allow-Credentials']).toBe('true')
      expect(headers['Access-Control-Allow-Methods']).toBe('GET')
    }
  )

  it('returns CORS headers when Origin matches APP_URL', () => {
    process.env.APP_URL = ALLOWED_ORIGIN
    const req = makeReq(ALLOWED_ORIGIN)
    const headers = getCorsHeaders(req)
    expect(headers['Access-Control-Allow-Origin']).toBe(ALLOWED_ORIGIN)
    expect(headers['Access-Control-Allow-Credentials']).toBe('true')
    expect(headers['Access-Control-Allow-Methods']).toBe('GET')
  })

  it('returns CORS headers when Origin is in CORS_ALLOWED_ORIGINS', () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://preview.alternatefutures.ai'
    const req = makeReq('https://preview.alternatefutures.ai')
    const headers = getCorsHeaders(req)
    expect(headers['Access-Control-Allow-Origin']).toBe(
      'https://preview.alternatefutures.ai'
    )
  })

  it('returns empty object when Origin header is absent (non-browser curl)', () => {
    const req = makeReq(undefined)
    expect(getCorsHeaders(req)).toEqual({})
  })

  it('returns empty object when Origin does not match allowlist', () => {
    const req = makeReq('https://evil.example.com')
    expect(getCorsHeaders(req)).toEqual({})
  })

  it('echoes the exact request origin back (not a hardcoded value)', () => {
    const req = makeReq('https://app.alternatefutures.ai')
    const headers = getCorsHeaders(req)
    expect(headers['Access-Control-Allow-Origin']).toBe(
      'https://app.alternatefutures.ai'
    )
  })
})

// ---------------------------------------------------------------------------
// Integration-style tests through LogStreamEndpoint.handle()
// ---------------------------------------------------------------------------

describe('LogStreamEndpoint — CORS headers on error path (404)', () => {
  beforeEach(() => {
    process.env.APP_URL = ALLOWED_ORIGIN
  })
  afterEach(() => {
    delete process.env.APP_URL
  })

  it('includes CORS headers on 404 JSON error when Origin matches', async () => {
    const endpoint = new LogStreamEndpoint(
      makePrisma(false) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue({
          ok: true as const,
          ...makeSuccessAccess(),
        }),
        resolveProvider: vi.fn(),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq(ALLOWED_ORIGIN)
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(404)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers?.['Access-Control-Allow-Credentials']).toBe('true')
  })

  it('omits CORS headers on 404 when no Origin header', async () => {
    const endpoint = new LogStreamEndpoint(
      makePrisma(false) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue(makeSuccessAccess()),
        resolveProvider: vi.fn(),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq(undefined)
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(404)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('omits CORS headers on 404 when Origin is not in allowlist', async () => {
    const endpoint = new LogStreamEndpoint(
      makePrisma(false) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue(makeSuccessAccess()),
        resolveProvider: vi.fn(),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq('https://attacker.example.com')
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(404)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('includes CORS headers on 401 when token is missing', async () => {
    const endpoint = new LogStreamEndpoint(makePrisma() as any, 'test-secret', {
      authorize: vi.fn(),
      resolveProvider: vi.fn(),
      emitAudit: vi.fn(),
    })

    const req = makeReq(ALLOWED_ORIGIN, {
      url: '/sse/services/svc-123/logs',
    } as Partial<IncomingMessage>)
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(401)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ALLOWED_ORIGIN)
  })
})

describe('LogStreamEndpoint — CORS headers on 200 SSE response', () => {
  beforeEach(() => {
    process.env.APP_URL = ALLOWED_ORIGIN
  })
  afterEach(() => {
    delete process.env.APP_URL
  })

  it('includes CORS headers in the 200 writeHead when Origin matches', async () => {
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }

    const endpoint = new LogStreamEndpoint(
      makePrisma(true) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue(makeSuccessAccess()),
        resolveProvider: vi.fn().mockReturnValue(mockProvider),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq(ALLOWED_ORIGIN)
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers?.['Content-Type']).toBe('text/event-stream')
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(ALLOWED_ORIGIN)
    expect(res.headers?.['Access-Control-Allow-Credentials']).toBe('true')
  })

  it('omits CORS headers in the 200 writeHead when no Origin header', async () => {
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }

    const endpoint = new LogStreamEndpoint(
      makePrisma(true) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue(makeSuccessAccess()),
        resolveProvider: vi.fn().mockReturnValue(mockProvider),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq(undefined)
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('includes CORS headers for base AF app origin without APP_URL set', async () => {
    delete process.env.APP_URL
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }

    const endpoint = new LogStreamEndpoint(
      makePrisma(true) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue(makeSuccessAccess()),
        resolveProvider: vi.fn().mockReturnValue(mockProvider),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq('https://app.alternatefutures.ai')
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBe(
      'https://app.alternatefutures.ai'
    )
  })

  it('omits CORS headers in the 200 writeHead when Origin is not in allowlist', async () => {
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }

    const endpoint = new LogStreamEndpoint(
      makePrisma(true) as any,
      'test-secret',
      {
        authorize: vi.fn().mockResolvedValue(makeSuccessAccess()),
        resolveProvider: vi.fn().mockReturnValue(mockProvider),
        emitAudit: vi.fn(),
      }
    )

    const req = makeReq('https://attacker.example.com')
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers?.['Access-Control-Allow-Origin']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// pickLogEligibleDeployment — issue #230
// ---------------------------------------------------------------------------

/**
 * A Prisma stub where each findFirst call pops from a pre-seeded queue.
 * This lets tests control the two-pass query sequence precisely:
 *   call 1 → ACTIVE-only query
 *   call 2 → broader log-eligible query
 */
function makePrismaQueued(
  akashResults: (null | { id: string })[],
  phalaResults: (null | { id: string })[] = [],
  spheronResults: (null | { id: string })[] = []
): any {
  const akashQueue = [...akashResults]
  const phalaQueue = [...phalaResults]
  const spheronQueue = [...spheronResults]
  return {
    akashDeployment: {
      findFirst: vi.fn(() => Promise.resolve(akashQueue.shift() ?? null)),
    },
    phalaDeployment: {
      findFirst: vi.fn(() => Promise.resolve(phalaQueue.shift() ?? null)),
    },
    spheronDeployment: {
      findFirst: vi.fn(() => Promise.resolve(spheronQueue.shift() ?? null)),
    },
  }
}

describe('LogStreamEndpoint — pickLogEligibleDeployment (issue #230)', () => {
  afterEach(() => {
    delete process.env.APP_URL
  })

  // Each test uses a unique userId so module-level activeStreams from earlier
  // CORS tests (also userId 'user-1') don't push us over MAX_STREAMS_PER_USER.

  it('(a) streams successfully for a FAILED Akash deployment', async () => {
    // Pass 1 (ACTIVE query) → null; Pass 2 (broader) → FAILED deployment
    const prisma = makePrismaQueued([null, { id: 'depl-failed' }])
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }
    const access = { ...makeSuccessAccess(), userId: 'user-230a' }

    const endpoint = new LogStreamEndpoint(prisma, 'test-secret', {
      authorize: vi.fn().mockResolvedValue(access),
      resolveProvider: vi.fn().mockReturnValue(mockProvider),
      emitAudit: vi.fn(),
    })

    const req = makeReq()
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
      .join('')
    expect(written).toContain('event: ready')
    expect(written).toContain('depl-failed')
  })

  it('(b) streams successfully for a DEPLOYING Akash deployment', async () => {
    // Pass 1 → null; Pass 2 → DEPLOYING deployment
    const prisma = makePrismaQueued([null, { id: 'depl-deploying' }])
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }
    const access = { ...makeSuccessAccess(), userId: 'user-230b' }

    const endpoint = new LogStreamEndpoint(prisma, 'test-secret', {
      authorize: vi.fn().mockResolvedValue(access),
      resolveProvider: vi.fn().mockReturnValue(mockProvider),
      emitAudit: vi.fn(),
    })

    const req = makeReq()
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
      .join('')
    expect(written).toContain('event: ready')
    expect(written).toContain('depl-deploying')
  })

  it('(c) ACTIVE deployment wins over a more-recent FAILED (tiebreaker)', async () => {
    // Pass 1 returns ACTIVE immediately — Pass 2 is never reached
    const prisma = makePrismaQueued([{ id: 'depl-active' }])
    const stream = makeStream()
    const mockProvider = {
      displayName: 'Akash',
      getCapabilities: () => ({ supportsLogStreaming: true }),
      streamLogs: vi.fn().mockResolvedValue(stream),
    }
    const access = { ...makeSuccessAccess(), userId: 'user-230c' }

    const endpoint = new LogStreamEndpoint(prisma, 'test-secret', {
      authorize: vi.fn().mockResolvedValue(access),
      resolveProvider: vi.fn().mockReturnValue(mockProvider),
      emitAudit: vi.fn(),
    })

    const req = makeReq()
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(200)
    const written = (res.write as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0] as string)
      .join('')
    expect(written).toContain('depl-active')
    expect(written).not.toContain('depl-failed')
    // Only one Akash findFirst call was needed (ACTIVE found on Pass 1)
    expect(prisma.akashDeployment.findFirst).toHaveBeenCalledTimes(1)
  })

  it('(d) CLOSED/DELETED deployment returns 404 with updated message', async () => {
    // Both passes return null for both providers — no log-eligible deployment
    const prisma = makePrismaQueued([null, null], [null, null])
    const access = { ...makeSuccessAccess(), userId: 'user-230d' }

    const endpoint = new LogStreamEndpoint(prisma, 'test-secret', {
      authorize: vi.fn().mockResolvedValue(access),
      resolveProvider: vi.fn(),
      emitAudit: vi.fn(),
    })

    const req = makeReq()
    const res = makeRes()
    await endpoint.handle(
      req as IncomingMessage,
      res as unknown as ServerResponse,
      'svc-123'
    )

    expect(res.statusCode).toBe(404)
    expect(res.body).toContain('No log-eligible deployment found for this service')
  })
})
