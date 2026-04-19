import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

const { getAkashChainGeometryMock } = vi.hoisted(() => ({
  getAkashChainGeometryMock: vi.fn(),
}))

vi.mock('../../config/pricing.js', () => ({
  getAkashChainGeometry: getAkashChainGeometryMock,
}))

import { handleGpuPricingRequest } from './gpuPricingEndpoint.js'

interface FakeRes {
  statusCode?: number
  headers?: Record<string, string>
  body?: string
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers, url: '/internal/gpu-pricing', method: 'GET' } as any
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    writeHead: vi.fn(function (this: FakeRes, status: number, h?: Record<string, string>) {
      this.statusCode = status
      this.headers = h
    }),
    end: vi.fn(function (this: FakeRes, body?: string) {
      this.body = body
    }),
  }
  // bind `this` for method calls
  res.writeHead = res.writeHead.bind(res)
  res.end = res.end.bind(res)
  return res
}

const SUMMARY_FIXTURE = [
  {
    gpuModel: 'h100',
    vendor: 'nvidia',
    minPricePerBlock: 1_000n,
    p50PricePerBlock: 1_500n,
    p90PricePerBlock: 2_000n,
    maxPricePerBlock: 2_500n,
    sampleCount: 12,
    uniqueProviderCount: 4,
    windowDays: 7,
    refreshedAt: new Date('2026-04-19T12:00:00Z'),
  },
  {
    gpuModel: 'rtx4090',
    vendor: 'nvidia',
    minPricePerBlock: 200n,
    p50PricePerBlock: 250n,
    p90PricePerBlock: 300n,
    maxPricePerBlock: 350n,
    sampleCount: 8,
    uniqueProviderCount: 3,
    windowDays: 7,
    refreshedAt: new Date('2026-04-19T12:00:00Z'),
  },
]

function buildPrisma(rows = SUMMARY_FIXTURE) {
  return {
    gpuPriceSummary: {
      findMany: vi.fn().mockResolvedValue(rows),
    },
  } as any
}

describe('handleGpuPricingRequest', () => {
  beforeEach(() => {
    process.env.INTERNAL_AUTH_TOKEN = 'secret-token'
    getAkashChainGeometryMock.mockResolvedValue({
      secondsPerBlock: 6.117,
      blocksPerHour: 588,
      blocksPerDay: 14_124,
      source: 'cache',
      sampledAt: Date.now(),
    })
  })

  afterEach(() => {
    delete process.env.INTERNAL_AUTH_TOKEN
    vi.clearAllMocks()
  })

  it('rejects request without x-internal-auth header', async () => {
    const req = makeReq()
    const res = makeRes()
    await handleGpuPricingRequest(req, res as unknown as ServerResponse, buildPrisma())
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body!).error).toBe('Unauthorized')
  })

  it('rejects request with the wrong token', async () => {
    const req = makeReq({ 'x-internal-auth': 'nope' })
    const res = makeRes()
    await handleGpuPricingRequest(req, res as unknown as ServerResponse, buildPrisma())
    expect(res.statusCode).toBe(401)
  })

  it('rejects when INTERNAL_AUTH_TOKEN is unset (deny-by-default)', async () => {
    delete process.env.INTERNAL_AUTH_TOKEN
    const req = makeReq({ 'x-internal-auth': 'secret-token' })
    const res = makeRes()
    await handleGpuPricingRequest(req, res as unknown as ServerResponse, buildPrisma())
    expect(res.statusCode).toBe(401)
  })

  it('returns rolled-up summaries with stringified BigInts and live block geometry', async () => {
    const req = makeReq({ 'x-internal-auth': 'secret-token' })
    const res = makeRes()
    await handleGpuPricingRequest(req, res as unknown as ServerResponse, buildPrisma())

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body!)
    expect(body.blocksPerDay).toBe(14_124)
    expect(body.blocksSource).toBe('cache')
    expect(body.models).toHaveLength(2)
    const h100 = body.models.find((m: any) => m.gpuModel === 'h100')
    expect(h100).toMatchObject({
      vendor: 'nvidia',
      minUact: '1000',
      p50Uact: '1500',
      p90Uact: '2000',
      maxUact: '2500',
      sampleCount: 12,
      providerCount: 4,
      windowDays: 7,
    })
    expect(typeof h100.refreshedAt).toBe('string')
  })

  it('returns 200 with empty models when the rollup table is empty', async () => {
    const req = makeReq({ 'x-internal-auth': 'secret-token' })
    const res = makeRes()
    await handleGpuPricingRequest(req, res as unknown as ServerResponse, buildPrisma([]))
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body!)
    expect(body.models).toEqual([])
    expect(body.blocksPerDay).toBe(14_124)
  })

  it('returns 500 when the prisma read throws', async () => {
    const prisma = {
      gpuPriceSummary: { findMany: vi.fn().mockRejectedValue(new Error('db down')) },
    } as any
    const req = makeReq({ 'x-internal-auth': 'secret-token' })
    const res = makeRes()
    await handleGpuPricingRequest(req, res as unknown as ServerResponse, prisma)
    expect(res.statusCode).toBe(500)
  })
})
