/**
 * Deployment Escrow Service
 *
 * Manages the billing metadata record for Akash deployments.
 *
 * Modes (controlled by BILLING_CONFIG.akash.escrowDays):
 *   escrowDays = 0  → Pay-as-you-go. No upfront wallet debit. Daily scheduler
 *                      calls computeDebit directly. Escrow record tracks rate only.
 *   escrowDays > 0  → Pre-funded pool. Wallet debited upfront, daily consumption
 *                      drawn from pool, remainder refunded on close.
 *
 * All wallet operations go through the BillingApiClient → auth service.
 */

import type { PrismaClient, DeploymentEscrow } from '@prisma/client'
import { getBillingApiClient } from './billingApiClient.js'
import { BILLING_CONFIG } from '../../config/billing.js'
import { akashPricePerBlockToUsdPerDay, applyMargin, getAktUsdPrice } from '../../config/pricing.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('escrow-service')

export class EscrowService {
  private billingApi = getBillingApiClient()

  constructor(private prisma: PrismaClient) {}

  // ========================================
  // LIFECYCLE: CREATE (on deploy activation)
  // ========================================

  /**
   * Create billing record for a new Akash deployment.
   *
   * When escrowDays > 0, debits the wallet upfront and creates a pre-funded pool.
   * When escrowDays === 0, creates a tracking record only (no wallet debit).
   *
   * @returns The created DeploymentEscrow record
   * @throws Error with 'INSUFFICIENT_BALANCE' if pre-funded mode and wallet is short
   */
  async createEscrow(args: {
    akashDeploymentId: string
    organizationId: string
    pricePerBlock: string
    marginRate: number
    userId: string
    escrowDays?: number
  }): Promise<DeploymentEscrow> {
    const escrowDays = args.escrowDays ?? BILLING_CONFIG.akash.escrowDays

    const aktPrice = await getAktUsdPrice()
    const rawDailyUsd = akashPricePerBlockToUsdPerDay(args.pricePerBlock, aktPrice)
    const chargedDailyUsd = applyMargin(rawDailyUsd, args.marginRate)
    const dailyRateCents = Math.ceil(chargedDailyUsd * 100)

    if (dailyRateCents <= 0) {
      throw new Error('Calculated daily rate is zero or negative')
    }

    const depositCents = dailyRateCents * escrowDays

    const orgBilling = await this.billingApi.getOrgBilling(args.organizationId)
    if (!orgBilling) {
      throw new Error(`Organization billing not configured for org ${args.organizationId}`)
    }

    if (depositCents > 0) {
      await this.billingApi.escrowDeposit({
        orgBillingId: orgBilling.orgBillingId,
        organizationId: args.organizationId,
        userId: args.userId,
        amountCents: depositCents,
        deploymentId: args.akashDeploymentId,
        description: `Akash escrow deposit (${escrowDays} days @ $${(dailyRateCents / 100).toFixed(2)}/day)`,
      })
    }

    const escrow = await this.prisma.deploymentEscrow.create({
      data: {
        akashDeploymentId: args.akashDeploymentId,
        orgBillingId: orgBilling.orgBillingId,
        organizationId: args.organizationId,
        depositCents,
        dailyRateCents,
        marginRate: args.marginRate,
        status: 'ACTIVE',
        lastBilledAt: new Date(),
      },
    })

    log.info(
      { deploymentId: args.akashDeploymentId, depositCents, dailyRateCents, mode: depositCents > 0 ? 'pre-funded' : 'pay-as-you-go' },
      'Created escrow for deployment'
    )

    return escrow
  }

  // ========================================
  // LIFECYCLE: DAILY CONSUMPTION (pre-funded mode only)
  // ========================================

  /**
   * Process daily consumption from a pre-funded escrow pool.
   * Only meaningful when depositCents > 0. For pay-as-you-go mode,
   * the daily scheduler calls computeDebit directly instead.
   *
   * @param force — bypass the minimum-interval guard (for manual testing)
   * @returns Updated escrow, or null if skipped
   */
  async processDailyConsumption(escrowId: string, force = false): Promise<DeploymentEscrow | null> {
    const escrow = await this.prisma.deploymentEscrow.findUnique({
      where: { id: escrowId },
    })

    if (!escrow || escrow.status !== 'ACTIVE') {
      return null
    }

    if (escrow.depositCents === 0) {
      return null
    }

    const now = new Date()
    const lastBilled = escrow.lastBilledAt || escrow.createdAt
    const hoursSinceLastBill = (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

    if (hoursSinceLastBill < BILLING_CONFIG.akash.minBillingIntervalHours && !force) {
      return null
    }

    const daysToBill = Math.max(1, Math.floor(hoursSinceLastBill / 24))
    const consumptionCents = escrow.dailyRateCents * daysToBill
    const newConsumed = escrow.consumedCents + consumptionCents
    const remaining = escrow.depositCents - newConsumed

    if (remaining < 0) {
      return this.prisma.deploymentEscrow.update({
        where: { id: escrowId },
        data: {
          consumedCents: escrow.depositCents,
          status: 'DEPLETED',
          lastBilledAt: now,
        },
      })
    }

    return this.prisma.deploymentEscrow.update({
      where: { id: escrowId },
      data: {
        consumedCents: newConsumed,
        lastBilledAt: now,
      },
    })
  }

  // ========================================
  // LIFECYCLE: REFUND (on close)
  // ========================================

  /**
   * Refund remaining escrow when deployment is closed.
   *
   * For pay-as-you-go (depositCents=0), marks REFUNDED with $0 refund.
   * For pre-funded, refunds the unused portion to wallet.
   *
   * If the refund API call fails, the record is NOT marked REFUNDED
   * so it can be retried.
   *
   * @returns The refund amount in cents, or 0 if nothing to refund
   */
  async refundEscrow(akashDeploymentId: string): Promise<number> {
    const escrow = await this.prisma.deploymentEscrow.findUnique({
      where: { akashDeploymentId },
    })

    if (!escrow) {
      log.info({ deploymentId: akashDeploymentId }, 'No escrow found for deployment')
      return 0
    }

    if (escrow.status === 'REFUNDED') {
      log.info({ deploymentId: akashDeploymentId }, 'Escrow already refunded for deployment')
      return escrow.refundedCents
    }

    const remaining = Math.max(0, escrow.depositCents - escrow.consumedCents)

    if (remaining > 0) {
      await this.billingApi.escrowRefund({
        orgBillingId: escrow.orgBillingId,
        amountCents: remaining,
        deploymentId: akashDeploymentId,
        description: `Akash escrow refund — deployment closed ($${(remaining / 100).toFixed(2)})`,
      })
    }

    await this.prisma.deploymentEscrow.update({
      where: { id: escrow.id },
      data: {
        status: 'REFUNDED',
        refundedCents: remaining,
      },
    })

    log.info({ deploymentId: akashDeploymentId, refundedCents: remaining }, 'Refunded escrow for deployment')

    return remaining
  }

  // ========================================
  // LIFECYCLE: PAUSE / RESUME
  // ========================================

  async pauseEscrow(akashDeploymentId: string): Promise<void> {
    await this.prisma.deploymentEscrow.updateMany({
      where: {
        akashDeploymentId,
        status: { in: ['ACTIVE', 'DEPLETED'] },
      },
      data: { status: 'PAUSED' },
    })
  }

  async resumeEscrow(akashDeploymentId: string): Promise<void> {
    await this.prisma.deploymentEscrow.updateMany({
      where: {
        akashDeploymentId,
        status: 'PAUSED',
      },
      data: {
        status: 'ACTIVE',
        lastBilledAt: new Date(),
      },
    })
  }

  // ========================================
  // QUERIES
  // ========================================

  async getEscrow(akashDeploymentId: string): Promise<DeploymentEscrow | null> {
    return this.prisma.deploymentEscrow.findUnique({
      where: { akashDeploymentId },
    })
  }

  async getActiveEscrowsForOrg(orgBillingId: string): Promise<DeploymentEscrow[]> {
    return this.prisma.deploymentEscrow.findMany({
      where: {
        orgBillingId,
        status: 'ACTIVE',
      },
    })
  }

  async getOrgDailyBurnCents(orgBillingId: string): Promise<number> {
    const result = await this.prisma.deploymentEscrow.aggregate({
      where: {
        orgBillingId,
        status: 'ACTIVE',
      },
      _sum: {
        dailyRateCents: true,
      },
    })

    return result._sum.dailyRateCents || 0
  }
}

let instance: EscrowService | null = null

export function getEscrowService(prisma: PrismaClient): EscrowService {
  if (!instance) {
    instance = new EscrowService(prisma)
  }
  return instance
}
