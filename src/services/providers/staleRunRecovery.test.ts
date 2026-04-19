import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  markStaleVerifierRuns,
  markStaleProbeRuns,
  MAX_VERIFIER_RUN_MS,
  MAX_PROBE_RUN_MS,
} from './staleRunRecovery.js'

interface FakePrisma {
  verificationRun: { updateMany: ReturnType<typeof vi.fn> }
  gpuProbeRun: { updateMany: ReturnType<typeof vi.fn> }
}

function buildPrisma(): FakePrisma {
  return {
    verificationRun: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    gpuProbeRun: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  }
}

describe('markStaleVerifierRuns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T17:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates only rows where status=running AND startedAt is older than MAX_VERIFIER_RUN_MS', async () => {
    const prisma = buildPrisma()
    prisma.verificationRun.updateMany.mockResolvedValue({ count: 3 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const swept = await markStaleVerifierRuns(prisma as any)

    expect(swept).toBe(3)
    expect(prisma.verificationRun.updateMany).toHaveBeenCalledOnce()
    const arg = prisma.verificationRun.updateMany.mock.calls[0][0]

    expect(arg.where.status).toBe('running')
    expect(arg.where.startedAt.lt).toBeInstanceOf(Date)
    // cutoff = now - MAX
    const expected = Date.now() - MAX_VERIFIER_RUN_MS
    expect((arg.where.startedAt.lt as Date).getTime()).toBe(expected)

    expect(arg.data.status).toBe('failed')
    expect(arg.data.completedAt).toBeInstanceOf(Date)
    expect(arg.data.error).toMatch(/Marked stale on scheduler startup/)
  })

  it('returns 0 (does not throw) when prisma updateMany rejects', async () => {
    const prisma = buildPrisma()
    prisma.verificationRun.updateMany.mockRejectedValue(new Error('connection refused'))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const swept = await markStaleVerifierRuns(prisma as any)
    expect(swept).toBe(0)
  })

  it('returns 0 when there are no stale rows (no swept-count log spam)', async () => {
    const prisma = buildPrisma()
    prisma.verificationRun.updateMany.mockResolvedValue({ count: 0 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const swept = await markStaleVerifierRuns(prisma as any)
    expect(swept).toBe(0)
    expect(prisma.verificationRun.updateMany).toHaveBeenCalledOnce()
  })
})

describe('markStaleProbeRuns', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-19T17:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses the probe-specific cutoff (30m), not the verifier cutoff (6h)', async () => {
    const prisma = buildPrisma()
    prisma.gpuProbeRun.updateMany.mockResolvedValue({ count: 1 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await markStaleProbeRuns(prisma as any)

    const arg = prisma.gpuProbeRun.updateMany.mock.calls[0][0]
    const expected = Date.now() - MAX_PROBE_RUN_MS
    expect((arg.where.startedAt.lt as Date).getTime()).toBe(expected)
    // sanity: probe cutoff must be MUCH more recent than verifier cutoff,
    // otherwise we'd let stranded probe rows linger for 6h.
    expect(MAX_PROBE_RUN_MS).toBeLessThan(MAX_VERIFIER_RUN_MS)
  })

  it('survives a DB error without throwing', async () => {
    const prisma = buildPrisma()
    prisma.gpuProbeRun.updateMany.mockRejectedValue(new Error('db down'))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const swept = await markStaleProbeRuns(prisma as any)
    expect(swept).toBe(0)
  })
})
