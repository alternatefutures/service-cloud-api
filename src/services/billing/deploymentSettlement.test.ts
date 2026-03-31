import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import {
  calculateProratedAkashCents,
  calculateProratedPhalaCents,
  processFinalPhalaBilling,
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
  getAktUsdPrice: vi.fn(async () => 1),
  akashPricePerBlockToUsdPerDay: vi.fn(() => 1.44),
  applyMargin: vi.fn((raw: number, margin: number) => raw * (1 + margin)),
}))

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
    } as unknown as PrismaClient

    const additionalCents = await settleAkashEscrowToTime(prisma, 'akash-1', settledAt)

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
    } as unknown as PrismaClient

    const additionalCents = await settleAkashEscrowToTime(prisma, 'akash-payg', settledAt)

    expect(additionalCents).toBe(60)
    expect(computeDebitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgBillingId: 'org-billing-2',
        amountCents: 60,
        serviceType: 'akash_compute',
        provider: 'akash',
        resource: 'test-svc',
        idempotencyKey: `akash_final:akash-payg:${settledAt.toISOString()}`,
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
    } as unknown as PrismaClient

    const additionalCents = await settleAkashEscrowToTime(
      prisma,
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
        idempotencyKey:
          'akash_final_no_escrow:akash-missing-escrow:2026-03-31T01:00:00.000Z',
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
    } as unknown as PrismaClient

    const finalChargeCents = await processFinalPhalaBilling(
      prisma,
      'phala-1',
      billedAt,
      'test_final'
    )

    expect(finalChargeCents).toBe(80)
    expect(computeDebitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        orgBillingId: 'org-billing-1',
        amountCents: 80,
        idempotencyKey: 'test_final:phala-1:2026-03-29T00:40:00.000Z',
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
})
