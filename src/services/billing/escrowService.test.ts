import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'

const escrowDepositMock = vi.fn()
const escrowRefundMock = vi.fn()
const getOrgBillingMock = vi.fn()
const getAktUsdPriceMock = vi.fn()

vi.mock('./billingApiClient.js', () => ({
  getBillingApiClient: vi.fn(() => ({
    escrowDeposit: escrowDepositMock,
    escrowRefund: escrowRefundMock,
    getOrgBilling: getOrgBillingMock,
  })),
}))

vi.mock('../../config/pricing.js', () => ({
  getAktUsdPrice: () => getAktUsdPriceMock(),
  akashPricePerBlockToUsdPerDay: (ppb: string, _denom: string = 'uact') => {
    const price = parseFloat(ppb)
    return (price * 14400) / 1_000_000
  },
  applyMargin: (raw: number, rate: number) => raw * (1 + rate),
}))

vi.mock('../../config/billing.js', () => ({
  BILLING_CONFIG: {
    akash: {
      escrowDays: 0,
      billingIntervalHours: 24,
      minBillingIntervalHours: 20,
      minBalanceCentsToLaunch: 100,
    },
    phala: { billingIntervalHours: 1, minBalanceCentsToLaunch: 100 },
    scheduler: { cronExpression: '0 3 * * *' },
    thresholds: { lowBalanceHours: 1 },
  },
}))

import { EscrowService } from './escrowService.js'

describe('EscrowService', () => {
  let service: EscrowService
  let prisma: any

  beforeEach(() => {
    vi.clearAllMocks()
    getAktUsdPriceMock.mockResolvedValue(1.0)
    getOrgBillingMock.mockResolvedValue({ orgBillingId: 'org-billing-1' })
    escrowDepositMock.mockResolvedValue({ success: true, balanceCents: 5000 })
    escrowRefundMock.mockResolvedValue({ success: true, balanceCents: 5000 })

    prisma = {
      deploymentEscrow: {
        create: vi.fn().mockImplementation(({ data }) => Promise.resolve({
          id: 'escrow-new',
          ...data,
          consumedCents: 0,
          refundedCents: 0,
          createdAt: new Date(),
        })),
        findUnique: vi.fn(),
        update: vi.fn().mockImplementation(({ data }) => Promise.resolve(data)),
        updateMany: vi.fn(),
      },
    }

    service = new EscrowService(prisma as unknown as PrismaClient)
  })

  describe('createEscrow (pay-as-you-go, escrowDays=0)', () => {
    it('creates record with depositCents=0 and does NOT call escrowDeposit', async () => {
      const result = await service.createEscrow({
        akashDeploymentId: 'dep-1',
        organizationId: 'org-1',
        pricePerBlock: '100',
        marginRate: 0.25,
        userId: 'user-1',
      })

      expect(result.depositCents).toBe(0)
      expect(result.dailyRateCents).toBeGreaterThan(0)
      expect(result.status).toBe('ACTIVE')
      expect(escrowDepositMock).not.toHaveBeenCalled()
    })

    it('computes dailyRateCents correctly with margin', async () => {
      const result = await service.createEscrow({
        akashDeploymentId: 'dep-2',
        organizationId: 'org-1',
        pricePerBlock: '1000',
        marginRate: 0.25,
        userId: 'user-1',
      })

      // 1000 uakt * 14400 blocks/day = 14_400_000 uakt/day = 14.4 AKT/day
      // At $1.00/AKT = $14.40/day raw; with 25% margin = $18.00/day = 1800 cents
      expect(result.dailyRateCents).toBe(1800)
    })
  })

  describe('createEscrow (pre-funded, escrowDays > 0)', () => {
    it('debits wallet and creates record with positive depositCents', async () => {
      const result = await service.createEscrow({
        akashDeploymentId: 'dep-3',
        organizationId: 'org-1',
        pricePerBlock: '1000',
        marginRate: 0.25,
        userId: 'user-1',
        escrowDays: 7,
      })

      expect(result.depositCents).toBe(1800 * 7)
      expect(escrowDepositMock).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 1800 * 7,
          orgBillingId: 'org-billing-1',
        })
      )
    })
  })

  describe('refundEscrow', () => {
    it('skips API call when depositCents=0 and marks REFUNDED', async () => {
      prisma.deploymentEscrow.findUnique.mockResolvedValue({
        id: 'escrow-payg',
        akashDeploymentId: 'dep-payg',
        depositCents: 0,
        consumedCents: 500,
        status: 'ACTIVE',
        orgBillingId: 'org-billing-1',
        refundedCents: 0,
      })

      const refunded = await service.refundEscrow('dep-payg')

      expect(refunded).toBe(0)
      expect(escrowRefundMock).not.toHaveBeenCalled()
      expect(prisma.deploymentEscrow.update).toHaveBeenCalledWith({
        where: { id: 'escrow-payg' },
        data: { status: 'REFUNDED', refundedCents: 0 },
      })
    })

    it('refunds remaining deposit for pre-funded escrow', async () => {
      prisma.deploymentEscrow.findUnique.mockResolvedValue({
        id: 'escrow-pf',
        akashDeploymentId: 'dep-pf',
        depositCents: 5000,
        consumedCents: 2000,
        status: 'ACTIVE',
        orgBillingId: 'org-billing-1',
        refundedCents: 0,
      })

      const refunded = await service.refundEscrow('dep-pf')

      expect(refunded).toBe(3000)
      expect(escrowRefundMock).toHaveBeenCalledWith(
        expect.objectContaining({
          amountCents: 3000,
          orgBillingId: 'org-billing-1',
        })
      )
    })

    it('does NOT mark REFUNDED if API call fails', async () => {
      prisma.deploymentEscrow.findUnique.mockResolvedValue({
        id: 'escrow-fail',
        akashDeploymentId: 'dep-fail',
        depositCents: 5000,
        consumedCents: 1000,
        status: 'ACTIVE',
        orgBillingId: 'org-billing-1',
        refundedCents: 0,
      })
      escrowRefundMock.mockRejectedValue(new Error('auth service down'))

      await expect(service.refundEscrow('dep-fail')).rejects.toThrow('auth service down')
      expect(prisma.deploymentEscrow.update).not.toHaveBeenCalled()
    })
  })

  describe('processDailyConsumption', () => {
    it('returns null for pay-as-you-go escrows (depositCents=0)', async () => {
      prisma.deploymentEscrow.findUnique.mockResolvedValue({
        id: 'escrow-payg',
        status: 'ACTIVE',
        depositCents: 0,
        dailyRateCents: 100,
        consumedCents: 0,
        lastBilledAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      })

      const result = await service.processDailyConsumption('escrow-payg')
      expect(result).toBeNull()
    })
  })
})
