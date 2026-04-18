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
import { akashPricePerBlockToUsdPerDay, applyMargin } from '../../config/pricing.js'
import { createLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'

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

    const rawDailyUsd = akashPricePerBlockToUsdPerDay(args.pricePerBlock, 'uact')
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

    // Write-ahead. The previous flow called escrowDeposit
    // FIRST and only created the local row on success. If the process
    // crashed between those two steps the user's wallet was debited
    // (auth's idempotency key persists the charge) but cloud-api had no
    // record, so:
    //   * the deployment couldn't be billed against,
    //   * the refund-on-close path had nothing to refund from,
    //   * any retry would attempt to deposit again. The auth side would
    //     return alreadyProcessed=true (good), but cloud-api would then
    //     happily mark the row ACTIVE — except now we're in a state
    //     where the caller can't tell the deposit was "fresh" or
    //     replayed-from-the-dead.
    //
    // The fix: insert PENDING_DEPOSIT first, then call the deposit RPC,
    // then promote to ACTIVE. The escrow reconciler picks up any row
    // stuck in PENDING_DEPOSIT and either drives it to ACTIVE (if the
    // wallet was actually debited) or FAILED (if the deposit will never
    // complete). Pay-as-you-go (depositCents=0) skips the RPC entirely
    // and writes ACTIVE directly — no wallet operation to reconcile.
    const initialStatus: 'PENDING_DEPOSIT' | 'ACTIVE' = depositCents > 0 ? 'PENDING_DEPOSIT' : 'ACTIVE'
    const escrow = await this.prisma.deploymentEscrow.create({
      data: {
        akashDeploymentId: args.akashDeploymentId,
        orgBillingId: orgBilling.orgBillingId,
        organizationId: args.organizationId,
        depositCents,
        dailyRateCents,
        marginRate: args.marginRate,
        status: initialStatus,
        lastBilledAt: initialStatus === 'ACTIVE' ? new Date() : null,
      },
    })

    if (depositCents === 0) {
      log.info(
        { deploymentId: args.akashDeploymentId, dailyRateCents, mode: 'pay-as-you-go' },
        'Created escrow for deployment'
      )
      return escrow
    }

    try {
      await this.billingApi.escrowDeposit({
        orgBillingId: orgBilling.orgBillingId,
        organizationId: args.organizationId,
        userId: args.userId,
        amountCents: depositCents,
        deploymentId: args.akashDeploymentId,
        description: `Akash escrow deposit (${escrowDays} days @ $${(dailyRateCents / 100).toFixed(2)}/day)`,
      })
    } catch (err) {
      // Mark FAILED so the deployment lifecycle can clean up; reconciler
      // will not touch FAILED rows (terminal). Caller is expected to abort
      // the deployment and surface INSUFFICIENT_BALANCE / RPC error.
      await this.prisma.deploymentEscrow.update({
        where: { id: escrow.id },
        data: { status: 'FAILED' },
      }).catch((updateErr) => {
        log.error(
          { escrowId: escrow.id, deploymentId: args.akashDeploymentId, updateErr },
          'Failed to mark escrow FAILED after deposit RPC error — reconciler will sweep PENDING_DEPOSIT',
        )
      })
      throw err
    }

    const promoted = await this.prisma.deploymentEscrow.update({
      where: { id: escrow.id },
      data: {
        status: 'ACTIVE',
        lastBilledAt: new Date(),
      },
    })

    log.info(
      { deploymentId: args.akashDeploymentId, depositCents, dailyRateCents, mode: 'pre-funded' },
      'Created escrow for deployment'
    )

    return promoted
  }

  /**
   * Sweep escrows stuck in PENDING_DEPOSIT.
   *
   * A row stuck in this state means we wrote-ahead but never got a final
   * answer from auth's escrow-deposit RPC (process crashed mid-flight,
   * pod evicted, network blip, etc). Auth's idempotency key
   * `escrow_deposit:<orgBillingId>:<deploymentId>` is deterministic from
   * inputs we already have, so we can safely retry: if the prior call
   * landed, the retry returns alreadyProcessed=true and we promote to
   * ACTIVE; if it never landed, the retry executes for real.
   *
   * Rows older than `failAfterMs` get marked FAILED and the deployment
   * is expected to be torn down upstream.
   */
  async reconcilePendingDeposits(opts: {
    /** Only retry rows older than this (don't race the original caller). */
    minAgeMs?: number
    /** Mark rows older than this as terminally FAILED. */
    failAfterMs?: number
  } = {}): Promise<{ promoted: number; failed: number; remaining: number }> {
    const minAgeMs = opts.minAgeMs ?? 60_000 // 1 min — give the original caller time to finish
    const failAfterMs = opts.failAfterMs ?? 30 * 60_000 // 30 min — page after this

    const now = Date.now()
    const minAgeCutoff = new Date(now - minAgeMs)
    const failCutoff = new Date(now - failAfterMs)

    const stuck = await this.prisma.deploymentEscrow.findMany({
      where: {
        status: 'PENDING_DEPOSIT',
        createdAt: { lt: minAgeCutoff },
      },
      include: {
        akashDeployment: { select: { id: true, status: true } },
      },
    })

    let promoted = 0
    let failed = 0

    for (const row of stuck) {
      // Belt-and-braces: if the deployment row itself is gone or already
      // closed/failed there is nothing meaningful to recover — mark FAILED.
      const depStatus = row.akashDeployment?.status
      const orphaned = !depStatus || ['CLOSED', 'CLOSE_FAILED', 'FAILED', 'PERMANENTLY_FAILED'].includes(depStatus)
      const tooOld = row.createdAt < failCutoff

      if (orphaned || tooOld) {
        await this.prisma.deploymentEscrow.update({
          where: { id: row.id },
          data: { status: 'FAILED' },
        })
        failed++
        log.warn(
          {
            escrowId: row.id,
            deploymentId: row.akashDeploymentId,
            ageMs: now - row.createdAt.getTime(),
            depStatus,
            reason: orphaned ? 'orphaned_deployment' : 'timeout',
          },
          'Escrow stuck in PENDING_DEPOSIT — marking FAILED',
        )
        continue
      }

      try {
        // Idempotent retry — auth derives the key from orgBillingId+deploymentId.
        await this.billingApi.escrowDeposit({
          orgBillingId: row.orgBillingId,
          organizationId: row.organizationId,
          userId: 'reconciler',
          amountCents: row.depositCents,
          deploymentId: row.akashDeploymentId,
          description: 'Akash escrow deposit (write-ahead reconcile)',
        })
        await this.prisma.deploymentEscrow.update({
          where: { id: row.id },
          data: { status: 'ACTIVE', lastBilledAt: new Date() },
        })
        promoted++
        log.info(
          { escrowId: row.id, deploymentId: row.akashDeploymentId, depositCents: row.depositCents },
          'Reconciler promoted PENDING_DEPOSIT → ACTIVE',
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(
          { escrowId: row.id, deploymentId: row.akashDeploymentId, err: msg },
          'Reconciler retry of PENDING_DEPOSIT failed — will retry next cycle',
        )
      }
    }

    return { promoted, failed, remaining: stuck.length - promoted - failed }
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

    const hoursToBill = Math.max(1, Math.floor(hoursSinceLastBill))
    const hourlyRateCents = escrow.dailyRateCents / 24
    const consumptionCents = Math.round(hourlyRateCents * hoursToBill)
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

    // Never try to refund a write-ahead deposit that hasn't
    // settled. PENDING_DEPOSIT rows are handled by reconcilePendingDeposits;
    // FAILED rows have no funds to return.
    if (escrow.status === 'PENDING_DEPOSIT' || escrow.status === 'FAILED') {
      log.warn(
        { deploymentId: akashDeploymentId, status: escrow.status },
        'refundEscrow called on a write-ahead deposit row — skipping; reconciler owns this state',
      )
      return 0
    }

    const remaining = Math.max(0, escrow.depositCents - escrow.consumedCents)

    // Pay-as-you-go fast path: nothing was deposited so there
    // is nothing to refund. Skip the write-ahead entirely so the closed/
    // suspended-then-closed flow does not generate a no-op REFUNDING row.
    if (remaining === 0) {
      await this.prisma.deploymentEscrow.update({
        where: { id: escrow.id },
        data: { status: 'REFUNDED', refundedCents: 0 },
      })
      log.info({ deploymentId: akashDeploymentId }, 'Refunded escrow (no-op, depositCents=0)')
      return 0
    }

    // Write-ahead REFUNDING. Without this marker, a crash
    // between escrowRefund() and the local update would leave us in:
    //   * Auth credited the wallet (idempotency key persists the credit)
    //   * Local row still says ACTIVE/DEPLETED with refundedCents=0
    //   * Next refundEscrow attempt would call escrowRefund again, which
    //     idempotently no-ops on the auth side (alreadyProcessed=true) so
    //     no double-credit, BUT we still wouldn't promote the row to
    //     REFUNDED unless we also handle that case.
    // The REFUNDING marker tells the refund reconciler "this row already
    // attempted a refund; ask auth whether it landed and finalize state".
    // We use updateMany with a status guard to avoid racing concurrent
    // callers — only the caller that actually flips ACTIVE/DEPLETED →
    // REFUNDING gets to make the RPC call.
    const claim = await this.prisma.deploymentEscrow.updateMany({
      where: {
        id: escrow.id,
        status: { in: ['ACTIVE', 'DEPLETED', 'PAUSED'] },
      },
      data: { status: 'REFUNDING' },
    })
    if (claim.count === 0) {
      // Another caller raced us into REFUNDING; let them finish.
      log.info(
        { deploymentId: akashDeploymentId, status: escrow.status },
        'refundEscrow lost the REFUNDING claim — another worker is finalizing',
      )
      return 0
    }

    try {
      await this.billingApi.escrowRefund({
        orgBillingId: escrow.orgBillingId,
        amountCents: remaining,
        deploymentId: akashDeploymentId,
        description: `Akash escrow refund — deployment closed ($${(remaining / 100).toFixed(2)})`,
      })
    } catch (err) {
      // Roll back the claim so the reconciler (or a subsequent retry)
      // can pick this up cleanly. The next attempt will re-claim and
      // re-issue the (idempotent) refund RPC.
      await this.prisma.deploymentEscrow.updateMany({
        where: { id: escrow.id, status: 'REFUNDING' },
        data: { status: escrow.status },
      }).catch(() => undefined)
      throw err
    }

    await this.prisma.deploymentEscrow.update({
      where: { id: escrow.id },
      data: {
        status: 'REFUNDED',
        refundedCents: remaining,
      },
    })

    log.info({ deploymentId: akashDeploymentId, refundedCents: remaining }, 'Refunded escrow for deployment')

    // Phase 44: single audit hook for every refund path (SUSPENDED close,
    // provider-close sweeper, ghost close, orphaned-escrow reconcile, policy
    // enforcer, resume handler). Intentionally placed at the tail of the
    // method so failures above don't produce misleading "ok" events.
    audit(this.prisma, {
      category: 'billing',
      action: 'escrow.refunded',
      status: 'ok',
      orgId: escrow.organizationId,
      deploymentId: akashDeploymentId,
      payload: {
        orgBillingId: escrow.orgBillingId,
        depositCents: escrow.depositCents,
        consumedCents: escrow.consumedCents,
        refundedCents: remaining,
      },
    })

    return remaining
  }

  /**
   * Sweep escrows stuck in REFUNDING.
   *
   * The auth-side refund RPC is idempotent (key:
   * `escrow_refund:<orgBillingId>:<deploymentId>`), so a stuck row here
   * means one of:
   *   1. Crash between escrowRefund() succeeded and the local
   *      `status: REFUNDED, refundedCents: remaining` update landed →
   *      retry the credit (no-op idempotently) and finalize the row.
   *   2. The credit RPC itself never landed → retry executes for real.
   * Either way the user ends up with the refund and the row finalizes.
   */
  async reconcilePendingRefunds(opts: {
    minAgeMs?: number
    failAfterMs?: number
  } = {}): Promise<{ completed: number; failed: number; remaining: number }> {
    const minAgeMs = opts.minAgeMs ?? 60_000
    const failAfterMs = opts.failAfterMs ?? 30 * 60_000

    const now = Date.now()
    const minAgeCutoff = new Date(now - minAgeMs)
    const failCutoff = new Date(now - failAfterMs)

    // updatedAt moves forward when refundEscrow flipped status to REFUNDING,
    // so it is the right cursor for "how long has this been stuck".
    const stuck = await this.prisma.deploymentEscrow.findMany({
      where: {
        status: 'REFUNDING',
        updatedAt: { lt: minAgeCutoff },
      },
    })

    let completed = 0
    let failed = 0

    for (const row of stuck) {
      const tooOld = row.updatedAt < failCutoff
      const remaining = Math.max(0, row.depositCents - row.consumedCents)

      try {
        if (remaining > 0) {
          await this.billingApi.escrowRefund({
            orgBillingId: row.orgBillingId,
            amountCents: remaining,
            deploymentId: row.akashDeploymentId,
            description: 'Akash escrow refund (write-ahead reconcile)',
          })
        }
        await this.prisma.deploymentEscrow.update({
          where: { id: row.id },
          data: { status: 'REFUNDED', refundedCents: remaining },
        })
        completed++
        log.info(
          { escrowId: row.id, deploymentId: row.akashDeploymentId, refundedCents: remaining },
          'Reconciler completed REFUNDING → REFUNDED',
        )
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (tooOld) {
          // Persistent failure beyond the budget — leave REFUNDING and
          // page so an operator can investigate auth-side state by hand.
          failed++
          log.error(
            { escrowId: row.id, deploymentId: row.akashDeploymentId, ageMs: now - row.updatedAt.getTime(), err: msg },
            'Refund reconciler exceeded budget — manual intervention required',
          )
        } else {
          log.warn(
            { escrowId: row.id, deploymentId: row.akashDeploymentId, err: msg },
            'Refund reconciler retry failed — will retry next cycle',
          )
        }
      }
    }

    return { completed, failed, remaining: stuck.length - completed }
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
