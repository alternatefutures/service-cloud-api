/**
 * Tests for logStreamEndpoint.ts — focused on CORS header correctness.
 *
 * Issue #226: SSE endpoint was missing Access-Control-Allow-Origin, blocking
 * the Logs tab on app.alternatefutures.ai.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { LogStreamEndpoint, getCorsHeaders } from './logStreamEndpoint.js'

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
  } as unknown as Parameters<
    typeof LogStreamEndpoint.prototype.handle
  >[0] extends never
    ? never
    : any
}

// ---------------------------------------------------------------------------
// Unit tests for getCorsHeaders()
// ---------------------------------------------------------------------------

describe('getCorsHeaders', () => {
  beforeEach(() => {
    process.env.APP_URL = ALLOWED_ORIGIN
  })
  afterEach(() => {
    delete process.env.APP_URL
  })

  it('returns CORS headers when Origin matches APP_URL', () => {
    const req = makeReq(ALLOWED_ORIGIN)
    const headers = getCorsHeaders(req)
    expect(headers['Access-Control-Allow-Origin']).toBe(ALLOWED_ORIGIN)
    expect(headers['Access-Control-Allow-Credentials']).toBe('true')
    expect(headers['Access-Control-Allow-Methods']).toBe('GET')
  })

  it('returns empty object when Origin header is absent (non-browser curl)', () => {
    const req = makeReq(undefined)
    expect(getCorsHeaders(req)).toEqual({})
  })

  it('returns empty object when Origin does not match allowlist', () => {
    const req = makeReq('https://evil.example.com')
    expect(getCorsHeaders(req)).toEqual({})
  })

  it('uses production fallback when APP_URL is not set', () => {
    delete process.env.APP_URL
    const saved = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    const req = makeReq('https://alternatefutures.ai')
    const headers = getCorsHeaders(req)
    expect(headers['Access-Control-Allow-Origin']).toBe(
      'https://alternatefutures.ai'
    )
    process.env.NODE_ENV = saved
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
})
