import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub the env helper so tests don't need a real AKASH_MNEMONIC just to
// reach the probe code.
vi.mock('../../lib/akashEnv.js', () => ({
  getAkashEnv: vi.fn(() => ({
    AKASH_FROM: 'test-key',
    AKASH_KEY_NAME: 'test-key',
    AKASH_NODE: 'https://rpc.test',
    AKASH_CHAIN_ID: 'akashnet-2',
  })),
}))

// We never want a real wallet lock in these tests — passthrough.
vi.mock('../akash/walletMutex.js', () => ({
  withWalletLock: <T>(fn: () => Promise<T>) => fn(),
}))

vi.mock('../akash/orchestrator.js', () => ({
  DEFAULT_DEPOSIT_UACT: 1_000_000,
}))

// Stub the wallet-balance helper used by the cycle telemetry path —
// no real CLI calls in unit tests.
vi.mock('./providerVerification.js', () => ({
  checkBalance: vi.fn(async () => ({ uact: 100_000_000, uakt: 0, act: '100' })),
}))

import {
  probeOneGpuModel,
  runGpuBidProbeCycle,
  rollupGpuPrices,
  quantiles,
  MAX_PROBE_BID_UACT,
  type ExecResult,
} from './gpuBidProbe.js'
import { checkBalance } from './providerVerification.js'

// ── Fixtures ───────────────────────────────────────────────────────────

const TX_OK_WITH_DSEQ = JSON.stringify({
  code: 0,
  txhash: 'deadbeef',
  logs: [
    {
      events: [
        {
          attributes: [
            { key: 'dseq', value: '424242' },
          ],
        },
      ],
    },
  ],
})

const TX_CLOSE_OK = JSON.stringify({ code: 0, txhash: 'closetx' })

const KEYS_SHOW_OUT = 'akash1owner\n'

const BIDS_THREE_OPEN = JSON.stringify({
  bids: [
    {
      bid: {
        bid_id: { provider: 'akash1providerA' },
        price: { denom: 'uact', amount: '1000' },
        state: 'open',
      },
    },
    {
      bid: {
        bid_id: { provider: 'akash1providerB' },
        price: { denom: 'uact', amount: '2000' },
        state: 'open',
      },
    },
    // Closed bid — must be ignored.
    {
      bid: {
        bid_id: { provider: 'akash1providerC' },
        price: { denom: 'uact', amount: '500' },
        state: 'closed',
      },
    },
    // uakt bid — must be ignored (post-BME purity).
    {
      bid: {
        bid_id: { provider: 'akash1providerD' },
        price: { denom: 'uakt', amount: '50' },
        state: 'open',
      },
    },
  ],
})

const BIDS_EMPTY = JSON.stringify({ bids: [] })

function ok(stdout: string): ExecResult {
  return { stdout, stderr: '', exitCode: 0, durationMs: 1 }
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return { stdout: '', stderr, exitCode, durationMs: 1 }
}

interface FakePrisma {
  computeProvider: { findMany: ReturnType<typeof vi.fn> }
  gpuBidObservation: {
    createMany: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
  }
  gpuPriceSummary: {
    upsert: ReturnType<typeof vi.fn>
    findMany: ReturnType<typeof vi.fn>
  }
  gpuProbeRun: {
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
}

function buildPrisma(): FakePrisma {
  return {
    computeProvider: { findMany: vi.fn().mockResolvedValue([]) },
    gpuBidObservation: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    gpuPriceSummary: {
      upsert: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    gpuProbeRun: {
      create: vi.fn().mockResolvedValue({ id: 'run-record-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
  }
}

// ── probeOneGpuModel ───────────────────────────────────────────────────

// No-op sleep: tests stub out the 30s+ inter-poll waits so they finish
// in milliseconds, not minutes. The probe code's *behaviour* is what we
// test — the wall-clock between polls is irrelevant.
const fastSleep = () => Promise.resolve()

describe('probeOneGpuModel', () => {
  beforeEach(() => {
    process.env.AKASH_MNEMONIC = 'test mnemonic'
  })

  afterEach(() => {
    delete process.env.AKASH_MNEMONIC
  })

  it('happy path: posts deployment, records bids, closes in finally', async () => {
    const execCli = vi.fn(async (_bin: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'keys' && args[1] === 'show') return ok(KEYS_SHOW_OUT)
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'create') return ok(TX_OK_WITH_DSEQ)
      if (args[0] === 'query' && args[1] === 'market' && args[2] === 'bid' && args[3] === 'list') {
        return ok(BIDS_THREE_OPEN)
      }
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'close') return ok(TX_CLOSE_OK)
      return ok('{}')
    })

    const prisma = buildPrisma()
    const result = await probeOneGpuModel(prisma as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })

    expect(result.error).toBeUndefined()
    expect(result.dseq).toBe(424242)
    expect(result.bidsReceived).toBe(2) // closed + uakt filtered out
    expect(result.providersBidding).toBe(2)
    expect(prisma.gpuBidObservation.createMany).toHaveBeenCalledOnce()
    const inserted = prisma.gpuBidObservation.createMany.mock.calls[0][0].data
    expect(inserted).toHaveLength(2)
    const providers = inserted.map((r: any) => r.providerAddr).sort()
    expect(providers).toEqual(['akash1providerA', 'akash1providerB'])

    // Close was called.
    const closeCall = execCli.mock.calls.find(
      c => c[1][0] === 'tx' && c[1][1] === 'deployment' && c[1][2] === 'close'
    )
    expect(closeCall).toBeDefined()
    expect(closeCall![1]).toContain('424242')
  })

  it('still closes when bid query throws mid-poll (escrow safety)', async () => {
    let bidCalls = 0
    const execCli = vi.fn(async (_bin: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'keys' && args[1] === 'show') return ok(KEYS_SHOW_OUT)
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'create') return ok(TX_OK_WITH_DSEQ)
      if (args[0] === 'query' && args[1] === 'market' && args[2] === 'bid' && args[3] === 'list') {
        bidCalls++
        if (bidCalls === 1) throw new Error('chain RPC unavailable')
        return ok(BIDS_EMPTY)
      }
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'close') return ok(TX_CLOSE_OK)
      return ok('{}')
    })

    const prisma = buildPrisma()
    const result = await probeOneGpuModel(prisma as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })

    // Probe failed but escrow was reclaimed — that's the contract.
    expect(result.error).toBeDefined()
    const closeCall = execCli.mock.calls.find(
      c => c[1][0] === 'tx' && c[1][1] === 'deployment' && c[1][2] === 'close'
    )
    expect(closeCall).toBeDefined()
  })

  it('retries on sequence-mismatch (code 32) up to TX_RETRIES', async () => {
    const TX_SEQ_MISMATCH = JSON.stringify({ code: 32, raw_log: 'account sequence mismatch' })
    let createCalls = 0
    const execCli = vi.fn(async (_bin: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'keys' && args[1] === 'show') return ok(KEYS_SHOW_OUT)
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'create') {
        createCalls++
        if (createCalls < 3) return ok(TX_SEQ_MISMATCH)
        return ok(TX_OK_WITH_DSEQ)
      }
      if (args[0] === 'query' && args[1] === 'market' && args[2] === 'bid' && args[3] === 'list') {
        return ok(BIDS_EMPTY)
      }
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'close') return ok(TX_CLOSE_OK)
      return ok('{}')
    })

    const prisma = buildPrisma()
    const result = await probeOneGpuModel(prisma as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })

    expect(createCalls).toBe(3)
    expect(result.dseq).toBe(424242)
  })

  it('returns error when AKASH_MNEMONIC is unset', async () => {
    delete process.env.AKASH_MNEMONIC
    const execCli = vi.fn()
    const result = await probeOneGpuModel(buildPrisma() as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })
    expect(result.error).toBe('AKASH_MNEMONIC not set')
    expect(execCli).not.toHaveBeenCalled()
  })

  it('refuses to splice an unsafe gpu model into the SDL', async () => {
    const execCli = vi.fn()
    const result = await probeOneGpuModel(
      buildPrisma() as any,
      'h100\nrm -rf /',
      'nvidia',
      'run-1',
      { execCli, sleep: fastSleep }
    )
    expect(result.error).toMatch(/Bad probe SDL/)
    expect(execCli).not.toHaveBeenCalled()
  })

  it('returns error (no insert) when no bids arrive but still closes', async () => {
    const execCli = vi.fn(async (_bin: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'keys' && args[1] === 'show') return ok(KEYS_SHOW_OUT)
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'create') return ok(TX_OK_WITH_DSEQ)
      if (args[0] === 'query' && args[1] === 'market' && args[2] === 'bid' && args[3] === 'list') {
        return ok(BIDS_EMPTY)
      }
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'close') return ok(TX_CLOSE_OK)
      return ok('{}')
    })

    const prisma = buildPrisma()
    const result = await probeOneGpuModel(prisma as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })

    expect(result.error).toBe('No bids received within timeout')
    expect(prisma.gpuBidObservation.createMany).not.toHaveBeenCalled()
    const closeCall = execCli.mock.calls.find(
      c => c[1][0] === 'tx' && c[1][1] === 'deployment' && c[1][2] === 'close'
    )
    expect(closeCall).toBeDefined()
  })

  it('falls back to query-tx when create logs lack the dseq attribute', async () => {
    const TX_NO_DSEQ = JSON.stringify({ code: 0, txhash: 'fffffff', logs: [] })
    const QUERY_TX_WITH_DSEQ = JSON.stringify({
      logs: [{ events: [{ attributes: [{ key: 'dseq', value: '777' }] }] }],
    })
    const execCli = vi.fn(async (_bin: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'keys' && args[1] === 'show') return ok(KEYS_SHOW_OUT)
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'create') return ok(TX_NO_DSEQ)
      if (args[0] === 'query' && args[1] === 'tx') return ok(QUERY_TX_WITH_DSEQ)
      if (args[0] === 'query' && args[1] === 'market' && args[2] === 'bid' && args[3] === 'list') {
        return ok(BIDS_EMPTY)
      }
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'close') return ok(TX_CLOSE_OK)
      return ok('{}')
    })

    const prisma = buildPrisma()
    const result = await probeOneGpuModel(prisma as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })

    expect(result.dseq).toBe(777)
  })

  it('does not crash when close TX itself fails', async () => {
    const execCli = vi.fn(async (_bin: string, args: string[]): Promise<ExecResult> => {
      if (args[0] === 'keys' && args[1] === 'show') return ok(KEYS_SHOW_OUT)
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'create') return ok(TX_OK_WITH_DSEQ)
      if (args[0] === 'query' && args[1] === 'market' && args[2] === 'bid' && args[3] === 'list') {
        return ok(BIDS_THREE_OPEN)
      }
      if (args[0] === 'tx' && args[1] === 'deployment' && args[2] === 'close') {
        throw new Error('node down')
      }
      return ok('{}')
    })

    const prisma = buildPrisma()
    const result = await probeOneGpuModel(prisma as any, 'h100', 'nvidia', 'run-1', { execCli, sleep: fastSleep })

    // Bids were still recorded; only the close best-effort failed (the
    // chain-orphan sweep in escrowHealthMonitor will reclaim).
    expect(result.bidsReceived).toBe(2)
    expect(prisma.gpuBidObservation.createMany).toHaveBeenCalledOnce()
  })
})

// ── quantiles ──────────────────────────────────────────────────────────

describe('quantiles', () => {
  it('returns null on empty input', () => {
    expect(quantiles([])).toBeNull()
  })

  it('handles single-element input', () => {
    const q = quantiles([42n])
    expect(q).toEqual({ min: 42n, p50: 42n, p90: 42n, max: 42n })
  })

  it('uses nearest-rank semantics for a 5-sample known case', () => {
    // sorted: [10, 20, 30, 40, 50]
    // p50 = ceil(0.5 * 5) - 1 = 2 → 30
    // p90 = ceil(0.9 * 5) - 1 = 4 → 50
    const q = quantiles([10n, 20n, 30n, 40n, 50n])
    expect(q).toEqual({ min: 10n, p50: 30n, p90: 50n, max: 50n })
  })

  it('separates p50 from max on a 10-sample skewed distribution', () => {
    // Most providers cheap, one expensive outlier — p50 should NOT be
    // pulled toward the max.
    const sorted = [100n, 110n, 120n, 130n, 140n, 150n, 160n, 170n, 180n, 5_000n]
    const q = quantiles(sorted)
    expect(q!.min).toBe(100n)
    // p50: ceil(0.5*10)=5 → idx 4 → 140
    expect(q!.p50).toBe(140n)
    // p90: ceil(0.9*10)=9 → idx 8 → 180
    expect(q!.p90).toBe(180n)
    expect(q!.max).toBe(5_000n)
  })
})

// ── rollupGpuPrices ────────────────────────────────────────────────────

describe('rollupGpuPrices', () => {
  it('groups by gpuModel, drops bids ≥ MAX_PROBE_BID_UACT, upserts percentiles', async () => {
    const prisma = buildPrisma()

    prisma.gpuBidObservation.findMany.mockResolvedValue([
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'a', pricePerBlock: 1_000n },
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'b', pricePerBlock: 2_000n },
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'c', pricePerBlock: 3_000n },
      // ceiling-bidding poison — must be dropped:
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'evil', pricePerBlock: MAX_PROBE_BID_UACT },
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'evil2', pricePerBlock: MAX_PROBE_BID_UACT + 1n },
      // Different model:
      { gpuModel: 'rtx4090', vendor: 'nvidia', providerAddr: 'a', pricePerBlock: 500n },
      { gpuModel: 'rtx4090', vendor: 'nvidia', providerAddr: 'b', pricePerBlock: 600n },
    ])

    const result = await rollupGpuPrices(prisma as any, 7)

    expect(result.modelsUpdated).toBe(2)
    expect(result.modelsSkipped).toBe(0)
    expect(prisma.gpuPriceSummary.upsert).toHaveBeenCalledTimes(2)

    const calls = prisma.gpuPriceSummary.upsert.mock.calls.map(c => c[0])
    const h100 = calls.find(c => c.where.gpuModel === 'h100')!
    expect(h100.create.minPricePerBlock).toBe(1_000n)
    expect(h100.create.maxPricePerBlock).toBe(3_000n)
    expect(h100.create.sampleCount).toBe(3) // poisoned bids dropped
    expect(h100.create.uniqueProviderCount).toBe(3)
    expect(h100.create.windowDays).toBe(7)

    const rtx = calls.find(c => c.where.gpuModel === 'rtx4090')!
    expect(rtx.create.sampleCount).toBe(2)
    expect(rtx.create.minPricePerBlock).toBe(500n)
    expect(rtx.create.maxPricePerBlock).toBe(600n)
  })

  it('counts unique providers correctly when one provider bids multiple times', async () => {
    const prisma = buildPrisma()
    prisma.gpuBidObservation.findMany.mockResolvedValue([
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'a', pricePerBlock: 1_000n },
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'a', pricePerBlock: 1_100n },
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'b', pricePerBlock: 2_000n },
    ])

    await rollupGpuPrices(prisma as any, 7)

    const upsert = prisma.gpuPriceSummary.upsert.mock.calls[0][0]
    expect(upsert.create.sampleCount).toBe(3)
    expect(upsert.create.uniqueProviderCount).toBe(2)
  })

  it('does NOT upsert when a model has only ceiling-bidding poison (no honest bids)', async () => {
    const prisma = buildPrisma()
    prisma.gpuBidObservation.findMany.mockResolvedValue([
      { gpuModel: 'h100', vendor: 'nvidia', providerAddr: 'evil', pricePerBlock: MAX_PROBE_BID_UACT + 100n },
    ])

    const result = await rollupGpuPrices(prisma as any, 7)
    expect(result.modelsUpdated).toBe(0)
    expect(prisma.gpuPriceSummary.upsert).not.toHaveBeenCalled()
  })
})

// ── runGpuBidProbeCycle telemetry (GpuProbeRun writes) ───────────────

describe('runGpuBidProbeCycle GpuProbeRun telemetry', () => {
  beforeEach(() => {
    process.env.AKASH_MNEMONIC = 'test mnemonic'
    vi.mocked(checkBalance).mockResolvedValue({
      uact: 100_000_000,
      uakt: 0,
      act: '100',
    } as any)
  })

  afterEach(() => {
    delete process.env.AKASH_MNEMONIC
    vi.clearAllMocks()
  })

  it('creates a GpuProbeRun row at start and finalises it with completed status + cost delta', async () => {
    const prisma = buildPrisma()
    // No verified providers → models map empty → loop is skipped, but
    // run record should still be created and finalised cleanly.
    prisma.computeProvider.findMany.mockResolvedValue([])

    // Spend simulation: $0.05 (50_000 uact) draw-down across the cycle.
    vi.mocked(checkBalance)
      .mockResolvedValueOnce({ uact: 100_000_000, uakt: 0, act: '100' } as any)
      .mockResolvedValueOnce({ uact: 99_950_000, uakt: 0, act: '99.95' } as any)

    const summary = await runGpuBidProbeCycle(prisma as any)

    expect(prisma.gpuProbeRun.create).toHaveBeenCalledOnce()
    const createArg = prisma.gpuProbeRun.create.mock.calls[0][0]
    expect(createArg.data.probeRunId).toBe(summary.runId)
    expect(createArg.data.status).toBe('running')

    expect(prisma.gpuProbeRun.update).toHaveBeenCalledOnce()
    const updateArg = prisma.gpuProbeRun.update.mock.calls[0][0]
    expect(updateArg.where.id).toBe('run-record-1')
    expect(updateArg.data.status).toBe('completed')
    expect(updateArg.data.modelsProbed).toBe(0)
    expect(updateArg.data.bidsCollected).toBe(0)
    expect(updateArg.data.uniqueProviders).toBe(0)
    // 100_000_000 - 99_950_000 = 50_000 uact
    expect(updateArg.data.costUact).toBe(50_000n)
    expect(updateArg.data.error).toBeNull()
  })

  it('floors negative cost at 0 when wallet was refilled mid-cycle', async () => {
    const prisma = buildPrisma()
    prisma.computeProvider.findMany.mockResolvedValue([])

    vi.mocked(checkBalance)
      .mockResolvedValueOnce({ uact: 50_000_000, uakt: 0, act: '50' } as any)
      // Refill mid-cycle: post-balance is HIGHER than pre. The floor
      // prevents us from attributing a negative cost to the cycle.
      .mockResolvedValueOnce({ uact: 200_000_000, uakt: 0, act: '200' } as any)

    await runGpuBidProbeCycle(prisma as any)

    const updateArg = prisma.gpuProbeRun.update.mock.calls[0][0]
    expect(updateArg.data.costUact).toBe(0n)
  })

  it('records cost = 0 when the pre-balance snapshot fails (DB telemetry never blocks the cycle)', async () => {
    const prisma = buildPrisma()
    prisma.computeProvider.findMany.mockResolvedValue([])

    vi.mocked(checkBalance).mockRejectedValueOnce(new Error('rpc down'))

    await runGpuBidProbeCycle(prisma as any)

    expect(prisma.gpuProbeRun.update).toHaveBeenCalledOnce()
    const updateArg = prisma.gpuProbeRun.update.mock.calls[0][0]
    expect(updateArg.data.costUact).toBe(0n)
    expect(updateArg.data.status).toBe('completed')
  })

  it('does not throw the cycle when the run-record create itself fails', async () => {
    const prisma = buildPrisma()
    prisma.computeProvider.findMany.mockResolvedValue([])
    prisma.gpuProbeRun.create.mockRejectedValueOnce(new Error('chain_stats migration not run'))

    const summary = await runGpuBidProbeCycle(prisma as any)

    expect(summary.modelsProbed).toBe(0)
    // No update either, since we never got a runRecordId.
    expect(prisma.gpuProbeRun.update).not.toHaveBeenCalled()
  })

  it('aggregates bids back into the run record when probes succeed', async () => {
    const prisma = buildPrisma()
    prisma.computeProvider.findMany.mockResolvedValue([
      { gpuModels: ['h100'] },
    ])
    // Pretend two providers bid during this run (read-back after probe).
    prisma.gpuBidObservation.findMany.mockResolvedValue([
      { providerAddr: 'akash1A' },
      { providerAddr: 'akash1B' },
      { providerAddr: 'akash1A' }, // duplicate provider — must be deduped
    ])

    // No real probes — just mock execCli to fail fast so the loop runs
    // but we don't need to model the full happy path here.
    const summary = await runGpuBidProbeCycle(prisma as any, {
      execCli: vi.fn(async () => ({ stdout: '', stderr: 'fail', exitCode: 1, durationMs: 1 })),
      sleep: () => Promise.resolve(),
    })

    expect(summary.modelsProbed).toBe(1)
    expect(summary.totalBids).toBe(3)
    expect(summary.uniqueProviders).toBe(2)

    const updateArg = prisma.gpuProbeRun.update.mock.calls[0][0]
    expect(updateArg.data.bidsCollected).toBe(3)
    expect(updateArg.data.uniqueProviders).toBe(2)
    expect(updateArg.data.modelsProbed).toBe(1)
  })
})
