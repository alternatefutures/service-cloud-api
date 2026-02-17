/**
 * Deployment Escrow Service
 *
 * Manages the platform-level USD escrow for Akash deployments.
 * Mirrors Akash's on-chain escrow pattern:
 *   Deploy  → Debit wallet, create escrow record
 *   Daily   → Consume from escrow (daily rate)
 *   Close   → Refund remaining escrow to wallet
 *
 * All wallet operations go through the BillingApiClient → auth service.
 */

import type { PrismaClient, DeploymentEscrow, EscrowStatus } from '@prisma/client'
import { getBillingApiClient } from './billingApiClient.js'
import { akashPricePerBlockToUsdPerDay, applyMargin } from '../../config/pricing.js'

/** Default escrow covers 30 days of estimated deployment cost */
const DEFAULT_ESCROW_DAYS = 30

export class EscrowService {
  private billingApi = getBillingApiClient()

  constructor(private prisma: PrismaClient) {}

  // ========================================
  // LIFECYCLE: DEPOSIT (on deploy)
  // ========================================

  /**
   * Create escrow for a new Akash deployment.
   * Called BEFORE on-chain deployment so we fail fast on insufficient balance.
   *
   * @returns The created DeploymentEscrow record
   * @throws Error with message 'INSUFFICIENT_BALANCE' if wallet has insufficient funds
   */
  async createEscrow(args: {
    akashDeploymentId: string
    organizationId: string
    pricePerBlock: string // uAKT per block from bid
    marginRate: number // plan markup (e.g. 0.25)
    userId: string
    escrowDays?: number // how many days to pre-fund (default 30)
  }): Promise<DeploymentEscrow> {
    const escrowDays = args.escrowDays || DEFAULT_ESCROW_DAYS

    // Calculate daily cost in USD with margin
    const rawDailyUsd = akashPricePerBlockToUsdPerDay(args.pricePerBlock)
    const chargedDailyUsd = applyMargin(rawDailyUsd, args.marginRate)
    const dailyRateCents = Math.ceil(chargedDailyUsd * 100)
    const depositCents = dailyRateCents * escrowDays

    if (depositCents <= 0) {
      throw new Error('Calculated escrow deposit is zero or negative')
    }

    // Resolve org billing ID
    const orgBilling = await this.billingApi.getOrgBilling(args.organizationId)

    // Debit wallet (fails if insufficient balance)
    await this.billingApi.escrowDeposit({
      orgBillingId: orgBilling.orgBillingId,
      organizationId: args.organizationId,
      userId: args.userId,
      amountCents: depositCents,
      deploymentId: args.akashDeploymentId,
      description: `Akash escrow deposit (${escrowDays} days @ $${(dailyRateCents / 100).toFixed(2)}/day)`,
    })

    // Create escrow record
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

    console.log(
      `[EscrowService] Created escrow for deployment ${args.akashDeploymentId}: ` +
      `$${(depositCents / 100).toFixed(2)} deposit, $${(dailyRateCents / 100).toFixed(2)}/day`
    )

    return escrow
  }

  // ========================================
  // LIFECYCLE: DAILY CONSUMPTION
  // ========================================

  /**
   * Process daily consumption for an active escrow.
   * Called by the daily billing scheduler.
   *
   * @param force — bypass the 20-hour minimum guard (for manual testing)
   * @returns Updated escrow, or null if already billed today
   */
  async processDailyConsumption(escrowId: string, force = false): Promise<DeploymentEscrow | null> {
    const escrow = await this.prisma.deploymentEscrow.findUnique({
      where: { id: escrowId },
    })

    if (!escrow || escrow.status !== 'ACTIVE') {
      return null
    }

    // Calculate days since last billing
    const now = new Date()
    const lastBilled = escrow.lastBilledAt || escrow.createdAt
    const hoursSinceLastBill = (now.getTime() - lastBilled.getTime()) / (1000 * 60 * 60)

    // Don't bill if less than 20 hours since last billing (prevent double-billing)
    if (hoursSinceLastBill < 20 && !force) {
      return null
    }

    // Calculate days to bill (can be >1 if scheduler was down)
    const daysToBill = Math.max(1, Math.floor(hoursSinceLastBill / 24))
    const consumptionCents = escrow.dailyRateCents * daysToBill
    const newConsumed = escrow.consumedCents + consumptionCents
    const remaining = escrow.depositCents - newConsumed

    if (remaining < 0) {
      // Escrow depleted — try to auto-top-up from wallet
      const needed = Math.abs(remaining)
      try {
        await this.billingApi.computeDebit({
          orgBillingId: escrow.orgBillingId,
          amountCents: needed,
          serviceType: 'akash_escrow_topup',
          provider: 'akash',
          resource: escrow.akashDeploymentId,
          description: `Akash escrow auto-top-up ($${(needed / 100).toFixed(2)})`,
          idempotencyKey: `escrow_topup:${escrow.id}:${now.toISOString().slice(0, 10)}`,
        })

        // Top-up succeeded — increase deposit
        return this.prisma.deploymentEscrow.update({
          where: { id: escrowId },
          data: {
            consumedCents: newConsumed,
            depositCents: escrow.depositCents + needed,
            lastBilledAt: now,
          },
        })
      } catch {
        // Top-up failed — mark escrow as depleted
        return this.prisma.deploymentEscrow.update({
          where: { id: escrowId },
          data: {
            consumedCents: escrow.depositCents, // cap at deposit
            status: 'DEPLETED',
            lastBilledAt: now,
          },
        })
      }
    }

    // Normal consumption within escrow
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
   * @returns The refund amount in cents, or 0 if nothing to refund
   */
  async refundEscrow(akashDeploymentId: string): Promise<number> {
    const escrow = await this.prisma.deploymentEscrow.findUnique({
      where: { akashDeploymentId },
    })

    if (!escrow) {
      console.log(`[EscrowService] No escrow found for deployment ${akashDeploymentId}`)
      return 0
    }

    if (escrow.status === 'REFUNDED') {
      console.log(`[EscrowService] Escrow already refunded for deployment ${akashDeploymentId}`)
      return escrow.refundedCents
    }

    const remaining = Math.max(0, escrow.depositCents - escrow.consumedCents)

    if (remaining > 0) {
      try {
        await this.billingApi.escrowRefund({
          orgBillingId: escrow.orgBillingId,
          amountCents: remaining,
          deploymentId: akashDeploymentId,
          description: `Akash escrow refund — deployment closed ($${(remaining / 100).toFixed(2)})`,
        })
      } catch (error) {
        console.error(`[EscrowService] Failed to refund escrow for ${akashDeploymentId}:`, error)
        // Still mark as refunded to prevent double-refund attempts
      }
    }

    await this.prisma.deploymentEscrow.update({
      where: { id: escrow.id },
      data: {
        status: 'REFUNDED',
        refundedCents: remaining,
      },
    })

    console.log(
      `[EscrowService] Refunded $${(remaining / 100).toFixed(2)} for deployment ${akashDeploymentId}`
    )

    return remaining
  }

  // ========================================
  // LIFECYCLE: PAUSE / RESUME
  // ========================================

  /**
   * Pause an escrow (deployment suspended due to low balance)
   */
  async pauseEscrow(akashDeploymentId: string): Promise<void> {
    await this.prisma.deploymentEscrow.updateMany({
      where: {
        akashDeploymentId,
        status: { in: ['ACTIVE', 'DEPLETED'] },
      },
      data: { status: 'PAUSED' },
    })
  }

  /**
   * Resume a paused escrow (balance restored after topup)
   */
  async resumeEscrow(akashDeploymentId: string): Promise<void> {
    await this.prisma.deploymentEscrow.updateMany({
      where: {
        akashDeploymentId,
        status: 'PAUSED',
      },
      data: {
        status: 'ACTIVE',
        lastBilledAt: new Date(), // reset billing clock
      },
    })
  }

  // ========================================
  // QUERIES
  // ========================================

  /**
   * Get escrow for a deployment
   */
  async getEscrow(akashDeploymentId: string): Promise<DeploymentEscrow | null> {
    return this.prisma.deploymentEscrow.findUnique({
      where: { akashDeploymentId },
    })
  }

  /**
   * Get all active escrows for an org
   */
  async getActiveEscrowsForOrg(orgBillingId: string): Promise<DeploymentEscrow[]> {
    return this.prisma.deploymentEscrow.findMany({
      where: {
        orgBillingId,
        status: 'ACTIVE',
      },
    })
  }

  /**
   * Get total daily burn rate for an org (from active escrows)
   */
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

// Singleton
let instance: EscrowService | null = null

export function getEscrowService(prisma: PrismaClient): EscrowService {
  if (!instance) {
    instance = new EscrowService(prisma)
  }
  return instance
}
