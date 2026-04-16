import { beforeEach, describe, expect, it, vi } from 'vitest'

const computeDebitMock = vi.fn()
const getOrgBalanceMock = vi.fn()
const getOrgMarkupMock = vi.fn()
const getOrgBillingMock = vi.fn()

vi.mock('./billingApiClient.js', () => ({
  getBillingApiClient: vi.fn(() => ({
    computeDebit: computeDebitMock,
    getOrgBalance: getOrgBalanceMock,
    getOrgMarkup: getOrgMarkupMock,
    getOrgBilling: getOrgBillingMock,
  })),
}))

const topUpDeploymentDepositMock = vi.fn().mockResolvedValue(undefined)

vi.mock('../akash/orchestrator.js', () => ({
  getAkashOrchestrator: vi.fn(() => ({
    topUpDeploymentDeposit: topUpDeploymentDepositMock,
    closeDeployment: vi.fn().mockResolvedValue(undefined),
  })),
}))

vi.mock('./escrowService.js', () => ({
  getEscrowService: vi.fn(() => ({
    processDailyConsumption: vi.fn(),
    pauseEscrow: vi.fn(),
    refundEscrow: vi.fn(),
  })),
}))

vi.mock('./deploymentSettlement.js', () => ({
  processFinalPhalaBilling: vi.fn().mockResolvedValue(undefined),
  settleAkashEscrowToTime: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../policy/enforcer.js', () => ({
  checkPolicyLimits: vi.fn().mockResolvedValue({ budgetStopped: 0, runtimeExpired: 0 }),
}))

vi.mock('../../config/billing.js', () => ({
  BILLING_CONFIG: {
    akash: {
      escrowDays: 0,
      billingIntervalHours: 1,
      minBillingIntervalHours: 1,
      minBalanceCentsToLaunch: 100,
    },
    phala: {
      billingIntervalHours: 1,
      minBalanceCentsToLaunch: 100,
    },
    scheduler: { cronExpression: '0 * * * *' },
    thresholds: {
      lowBalanceHours: 1,
      checkIntervalCron: '*/10 * * * *',
    },
  },
}))

import { ComputeBillingScheduler } from './computeBillingScheduler.js'

interface FakeEscrow {
  id: string
  orgBillingId: string
  akashDeploymentId: string
  depositCents: number
  consumedCents: number
  dailyRateCents: number
  lastBilledAt: Date
  status: string
  akashDeployment: {
    id: string
    dseq: bigint
    pricePerBlock: string | null
    service: { slug: string } | null
    status: string
  }
}

function buildEscrow(overrides: Partial<FakeEscrow> = {}): FakeEscrow {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
  return {
    id: 'escrow-1',
    orgBillingId: 'org-1',
    akashDeploymentId: 'akash-1',
    depositCents: 0,
    consumedCents: 0,
    dailyRateCents: 2400, // $24/day → $1/hr
    lastBilledAt: twoHoursAgo,
    status: 'ACTIVE',
    akashDeployment: {
      id: 'akash-1',
      dseq: 123n,
      pricePerBlock: '0',
      service: { slug: 'test-svc' },
      status: 'ACTIVE',
    },
    ...overrides,
  }
}

function buildPrisma(initialEscrows: FakeEscrow[]) {
  const escrows = [...initialEscrows]
  const updates: Array<{ where: any; data: any }> = []

  const prisma = {
    deploymentEscrow: {
      findMany: vi.fn().mockImplementation(() => Promise.resolve(escrows)),
      update: vi.fn().mockImplementation(({ where, data }) => {
        updates.push({ where, data })
        const target = escrows.find(e => e.id === where.id)
        if (target) {
          if (data.consumedCents !== undefined) target.consumedCents = data.consumedCents
          if (data.lastBilledAt !== undefined) target.lastBilledAt = data.lastBilledAt
          if (data.status !== undefined) target.status = data.status
        }
        return Promise.resolve(target)
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    phalaDeployment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    organization: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    deploymentPolicy: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    akashDeployment: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any

  return { prisma, updates, escrows }
}

describe('ComputeBillingScheduler.processAkashEscrows — idempotency drift', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getOrgBalanceMock.mockResolvedValue({ balanceCents: 100_000 })
    getOrgMarkupMock.mockResolvedValue({ marginRate: 0 })
  })

  it('advances lastBilledAt and consumedCents even when auth returns alreadyProcessed=true', async () => {
    // Regression test for M1: previously, if billingApi.computeDebit returned
    // { alreadyProcessed: true } (which happens when auth's ledger already has
    // the idempotency key), the scheduler skipped updating lastBilledAt and
    // consumedCents. Next cycle computed a larger hoursToBill under a fresh
    // idempotency key and double-charged the user.
    const { prisma, escrows } = buildPrisma([buildEscrow()])

    computeDebitMock.mockResolvedValue({
      success: true,
      balanceCents: 99_900,
      alreadyProcessed: true, // auth says: already charged under this key
    })

    const scheduler = new ComputeBillingScheduler(prisma)
    await scheduler.runNow({ noPause: true })

    // Debit was attempted (with an idempotency key)
    expect(computeDebitMock).toHaveBeenCalledTimes(1)
    const debitCall = computeDebitMock.mock.calls[0][0]
    expect(debitCall.idempotencyKey).toMatch(/^akash_hourly:escrow-1:/)

    // Critical assertion: even on idempotency hit, the local DB was advanced
    expect(prisma.deploymentEscrow.update).toHaveBeenCalledTimes(1)
    const updateArg = prisma.deploymentEscrow.update.mock.calls[0][0]
    expect(updateArg.where.id).toBe('escrow-1')
    expect(updateArg.data.consumedCents).toBe(escrows[0].consumedCents) // already mutated in place
    expect(updateArg.data.lastBilledAt).toBeInstanceOf(Date)
    expect(updateArg.data.lastBilledAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000
    )

    // On idempotency hit, we must NOT re-attempt the on-chain top-up
    // (we cannot tell whether the prior attempt already did it; the :30
    // health monitor is the safety net)
    expect(topUpDeploymentDepositMock).not.toHaveBeenCalled()
  })

  it('advances lastBilledAt and consumedCents on normal (non-idempotent) debit', async () => {
    const { prisma, escrows } = buildPrisma([
      buildEscrow({
        akashDeployment: {
          id: 'akash-1',
          dseq: 123n,
          pricePerBlock: '100', // non-zero so top-up path runs
          service: { slug: 'test-svc' },
          status: 'ACTIVE',
        },
      }),
    ])

    computeDebitMock.mockResolvedValue({
      success: true,
      balanceCents: 99_900,
      alreadyProcessed: false,
    })

    const scheduler = new ComputeBillingScheduler(prisma)
    await scheduler.runNow({ noPause: true })

    expect(prisma.deploymentEscrow.update).toHaveBeenCalledTimes(1)
    const updateArg = prisma.deploymentEscrow.update.mock.calls[0][0]
    expect(updateArg.data.lastBilledAt).toBeInstanceOf(Date)
    expect(escrows[0].consumedCents).toBeGreaterThan(0)

    // Normal path DOES do the on-chain top-up
    expect(topUpDeploymentDepositMock).toHaveBeenCalledTimes(1)
    expect(topUpDeploymentDepositMock).toHaveBeenCalledWith(123, 60_000) // ppb=100 * 600 blocks
  })

  it('advances lastBilledAt by exactly hoursToBill * 1h so fractional time rolls forward', async () => {
    // Regression for the first-hour leak (Phase 36):
    // Setting lastBilledAt=now discarded the partial hour between the previous
    // marker and the current cron tick, causing a systemic under-charge of up
    // to 1 hour of runtime across every deployment's lifetime.
    //
    // The fix advances lastBilledAt by exactly `hoursToBill * 1h` instead, so
    // the fractional remainder is preserved and picked up on the next cycle
    // (or at final settlement). Capped at `now` so forceMode cannot future-date.
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    const { prisma } = buildPrisma([buildEscrow({ lastBilledAt: twoHoursAgo })])

    computeDebitMock.mockResolvedValue({
      success: true,
      balanceCents: 99_900,
      alreadyProcessed: false,
    })

    const scheduler = new ComputeBillingScheduler(prisma)
    await scheduler.runNow({ noPause: true })

    const updateArg = prisma.deploymentEscrow.update.mock.calls[0][0]
    const newLastBilledAt = updateArg.data.lastBilledAt as Date
    // dailyRateCents=2400 → hourlyRateCents=100. hoursSinceLastBill≈2,
    // hoursToBill=2 → new lastBilledAt = twoHoursAgo + 2h ≈ now.
    const expectedMs = twoHoursAgo.getTime() + 2 * 3_600_000

    // Should be at the 2h-advanced mark, not the raw `now`.
    // Tolerance: 1s for test runtime.
    expect(Math.abs(newLastBilledAt.getTime() - expectedMs)).toBeLessThan(1000)

    // And must not be in the future (forceMode guard).
    expect(newLastBilledAt.getTime()).toBeLessThanOrEqual(Date.now() + 100)
  })

  it('does not future-date lastBilledAt under forceMode when <1h elapsed', async () => {
    // Force-billing with only 30min elapsed would otherwise try to advance
    // lastBilledAt 1h into the future (hoursToBill=Math.max(1, floor(0.5))=1).
    // The Math.min(now, ...) cap prevents that: user gets billed for 1h (the
    // ceiling behavior of the scheduler under force) but next cycle is not
    // silently skipped by a future lastBilledAt.
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000)
    const { prisma } = buildPrisma([buildEscrow({ lastBilledAt: thirtyMinAgo })])

    computeDebitMock.mockResolvedValue({
      success: true,
      balanceCents: 99_900,
      alreadyProcessed: false,
    })

    const scheduler = new ComputeBillingScheduler(prisma)
    await scheduler.runNow({ force: true, noPause: true })

    const updateArg = prisma.deploymentEscrow.update.mock.calls[0][0]
    const newLastBilledAt = updateArg.data.lastBilledAt as Date

    expect(newLastBilledAt.getTime()).toBeLessThanOrEqual(Date.now() + 100)
    expect(newLastBilledAt.getTime()).toBeGreaterThan(thirtyMinAgo.getTime())
  })

  it('does not double-bill after a simulated prior-run crash (sequential runs)', async () => {
    // Simulate: hour H had a prior crash (auth billed, DB not updated).
    // This run is hour H+1. Auth will alreadyProcess key for H-old? No —
    // key is per UTC hour. But the auth side will accept a *new* key for H+1.
    // The danger is that if we hadn't advanced lastBilledAt after the H
    // idempotency hit, at H+1 we'd compute hoursToBill=2 and OVERCHARGE.
    // With the fix, H mirrored → at H+1 hoursToBill=1. This test confirms
    // the mirror occurs so the bug cannot arise.
    const { prisma, escrows } = buildPrisma([buildEscrow()])

    // First run: idempotency hit
    computeDebitMock.mockResolvedValueOnce({
      success: true,
      balanceCents: 99_900,
      alreadyProcessed: true,
    })

    const scheduler = new ComputeBillingScheduler(prisma)
    await scheduler.runNow({ noPause: true })

    const lastBilledAfterFirst = escrows[0].lastBilledAt
    expect(Date.now() - lastBilledAfterFirst.getTime()).toBeLessThan(60_000)

    // Advance clock ~1 hour, second run
    const originalNow = Date.now
    try {
      const future = originalNow() + 60 * 60 * 1000
      Date.now = () => future
      const originalDate = Date
      // @ts-expect-error override
      globalThis.Date = class extends originalDate {
        constructor(...args: any[]) {
          if (args.length === 0) super(future)
          else super(...(args as []))
        }
        static now() {
          return future
        }
      }

      computeDebitMock.mockResolvedValueOnce({
        success: true,
        balanceCents: 99_800,
        alreadyProcessed: false,
      })

      await scheduler.runNow({ noPause: true })

      // Second debit amount should be for 1 hour only (not 2), because we
      // advanced lastBilledAt on the first run.
      const secondCall = computeDebitMock.mock.calls[1][0]
      // dailyRateCents=2400 → $1/hr → 100 cents
      expect(secondCall.amountCents).toBe(100)
      expect(secondCall.description).toMatch(/1h/)

      // @ts-expect-error restore
      globalThis.Date = originalDate
    } finally {
      Date.now = originalNow
    }
  })
})
