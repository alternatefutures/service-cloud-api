import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { handleSchedulerStats } from './schedulerStatsEndpoint.js'

interface FakeRes {
  statusCode?: number
  headers?: Record<string, string>
  body?: string
  writeHead: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
}

function makeReq(headers: Record<string, string> = {}): IncomingMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { headers, url: '/internal/admin/scheduler-stats', method: 'GET' } as any
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
  res.writeHead = res.writeHead.bind(res)
  res.end = res.end.bind(res)
  return res
}

interface FakePrisma {
  $queryRaw: ReturnType<typeof vi.fn>
  verificationRun: { findFirst: ReturnType<typeof vi.fn> }
  gpuProbeRun: { findFirst: ReturnType<typeof vi.fn> }
  computeProvider: { count: ReturnType<typeof vi.fn> }
  gpuPriceSummary: {
    count: ReturnType<typeof vi.fn>
    findFirst: ReturnType<typeof vi.fn>
  }
}

/**
 * Builds a fake prisma where each $queryRaw call returns the next
 * fixture in `rawResults`. The endpoint dispatches verifier-agg first,
 * then probe-agg — order matters.
 */
function buildPrisma(opts: {
  verifierAgg?: Record<string, bigint>
  probeAgg?: Record<string, bigint>
  lastVerifier?: unknown
  lastProbe?: unknown
  verifiedProviderCount?: number
  gpuModelsTracked?: number
  lastPriceRefresh?: Date | null
} = {}): FakePrisma {
  const verifierAgg = opts.verifierAgg ?? {
    total_runs: 12n,
    successful_runs: 10n,
    failed_runs: 2n,
    total_cost_uact: 24_000_000n, // $24
  }
  const probeAgg = opts.probeAgg ?? {
    total_runs: 48n,
    successful_runs: 47n,
    failed_runs: 1n,
    total_cost_uact: 1_500_000n, // $1.50
  }

  const $queryRaw = vi.fn()
  $queryRaw
    .mockResolvedValueOnce([verifierAgg])
    .mockResolvedValueOnce([probeAgg])

  return {
    $queryRaw,
    verificationRun: {
      findFirst: vi.fn().mockResolvedValue(opts.lastVerifier ?? null),
    },
    gpuProbeRun: {
      findFirst: vi.fn().mockResolvedValue(opts.lastProbe ?? null),
    },
    computeProvider: {
      count: vi.fn().mockResolvedValue(opts.verifiedProviderCount ?? 14),
    },
    gpuPriceSummary: {
      count: vi.fn().mockResolvedValue(opts.gpuModelsTracked ?? 7),
      findFirst: vi.fn().mockResolvedValue(
        opts.lastPriceRefresh === null
          ? null
          : { refreshedAt: opts.lastPriceRefresh ?? new Date('2026-04-19T12:00:00Z') },
      ),
    },
  }
}

describe('handleSchedulerStats', () => {
  beforeEach(() => {
    process.env.INTERNAL_AUTH_TOKEN = 'secret-token'
  })

  afterEach(() => {
    delete process.env.INTERNAL_AUTH_TOKEN
    vi.clearAllMocks()
  })

  // ── Auth ─────────────────────────────────────────────────────────

  it('rejects request without x-internal-auth header', async () => {
    const res = makeRes()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleSchedulerStats(makeReq(), res as unknown as ServerResponse, buildPrisma() as any)
    expect(res.statusCode).toBe(401)
    expect(JSON.parse(res.body!).error).toBe('Unauthorized')
  })

  it('rejects request with the wrong token', async () => {
    const res = makeRes()
    await handleSchedulerStats(
      makeReq({ 'x-internal-auth': 'nope' }),
      res as unknown as ServerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildPrisma() as any,
    )
    expect(res.statusCode).toBe(401)
  })

  it('rejects when INTERNAL_AUTH_TOKEN is unset (deny-by-default)', async () => {
    delete process.env.INTERNAL_AUTH_TOKEN
    const res = makeRes()
    await handleSchedulerStats(
      makeReq({ 'x-internal-auth': 'secret-token' }),
      res as unknown as ServerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildPrisma() as any,
    )
    expect(res.statusCode).toBe(401)
  })

  // ── Aggregation ──────────────────────────────────────────────────

  it('returns aggregate stats with uact → ACT conversion and ISO timestamps', async () => {
    const lastVerifier = {
      startedAt: new Date('2026-04-18T04:00:00Z'),
      completedAt: new Date('2026-04-18T04:23:00Z'),
      status: 'completed',
      passed: 28,
      failed: 4,
      uniqueProviders: 11,
      costUact: 2_500_000n, // $2.50
    }
    const lastProbe = {
      startedAt: new Date('2026-04-19T13:00:00Z'),
      completedAt: new Date('2026-04-19T13:08:00Z'),
      status: 'completed',
      modelsProbed: 6,
      bidsCollected: 22,
      uniqueProviders: 9,
      costUact: 50_000n, // $0.05
    }
    const prisma = buildPrisma({ lastVerifier, lastProbe })
    const res = makeRes()
    await handleSchedulerStats(
      makeReq({ 'x-internal-auth': 'secret-token' }),
      res as unknown as ServerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    )

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body!)

    expect(body.verifier).toMatchObject({
      totalRuns: 12,
      successfulRuns: 10,
      failedRuns: 2,
      totalCostAct: 24,
      verifiedProviderCount: 14,
    })
    expect(body.verifier.lastRun).toMatchObject({
      status: 'completed',
      passed: 28,
      failed: 4,
      uniqueProviders: 11,
      costAct: 2.5,
    })
    expect(typeof body.verifier.lastRun.startedAt).toBe('string')
    expect(body.verifier.lastRun.completedAt).toBe('2026-04-18T04:23:00.000Z')

    expect(body.probe).toMatchObject({
      totalRuns: 48,
      successfulRuns: 47,
      failedRuns: 1,
      totalCostAct: 1.5,
      gpuModelsTracked: 7,
      lastPriceRefresh: '2026-04-19T12:00:00.000Z',
    })
    expect(body.probe.lastRun).toMatchObject({
      status: 'completed',
      modelsProbed: 6,
      bidsCollected: 22,
      uniqueProviders: 9,
      costAct: 0.05,
    })
  })

  it('handles a fresh install (no runs, no prices) without crashing', async () => {
    const prisma = buildPrisma({
      verifierAgg: {
        total_runs: 0n,
        successful_runs: 0n,
        failed_runs: 0n,
        total_cost_uact: 0n,
      },
      probeAgg: {
        total_runs: 0n,
        successful_runs: 0n,
        failed_runs: 0n,
        total_cost_uact: 0n,
      },
      verifiedProviderCount: 0,
      gpuModelsTracked: 0,
      lastPriceRefresh: null,
    })
    const res = makeRes()
    await handleSchedulerStats(
      makeReq({ 'x-internal-auth': 'secret-token' }),
      res as unknown as ServerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    )

    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.body!)
    expect(body.verifier.totalRuns).toBe(0)
    expect(body.verifier.lastRun).toBeNull()
    expect(body.verifier.totalCostAct).toBe(0)
    expect(body.probe.totalRuns).toBe(0)
    expect(body.probe.lastRun).toBeNull()
    expect(body.probe.lastPriceRefresh).toBeNull()
  })

  it('preserves uact precision down to $0.0001 for tiny probe spend', async () => {
    const prisma = buildPrisma({
      probeAgg: {
        total_runs: 1n,
        successful_runs: 1n,
        failed_runs: 0n,
        total_cost_uact: 1_500n, // $0.0015
      },
    })
    const res = makeRes()
    await handleSchedulerStats(
      makeReq({ 'x-internal-auth': 'secret-token' }),
      res as unknown as ServerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    )
    const body = JSON.parse(res.body!)
    // 1500 / 1_000_000 = 0.0015
    expect(body.probe.totalCostAct).toBeCloseTo(0.0015, 6)
  })

  it('returns 500 when the prisma read throws', async () => {
    const $queryRaw = vi.fn().mockRejectedValue(new Error('db down'))
    const prisma = {
      $queryRaw,
      verificationRun: { findFirst: vi.fn() },
      gpuProbeRun: { findFirst: vi.fn() },
      computeProvider: { count: vi.fn() },
      gpuPriceSummary: { count: vi.fn(), findFirst: vi.fn() },
    }
    const res = makeRes()
    await handleSchedulerStats(
      makeReq({ 'x-internal-auth': 'secret-token' }),
      res as unknown as ServerResponse,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      prisma as any,
    )
    expect(res.statusCode).toBe(500)
  })
})
