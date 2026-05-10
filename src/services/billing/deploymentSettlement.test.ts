import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  calculateProratedAkashCents,
  calculateProratedPhalaCents,
  processFinalPhalaBilling,
  processFinalSpheronBilling,
  settleAkashEscrowToTime,
} from './deploymentSettlement.js'

const computeDebitMock = vi.fn()
const getOrgBillingMock = vi.fn()
const getOrgMarkupMock = vi.fn()

vi.mock('./billingApiClient.js', () => ({
  getBillingApiClient: vi.fn(() => ({
    computeDebit: computeDebitMock,
    getOrgBilling: getOrgBillingMock,
    getOrgMarkup: getOrgMarkupMock,
  })),
}))

vi.mock('../../config/pricing.js', () => ({
  akashPricePerBlockToUsdPerDay: vi.fn(() => 1.44),
  applyMargin: vi.fn((raw: number, margin: number) => raw * (1 + margin)),
}))

/**
 * Add a stub policySettlementLedger to a prisma test double so the new
 * write-ahead settle path can run without exploding. We do NOT track
 * call assertions on the ledger here — that is exercised in
 * settlementLedger.test.ts. The stub just needs to behave like the
 * happy-path Prisma client (create returns the row, update returns it
 * back).
 */
function stubLedger(prisma: any) {
  prisma.policySettlementLedger = {
    create: vi.fn().mockImplementation(({ data }: { data: any }) => Promise.resolve({
      id: `ledger-${data.idempotencyKey}`,
      ...data,
      attemptCount: 0,
      committedAt: null,
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    findUnique: vi.fn(),
    update: vi.fn().mockImplementation(({ where, data }: { where: any; data: any }) =>
      Promise.resolve({ id: where.id, ...data }),
    ),
  }
  return prisma
}

describe('deploymentSettlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    computeDebitMock.mockResolvedValue({
      success: true,
      balanceCents: 0,
      alreadyProcessed: false,
    })
    getOrgBillingMock.mockResolvedValue({ orgBillingId: 'org-billing-fallback' })
    getOrgMarkupMock.mockResolvedValue({ marginRate: 0.2 })
  })

  it('settles pre-funded Akash escrow by updating consumedCents (no wallet debit)', async () => {
    const settledAt = new Date('2026-03-29T00:40:00.000Z')
    const prisma = {
      deploymentEscrow: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'escrow-1',
          akashDeploymentId: 'akash-1',
          orgBillingId: 'org-billing-1',
          status: 'ACTIVE',
          lastBilledAt: new Date('2026-03-29T00:00:00.000Z'),
          createdAt: new Date('2026-03-29T00:00:00.000Z'),
          dailyRateCents: 1440,
          consumedCents: 0,
          depositCents: 10_000,
          marginRate: 0.2,
          akashDeployment: {
            policyId: 'policy-1',
            dseq: BigInt(12345),
            service: {
              slug: 'milady-gateway-kg2f',
              name: 'Milady Gateway',
              templateId: 'milady-gateway',
              project: { userId: 'user-1' },
            },
          },
        }),
        update: vi.fn(),
      },
      deploymentPolicy: {
        update: vi.fn(),
      },
    }
    stubLedger(prisma)

    const additionalCents = await settleAkashEscrowToTime(prisma as unknown as PrismaClient, 'akash-1', settledAt)

    expect(additionalCents).toBe(40)
    expect(prisma.deploymentEscrow.update).toHaveBeenCalledWith({
      where: { id: 'escrow-1' },
      data: {
        consumedCents: 40,
        lastBilledAt: settledAt,
      },
    })
    expect(prisma.deploymentPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-1' },
      data: { totalSpentUsd: 0.4 },
    })
    expect(computeDebitMock).not.toHaveBeenCalled()
  })

  it('settles pay-as-you-go Akash by calling computeDebit', async () => {
    const settledAt = new Date('2026-03-31T01:00:00.000Z')
    const prisma = {
      deploymentEscrow: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'escrow-payg',
          akashDeploymentId: 'akash-payg',
          orgBillingId: 'org-billing-2',
          status: 'ACTIVE',
          lastBilledAt: new Date('2026-03-31T00:00:00.000Z'),
          createdAt: new Date('2026-03-31T00:00:00.000Z'),
          dailyRateCents: 1440,
          consumedCents: 0,
          depositCents: 0,
          marginRate: 0.25,
          akashDeployment: {
            policyId: null,
            dseq: BigInt(99999),
            service: {
              slug: 'test-svc',
              name: 'Test Service',
              templateId: 'test-template',
              project: { userId: 'user-2' },
            },
          },
        }),
        update: vi.fn(),
      },
      deploymentPolicy: {
        update: vi.fn(),
      },
    }
    stubLedger(prisma)

    const additionalCents = await settleAkashEscrowToTime(prisma as unknown as PrismaClient, 'akash-payg', settledAt)

    expect(additionalCents).toBe(60)
    expect(computeDebitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgBillingId: 'org-billing-2',
        amountCents: 60,
        serviceType: 'akash_compute',
        provider: 'akash',
        resource: 'test-svc',
        idempotencyKey: expect.stringMatching(/^akash_final:akash-payg:\d+$/),
      })
    )
  })

  it('settles Akash shutdown with compute debit even when escrow record is missing', async () => {
    const settledAt = new Date('2026-03-31T01:00:00.000Z')
    const prisma = {
      deploymentEscrow: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
      akashDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'akash-missing-escrow',
          dseq: BigInt(26152298),
          deployedAt: new Date('2026-03-31T00:00:00.000Z'),
          createdAt: new Date('2026-03-30T23:50:00.000Z'),
          policyId: 'policy-fallback',
          pricePerBlock: '100',
          dailyRateCentsCharged: 144,
          service: {
            slug: 'milady-gateway-vlxk',
            project: { organizationId: 'org-1' },
          },
        }),
      },
      deploymentPolicy: {
        update: vi.fn(),
      },
    }
    stubLedger(prisma)

    const additionalCents = await settleAkashEscrowToTime(
      prisma as unknown as PrismaClient,
      'akash-missing-escrow',
      settledAt
    )

    expect(additionalCents).toBe(6)
    expect(computeDebitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgBillingId: 'org-billing-fallback',
        amountCents: 6,
        serviceType: 'akash_compute',
        provider: 'akash',
        resource: 'milady-gateway-vlxk',
        idempotencyKey: expect.stringMatching(
          /^akash_final_no_escrow:akash-missing-escrow:\d+$/,
        ),
      })
    )
    expect(prisma.deploymentPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-fallback' },
      data: { totalSpentUsd: { increment: 0.06 } },
    })
  })

  it('charges Phala shutdown usage to the nearest minute and updates totals', async () => {
    const billedAt = new Date('2026-03-29T00:40:00.000Z')
    const prisma = {
      phalaDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'phala-1',
          orgBillingId: 'org-billing-1',
          hourlyRateCents: 120,
          lastBilledAt: new Date('2026-03-29T00:00:00.000Z'),
          activeStartedAt: new Date('2026-03-29T00:00:00.000Z'),
          createdAt: new Date('2026-03-29T00:00:00.000Z'),
          totalBilledCents: 300,
          cvmSize: 'tdx.large',
          policyId: 'policy-2',
        }),
        update: vi.fn(),
      },
      deploymentPolicy: {
        update: vi.fn(),
      },
    }
    stubLedger(prisma)

    const finalChargeCents = await processFinalPhalaBilling(
      prisma as unknown as PrismaClient,
      'phala-1',
      billedAt,
      'test_final'
    )

    expect(finalChargeCents).toBe(80)
    expect(computeDebitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgBillingId: 'org-billing-1',
        amountCents: 80,
        idempotencyKey: expect.stringMatching(/^test_final:phala-1:\d+$/),
      })
    )
    expect(prisma.phalaDeployment.update).toHaveBeenCalledWith({
      where: { id: 'phala-1' },
      data: {
        lastBilledAt: billedAt,
        totalBilledCents: 380,
      },
    })
    expect(prisma.deploymentPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-2' },
      data: { totalSpentUsd: 3.8 },
    })
  })

  it('keeps the minute-level prorated helpers stable', () => {
    expect(calculateProratedAkashCents(1440, 40 * 60 * 1000)).toBe(40)
    expect(calculateProratedPhalaCents(120, 40 * 60 * 1000)).toBe(80)
  })

  // ===== Spheron =====
  //
  // Phase B contracts under test:
  //   1. Floor at 20 minutes when actual lifetime < 20m (Spheron's
  //      server-side minimum-runtime contract).
  //   2. Floor does NOT apply when actual lifetime > 20m.
  //   3. Floor does NOT apply when an hourly debit has already advanced
  //      lastBilledAt past the floor (residual elapsed math wins).
  //   4. Phase 34 — `alreadyProcessed: true` returns early WITHOUT
  //      writing local lastBilledAt / totalBilledCents (the prior commit
  //      already wrote them; this is the canonical FINAL_SETTLEMENT shape
  //      mirrored from processFinalPhalaBilling).
  //   5. No-op when the deployment is missing orgBillingId or rate.

  it('Spheron: applies 20-min minimum-runtime floor on sub-20-min closes', async () => {
    // VM ran for 5 actual minutes; Spheron will charge us 20 min anyway.
    // 60c/hr * 20/60 hr = 20c (ceiled).
    const activeStartedAt = new Date('2026-05-06T10:00:00.000Z')
    const billedAt = new Date('2026-05-06T10:05:00.000Z') // 5 min later
    const prisma = {
      spheronDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'spheron-floored',
          orgBillingId: 'org-billing-1',
          hourlyRateCents: 60,
          lastBilledAt: null,
          activeStartedAt,
          createdAt: activeStartedAt,
          totalBilledCents: 0,
          gpuType: 'A4000_PCIE',
          provider: 'spheron-ai',
          policyId: null,
        }),
        update: vi.fn(),
      },
      deploymentPolicy: { update: vi.fn() },
    }
    stubLedger(prisma)

    const charged = await processFinalSpheronBilling(
      prisma as unknown as PrismaClient,
      'spheron-floored',
      billedAt,
    )

    expect(charged).toBe(20)
    expect(computeDebitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'spheron',
        serviceType: 'spheron_vm',
        amountCents: 20,
        idempotencyKey: expect.stringMatching(/^spheron_final:spheron-floored:\d+$/),
      })
    )
    expect(prisma.spheronDeployment.update).toHaveBeenCalledWith({
      where: { id: 'spheron-floored' },
      data: {
        lastBilledAt: billedAt,
        totalBilledCents: 20,
      },
    })
  })

  it('Spheron: skips floor when actual lifetime > 20 min', async () => {
    // VM ran for 40 actual minutes; floor irrelevant. 60c/hr * 40/60 hr = 40c.
    const activeStartedAt = new Date('2026-05-06T10:00:00.000Z')
    const billedAt = new Date('2026-05-06T10:40:00.000Z')
    const prisma = {
      spheronDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'spheron-real',
          orgBillingId: 'org-billing-1',
          hourlyRateCents: 60,
          lastBilledAt: null,
          activeStartedAt,
          createdAt: activeStartedAt,
          totalBilledCents: 0,
          gpuType: 'H100',
          provider: 'spheron-ai',
          policyId: null,
        }),
        update: vi.fn(),
      },
      deploymentPolicy: { update: vi.fn() },
    }
    stubLedger(prisma)

    const charged = await processFinalSpheronBilling(
      prisma as unknown as PrismaClient,
      'spheron-real',
      billedAt,
    )

    expect(charged).toBe(40)
  })

  it('Spheron: floor does not double-charge when hourly debit already ran past it', async () => {
    // Lifetime 70m; hourly debit at 60m advanced lastBilledAt; final
    // settlement should bill the residual 10m only — NOT the floor.
    const activeStartedAt = new Date('2026-05-06T10:00:00.000Z')
    const lastBilledAt = new Date('2026-05-06T11:00:00.000Z')
    const billedAt = new Date('2026-05-06T11:10:00.000Z')
    const prisma = {
      spheronDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'spheron-residual',
          orgBillingId: 'org-billing-1',
          hourlyRateCents: 120,
          lastBilledAt,
          activeStartedAt,
          createdAt: activeStartedAt,
          totalBilledCents: 120,
          gpuType: 'H100',
          provider: 'spheron-ai',
          policyId: null,
        }),
        update: vi.fn(),
      },
      deploymentPolicy: { update: vi.fn() },
    }
    stubLedger(prisma)

    const charged = await processFinalSpheronBilling(
      prisma as unknown as PrismaClient,
      'spheron-residual',
      billedAt,
    )

    // 120c/hr * 10/60 hr = 20c residual.
    expect(charged).toBe(20)
    expect(prisma.spheronDeployment.update).toHaveBeenCalledWith({
      where: { id: 'spheron-residual' },
      data: {
        lastBilledAt: billedAt,
        totalBilledCents: 140,
      },
    })
  })

  it('Spheron: alreadyProcessed=true returns the amount WITHOUT mirroring locally (Phase 34 final-settlement shape)', async () => {
    computeDebitMock.mockResolvedValueOnce({
      success: true,
      balanceCents: 0,
      alreadyProcessed: true,
    })

    const activeStartedAt = new Date('2026-05-06T10:00:00.000Z')
    const billedAt = new Date('2026-05-06T11:00:00.000Z') // 60 min later
    const prisma = {
      spheronDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'spheron-idem',
          orgBillingId: 'org-billing-1',
          hourlyRateCents: 60,
          lastBilledAt: null,
          activeStartedAt,
          createdAt: activeStartedAt,
          totalBilledCents: 0,
          gpuType: 'H100',
          provider: 'spheron-ai',
          policyId: null,
        }),
        update: vi.fn(),
      },
      deploymentPolicy: { update: vi.fn() },
    }
    stubLedger(prisma)

    const charged = await processFinalSpheronBilling(
      prisma as unknown as PrismaClient,
      'spheron-idem',
      billedAt,
    )

    // Returns the amount that WOULD have been charged (60c/hr * 60min = 60c)
    expect(charged).toBe(60)
    // But does NOT mirror to local DB — the prior committing path already did.
    // This matches processFinalPhalaBilling's behavior. The recurring
    // path (processSpheronDebits) mirrors locally on alreadyProcessed; the
    // final-settlement path does not.
    expect(prisma.spheronDeployment.update).not.toHaveBeenCalled()
  })

  it('Spheron: no-ops when row missing orgBillingId or hourlyRateCents', async () => {
    const prisma = {
      spheronDeployment: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'spheron-orphaned',
          orgBillingId: null,
          hourlyRateCents: 60,
          lastBilledAt: null,
          activeStartedAt: new Date('2026-05-06T10:00:00.000Z'),
          createdAt: new Date('2026-05-06T10:00:00.000Z'),
          totalBilledCents: 0,
          gpuType: 'H100',
          provider: 'spheron-ai',
          policyId: null,
        }),
        update: vi.fn(),
      },
      deploymentPolicy: { update: vi.fn() },
    }
    stubLedger(prisma)

    const charged = await processFinalSpheronBilling(
      prisma as unknown as PrismaClient,
      'spheron-orphaned',
      new Date('2026-05-06T10:30:00.000Z'),
    )

    expect(charged).toBe(0)
    expect(computeDebitMock).not.toHaveBeenCalled()
    expect(prisma.spheronDeployment.update).not.toHaveBeenCalled()
  })
})
