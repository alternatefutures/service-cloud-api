import { Prisma } from '@prisma/client'
import type {
  PrismaClient,
  PolicySettlementLedger,
  SettlementProvider,
  SettlementKind,
} from '@prisma/client'
import { getBillingApiClient } from './billingApiClient.js'
import { createLogger } from '../../lib/logger.js'
import { opsAlert } from '../../lib/opsAlert.js'

const log = createLogger('settlement-ledger')

export interface SettleViaLedgerArgs {
  provider: SettlementProvider
  kind: SettlementKind
  deploymentRef: string
  idempotencyKey: string
  orgBillingId: string
  amountCents: number
  settledTo: Date
  policyId?: string | null
  serviceType: string
  resource: string
  description: string
  metadata?: Prisma.InputJsonValue
}

export interface SettleViaLedgerResult {
  ledgerId: string
  status: 'COMMITTED' | 'PENDING' | 'FAILED'
  alreadyProcessed: boolean
  amountCents: number
}

/**
 * Insert a PolicySettlementLedger row in PENDING state, then call
 * computeDebit, then promote to COMMITTED.
 *
 * On RPC failure we leave the row PENDING (with `lastError` and bumped
 * `attemptCount`) so `reconcilePendingSettlements` can retry. The auth
 * service derives idempotency from the same `idempotencyKey` we stored
 * locally, so retries are safe even if the prior attempt landed.
 *
 * If a row with the same idempotencyKey already exists (caller retried
 * BEFORE the previous PENDING row was reconciled), we don't insert a
 * second row — we re-attempt against the existing one.
 */
export async function settleViaLedger(
  prisma: PrismaClient,
  args: SettleViaLedgerArgs,
): Promise<SettleViaLedgerResult> {
  if (args.amountCents <= 0) {
    throw new Error('settleViaLedger called with non-positive amountCents')
  }

  // Race-safe insert: rely on the UNIQUE(idempotencyKey) index. If the
  // row already exists (concurrent caller, retry after restart, etc.)
  // we read it back and re-attempt against the existing PENDING/COMMITTED.
  let row: PolicySettlementLedger
  try {
    row = await prisma.policySettlementLedger.create({
      data: {
        provider: args.provider,
        kind: args.kind,
        deploymentRef: args.deploymentRef,
        idempotencyKey: args.idempotencyKey,
        orgBillingId: args.orgBillingId,
        amountCents: args.amountCents,
        settledTo: args.settledTo,
        status: 'PENDING',
        policyId: args.policyId ?? null,
        metadata: args.metadata ?? Prisma.JsonNull,
      },
    })
  } catch (err) {
    // P2002 = unique constraint violation on idempotencyKey.
    if ((err as { code?: string }).code !== 'P2002') {
      throw err
    }
    const existing = await prisma.policySettlementLedger.findUnique({
      where: { idempotencyKey: args.idempotencyKey },
    })
    if (!existing) throw err
    row = existing

    // If the row was already committed on a prior attempt we must NOT
    // double-charge. Return the prior result.
    if (row.status === 'COMMITTED') {
      return {
        ledgerId: row.id,
        status: 'COMMITTED',
        alreadyProcessed: true,
        amountCents: row.amountCents,
      }
    }
    // FAILED rows are sticky — caller (or operator) must investigate
    // before retrying. Surface as failure rather than silently re-charging.
    if (row.status === 'FAILED') {
      log.error(
        { ledgerId: row.id, idempotencyKey: row.idempotencyKey, lastError: row.lastError },
        'settleViaLedger called against a FAILED ledger row — refusing to retry without operator action',
      )
      return {
        ledgerId: row.id,
        status: 'FAILED',
        alreadyProcessed: false,
        amountCents: row.amountCents,
      }
    }
    // PENDING — fall through and attempt the debit using the
    // already-stored amount/key (NEVER trust the new caller's amount,
    // since that would let them re-charge with a different value).
  }

  const billingApi = getBillingApiClient()
  try {
    const result = await billingApi.computeDebit({
      orgBillingId: row.orgBillingId,
      amountCents: row.amountCents,
      serviceType: args.serviceType,
      provider: args.provider === 'PHALA' ? 'phala' : 'akash',
      resource: args.resource,
      description: args.description,
      idempotencyKey: row.idempotencyKey,
      metadata: {
        ...(args.metadata as Record<string, unknown> | undefined),
        ledgerId: row.id,
        kind: row.kind,
      },
    })

    const committed = await prisma.policySettlementLedger.update({
      where: { id: row.id },
      data: {
        status: 'COMMITTED',
        committedAt: new Date(),
        attemptCount: { increment: 1 },
        lastError: null,
      },
    })

    return {
      ledgerId: committed.id,
      status: 'COMMITTED',
      alreadyProcessed: Boolean(result.alreadyProcessed),
      amountCents: committed.amountCents,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await prisma.policySettlementLedger
      .update({
        where: { id: row.id },
        data: {
          attemptCount: { increment: 1 },
          lastError: message.slice(0, 500),
        },
      })
      .catch((updateErr) => {
        log.error(
          { ledgerId: row.id, updateErr },
          'Failed to record settlement-ledger attempt error — reconciler will still retry',
        )
      })
    throw err
  }
}

/**
 * Sweep PENDING settlement-ledger rows.
 *
 * Each retry is idempotent on the auth side because we stored the
 * idempotencyKey at write-ahead time; even if the prior attempt did
 * land, the retry returns alreadyProcessed=true and we promote to
 * COMMITTED safely.
 *
 * Rows older than `failAfterMs` are marked FAILED and operators are
 * paged via opsAlert so the underlying root cause can be investigated.
 */
export async function reconcilePendingSettlements(
  prisma: PrismaClient,
  opts: {
    minAgeMs?: number
    failAfterMs?: number
    limit?: number
  } = {},
): Promise<{ committed: number; failed: number; remaining: number }> {
  const minAgeMs = opts.minAgeMs ?? 60_000
  const failAfterMs = opts.failAfterMs ?? 30 * 60_000
  const limit = opts.limit ?? 200

  const now = Date.now()
  const minAgeCutoff = new Date(now - minAgeMs)
  const failCutoff = new Date(now - failAfterMs)

  const stuck = await prisma.policySettlementLedger.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: minAgeCutoff },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  })

  let committed = 0
  let failed = 0
  const billingApi = getBillingApiClient()

  for (const row of stuck) {
    try {
      const result = await billingApi.computeDebit({
        orgBillingId: row.orgBillingId,
        amountCents: row.amountCents,
        serviceType: row.provider === 'PHALA' ? 'phala_tee' : 'akash_compute',
        provider: row.provider === 'PHALA' ? 'phala' : 'akash',
        resource: row.deploymentRef,
        description: `Settlement reconcile (${row.kind})`,
        idempotencyKey: row.idempotencyKey,
        metadata: { ledgerId: row.id, kind: row.kind, source: 'reconciler' },
      })
      await prisma.policySettlementLedger.update({
        where: { id: row.id },
        data: {
          status: 'COMMITTED',
          committedAt: new Date(),
          attemptCount: { increment: 1 },
          lastError: null,
        },
      })
      committed++
      log.info(
        {
          ledgerId: row.id,
          deploymentRef: row.deploymentRef,
          amountCents: row.amountCents,
          alreadyProcessed: result.alreadyProcessed,
        },
        'Settlement reconciler PENDING → COMMITTED',
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const tooOld = row.createdAt < failCutoff
      const nextStatus = tooOld ? 'FAILED' : 'PENDING'
      await prisma.policySettlementLedger
        .update({
          where: { id: row.id },
          data: {
            status: nextStatus,
            attemptCount: { increment: 1 },
            lastError: message.slice(0, 500),
          },
        })
        .catch(() => undefined)

      if (tooOld) {
        failed++
        log.error(
          { ledgerId: row.id, deploymentRef: row.deploymentRef, ageMs: now - row.createdAt.getTime(), err: message },
          'Settlement reconciler exceeded budget — marking FAILED',
        )
        await opsAlert({
          key: `settlement-ledger-failed:${row.id}`,
          severity: 'critical',
          title: 'Settlement ledger row stuck FAILED',
          message:
            `Settlement ledger ${row.id} (${row.provider} ${row.kind}) for deployment ${row.deploymentRef} ` +
            `could not be committed after ${Math.round(failAfterMs / 60_000)} min. ` +
            `User may have been charged on auth side without local promotion (or charge never landed). ` +
            `Investigate before retrying.`,
          context: {
            ledgerId: row.id,
            provider: row.provider,
            kind: row.kind,
            amountCents: row.amountCents,
            idempotencyKey: row.idempotencyKey,
            attemptCount: row.attemptCount + 1,
            error: message.slice(0, 400),
          },
          suppressMs: 24 * 60 * 60 * 1000,
        })
      } else {
        log.warn(
          { ledgerId: row.id, deploymentRef: row.deploymentRef, err: message },
          'Settlement reconciler retry failed — will retry next cycle',
        )
      }
    }
  }

  return { committed, failed, remaining: stuck.length - committed - failed }
}
