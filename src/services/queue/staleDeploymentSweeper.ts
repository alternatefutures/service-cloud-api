/**
 * Stale Deployment Sweeper
 *
 * Periodically scans for deployments stuck in intermediate states and marks
 * them FAILED so the retry mechanism can pick them up (or they reach terminal
 * state). This is the safety net for any lost QStash messages, server restarts,
 * or enqueueNext failures.
 *
 * Also reconciles ACTIVE Akash deployments whose on-chain leases have expired
 * or been evicted — marks them CLOSED and settles escrow to stop ghost billing.
 *
 * Runs on startup and then every SWEEP_INTERVAL_MS.
 */

import type { PrismaClient } from '@prisma/client'
import { getAkashOrchestrator } from '../akash/orchestrator.js'
import { getPhalaOrchestrator } from '../phala/index.js'
import { settleAkashEscrowToTime } from '../billing/deploymentSettlement.js'
import { getEscrowService } from '../billing/escrowService.js'
import { getAvailableProviders } from '../providers/registry.js'
import { decrementOrgConcurrency } from '../concurrency/concurrencyService.js'
import { createLogger } from '../../lib/logger.js'
import { audit } from '../../lib/audit.js'
import { opsAlert } from '../../lib/opsAlert.js'
import { randomUUID } from 'node:crypto'
import {
  evaluateFailoverEligibility,
  executeFailover,
  auditFailoverSkipped,
  type FailoverSkipReason,
} from '../failover/failoverService.js'

const log = createLogger('stale-sweeper')

const STALE_THRESHOLD_MS = 25 * 60 * 1000 // 25 minutes
const STALE_THRESHOLD_MIN = STALE_THRESHOLD_MS / 60_000
const SWEEP_INTERVAL_MS = 5 * 60 * 1000   // 5 minutes
const LIVENESS_MIN_AGE_MS = 10 * 60 * 1000 // only check deployments ACTIVE for >10 min

// Phase 46 — AWAITING_REGION_RESPONSE rows are the user-visible "no bids in
// region X" pause state. The UI/CLI surface alternative regions and a retry
// option; if the user does nothing, the sweeper auto-cancels after 5 min so
// the deployment doesn't linger as a half-state forever. Shorter than
// STALE_THRESHOLD_MS because the row hasn't actually allocated chain or
// escrow resources yet — just a temp dseq + DB row, both cheap to drop.
const REGION_AWAIT_THRESHOLD_MS = 5 * 60 * 1000

const AKASH_INTERMEDIATE_STATES = [
  'CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING',
] as const

const PHALA_INTERMEDIATE_STATES = [
  'CREATING', 'STARTING',
] as const

let sweepInterval: ReturnType<typeof setInterval> | null = null
let activeSweep: Promise<void> | null = null

async function sweepStaleDeployments(prisma: PrismaClient): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)

  // Akash: find deployments stuck in intermediate states past the threshold
  try {
    const staleAkash = await prisma.akashDeployment.findMany({
      where: {
        status: { in: [...AKASH_INTERMEDIATE_STATES] },
        updatedAt: { lt: cutoff },
      },
      select: {
        id: true,
        status: true,
        updatedAt: true,
        retryCount: true,
        dseq: true,
        service: { select: { project: { select: { organizationId: true } } } },
      },
    })

    for (const dep of staleAkash) {
      log.warn(`Akash deployment ${dep.id} stuck in ${dep.status} since ${dep.updatedAt.toISOString()} — marking FAILED`)

      // Switch on the structured close result so a
      // failed on-chain close doesn't get masked as success. A
      // FAILED close means the lease is potentially still live and
      // draining escrow; we mark CLOSE_FAILED so the next sweeper
      // pass / operator knows to retry.
      let closeStatus: 'CLOSED' | 'ALREADY_CLOSED' | 'FAILED' | 'NO_DSEQ' = 'NO_DSEQ'
      let closeError: string | undefined
      if (dep.dseq && Number(dep.dseq) > 0) {
        const orchestrator = getAkashOrchestrator(prisma)
        const result = await orchestrator.closeDeployment(Number(dep.dseq))
        closeStatus = result.chainStatus
        if (result.chainStatus === 'CLOSED' || result.chainStatus === 'ALREADY_CLOSED') {
          log.info(
            { dseq: String(dep.dseq), chainStatus: result.chainStatus },
            'On-chain deployment closed during stale sweep',
          )
        } else {
          closeError = result.error
          log.warn(
            { dseq: String(dep.dseq), chainStatus: result.chainStatus, error: closeError },
            'On-chain close FAILED during sweep — marking CLOSE_FAILED for retry',
          )
        }
      }

      const finalStatus = closeStatus === 'FAILED' ? 'CLOSE_FAILED' : 'FAILED'
      const errorMessage =
        closeStatus === 'FAILED'
          ? `Stale deployment swept but on-chain close failed: ${closeError ?? 'unknown'} (swept at ${new Date().toISOString()})`
          : `Stale deployment detected: stuck in ${dep.status} for >${STALE_THRESHOLD_MIN} minutes (swept at ${new Date().toISOString()})`

      const result = await prisma.akashDeployment.updateMany({
        where: { id: dep.id, status: dep.status },
        data: {
          status: finalStatus,
          errorMessage,
        },
      })

      // Only release a slot if we actually transitioned the row this
      // pass — `updateMany` returns count=0 when another worker beat us
      // to it (in which case THEY decremented, not us).
      if (result.count > 0) {
        await decrementOrgConcurrency(prisma, dep.service?.project?.organizationId)
          .catch((err) => log.warn({ err, deploymentId: dep.id }, 'Concurrency decrement failed (stale Akash)'))
      }
    }

    if (staleAkash.length > 0) {
      log.info(`Marked ${staleAkash.length} stale Akash deployment(s) as FAILED`)
    }
  } catch (err) {
    log.error(err as Error, 'Error sweeping Akash deployments')
  }

  // Phala: find deployments stuck in intermediate states past the threshold
  try {
    const stalePhala = await prisma.phalaDeployment.findMany({
      where: {
        status: { in: [...PHALA_INTERMEDIATE_STATES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, status: true, updatedAt: true, retryCount: true, appId: true, organizationId: true },
    })

    for (const dep of stalePhala) {
      log.warn(`Phala deployment ${dep.id} stuck in ${dep.status} since ${dep.updatedAt.toISOString()} — marking FAILED`)
      if (dep.appId && dep.appId !== 'pending') {
        try {
          const orchestrator = getPhalaOrchestrator(prisma)
          await orchestrator.deletePhalaDeployment(dep.appId)
          log.info(`Deleted CVM ${dep.appId} during stale sweep`)
        } catch (delErr) {
          log.warn({ appId: dep.appId, err: delErr }, 'Failed to delete CVM during sweep')
        }
      }
      const result = await prisma.phalaDeployment.updateMany({
        where: { id: dep.id, status: dep.status },
        data: {
          status: 'FAILED',
          errorMessage: `Stale deployment detected: stuck in ${dep.status} for >${STALE_THRESHOLD_MIN} minutes (swept at ${new Date().toISOString()})`,
        },
      })
      if (result.count > 0) {
        await decrementOrgConcurrency(prisma, dep.organizationId)
          .catch((err) => log.warn({ err, deploymentId: dep.id }, 'Concurrency decrement failed (stale Phala)'))
      }
    }

    if (stalePhala.length > 0) {
      log.info(`Marked ${stalePhala.length} stale Phala deployment(s) as FAILED`)
    }
  } catch (err) {
    log.error(err as Error, 'Error sweeping Phala deployments')
  }
}

/**
 * Provider-agnostic liveness reconciliation.
 *
 * For every registered provider, fetches active deployment IDs, health-checks
 * each one, and calls provider.close() on deployments that are definitively
 * dead. Uses an in-memory consecutive-failure counter to avoid closing
 * deployments on transient errors — requires CONSECUTIVE_FAILURE_THRESHOLD
 * failures across different sweep cycles before declaring dead.
 *
 * Because provider.close() settles all billing (interface contract), no
 * provider-specific billing logic is needed here.
 */
// Thresholds tuned 2026-05-03 after forensics (see handoff
// 2026-05-03_*_alternate-bucket-v2-akash-aware-and-sweeper-finding.md and
// the lease-close postmortem for the 7-deployment mass-kill on
// 2026-04-29 22:00-22:04 UTC).
//
// - UNHEALTHY: was 1 — a single transient `unhealthy` verdict killed leases
//   in 1 sweep tick. Now requires 3 consecutive observations (≈15 min)
//   before closing, matching the UNKNOWN cadence.
// - UNKNOWN: was 3 — the 4-min mass-kill all reached failures=3. Bumped
//   to 5 so a sustained provider-side outage gets ~25 min to recover.
// - EXCEPTION: keep at 3; CLI throws are very rarely transient long enough
//   to clear over 15 min, but we still want consecutive confirmation.
const UNHEALTHY_THRESHOLD = 3
const UNKNOWN_THRESHOLD = 5
const EXCEPTION_THRESHOLD = 3

// Mass-event guard. If a single sweep pass would close ≥ MASS_EVENT_RATIO
// of all ACTIVE deployments AND the population is at least
// MASS_EVENT_MIN_TOTAL, abort the close path entirely — that's a
// provider-wide outage / RPC blip, not real death. Counters are reset so
// the next pass starts fresh once the underlying issue clears.
const MASS_EVENT_MIN_TOTAL = 5
const MASS_EVENT_RATIO = 0.5

const failureCounters = new Map<string, number>()

function isDefinitelyDead(health: { overall: string }): boolean {
  return health.overall === 'unhealthy'
}

/**
 * Phase 43 — close-or-failover branch. The sweeper has already decided this
 * deployment is dead. We try `executeFailover()` if the service has opted
 * in AND the failure looks like a *provider* problem; otherwise we plain
 * `close()` (the existing behaviour).
 *
 * Returns true if the deployment was either closed or replaced (caller
 * counts it as reconciled either way).
 */
async function closeOrFailover(
  prisma: PrismaClient,
  provider: { name: string; close(id: string): Promise<void> },
  deploymentId: string,
  sweepTraceId: string,
  closeAuditExtra: Record<string, unknown>
): Promise<boolean> {
  if (provider.name !== 'akash') {
    // Phala / future providers: failover not implemented yet; fall through.
    try {
      await provider.close(deploymentId)
      auditHealthClose(prisma, sweepTraceId, provider.name, deploymentId, closeAuditExtra)
      return true
    } catch (closeErr) {
      log.error(
        { provider: provider.name, deploymentId, err: closeErr },
        'Failed to close dead deployment'
      )
      return false
    }
  }

  let eligibility: Awaited<ReturnType<typeof evaluateFailoverEligibility>>
  try {
    eligibility = await evaluateFailoverEligibility(prisma, deploymentId)
  } catch (evalErr) {
    log.warn(
      { deploymentId, err: evalErr },
      'failover eligibility evaluation threw — defaulting to plain close'
    )
    eligibility = { eligible: false, reason: 'no_chain_root' }
  }

  if (!eligibility.eligible) {
    // Skip-audit only the cases where the user explicitly asked for failover
    // (i.e. policy was enabled). Disabled-by-default services would drown
    // the audit log otherwise.
    const noisySkips: ReadonlySet<FailoverSkipReason> = new Set([
      'has_volumes',
      'never_active',
      'app_unhealthy',
      'cap_exceeded',
    ])
    if (noisySkips.has(eligibility.reason)) {
      try {
        const dep = await prisma.akashDeployment.findUnique({
          where: { id: deploymentId },
          select: {
            id: true,
            serviceId: true,
            service: { select: { projectId: true, project: { select: { organizationId: true } } } },
          },
        })
        if (dep) {
          auditFailoverSkipped(prisma, {
            traceId: sweepTraceId,
            deployment: dep,
            reason: eligibility.reason,
            detail: eligibility.detail,
          })
        }
      } catch (auditErr) {
        log.debug({ err: auditErr }, 'failover skip audit lookup failed')
      }
    }

    try {
      await provider.close(deploymentId)
      auditHealthClose(prisma, sweepTraceId, provider.name, deploymentId, closeAuditExtra)
      return true
    } catch (closeErr) {
      log.error(
        { provider: provider.name, deploymentId, err: closeErr },
        'Failed to close dead deployment'
      )
      return false
    }
  }

  try {
    const result = await executeFailover(prisma, deploymentId, {
      excludedProviders: eligibility.excludedProviders,
      reason: String(closeAuditExtra.reason ?? 'unhealthy'),
      triggeredBy: 'sweeper',
      traceId: sweepTraceId,
    })
    log.info(
      {
        from: deploymentId,
        to: result.newDeploymentId,
        excluded: eligibility.excludedProviders.length,
        attemptsInWindow: eligibility.attemptsInWindow,
      },
      'failover triggered for dead deployment'
    )
    return true
  } catch (failoverErr) {
    log.error(
      { deploymentId, err: failoverErr },
      'failover execution failed — falling back to plain close'
    )
    try {
      await provider.close(deploymentId)
      auditHealthClose(prisma, sweepTraceId, provider.name, deploymentId, {
        ...closeAuditExtra,
        failoverError: failoverErr instanceof Error ? failoverErr.message : String(failoverErr),
      })
      return true
    } catch (closeErr) {
      log.error(
        { provider: provider.name, deploymentId, err: closeErr },
        'Failed to close dead deployment after failover failure'
      )
      return false
    }
  }
}

/**
 * Per-deployment verdict from the probe phase. The reconciler collects all
 * verdicts before deciding to close any of them — this lets the
 * mass-event guard (`MASS_EVENT_RATIO`) abort the close path entirely
 * when a provider-wide blip would otherwise nuke half the fleet.
 */
type ReconcileVerdict =
  | { id: string; kind: 'close'; reason: 'unhealthy' | 'unknown_health' | 'probe_exception'; failures: number; healthOverall?: string; probeError?: string }
  | { id: string; kind: 'tracking'; reason: 'unhealthy' | 'unknown_health' | 'probe_exception'; failures: number }
  | { id: string; kind: 'healthy' }

async function reconcileActiveDeployments(prisma: PrismaClient): Promise<void> {
  const providers = getAvailableProviders()
  let totalReconciled = 0
  // One trace id per sweep invocation so all closures in a single pass
  // group together in the audit log (Phase 44).
  const sweepTraceId = randomUUID()

  for (const provider of providers) {
    try {
      const activeIds = await provider.getActiveDeploymentIds()
      if (activeIds.length === 0) continue

      log.debug({ provider: provider.name, count: activeIds.length }, 'Reconciling active deployments')

      // ─── Phase 1: probe every deployment, collect verdicts (no closes yet) ───
      const verdicts: ReconcileVerdict[] = []
      for (const id of activeIds) {
        const counterKey = `${provider.name}:${id}`

        try {
          const health = await provider.getHealth(id)

          if (!health || isDefinitelyDead(health)) {
            const count = (failureCounters.get(counterKey) ?? 0) + 1
            failureCounters.set(counterKey, count)
            verdicts.push(
              count >= UNHEALTHY_THRESHOLD
                ? { id, kind: 'close', reason: 'unhealthy', failures: count, healthOverall: health?.overall ?? '404' }
                : { id, kind: 'tracking', reason: 'unhealthy', failures: count }
            )
          } else if (health.overall === 'unknown') {
            const count = (failureCounters.get(counterKey) ?? 0) + 1
            failureCounters.set(counterKey, count)
            verdicts.push(
              count >= UNKNOWN_THRESHOLD
                ? { id, kind: 'close', reason: 'unknown_health', failures: count, healthOverall: 'unknown' }
                : { id, kind: 'tracking', reason: 'unknown_health', failures: count }
            )
          } else {
            failureCounters.delete(counterKey)
            verdicts.push({ id, kind: 'healthy' })
          }
        } catch (err) {
          const count = (failureCounters.get(counterKey) ?? 0) + 1
          failureCounters.set(counterKey, count)
          log.warn(
            { provider: provider.name, deploymentId: id, err, failures: count },
            'Health check threw — counting as failure'
          )
          verdicts.push(
            count >= EXCEPTION_THRESHOLD
              ? { id, kind: 'close', reason: 'probe_exception', failures: count, probeError: err instanceof Error ? err.message : String(err) }
              : { id, kind: 'tracking', reason: 'probe_exception', failures: count }
          )
        }
      }

      // ─── Phase 2: mass-event guard ───
      const closures = verdicts.filter((v): v is Extract<ReconcileVerdict, { kind: 'close' }> => v.kind === 'close')
      if (closures.length > 0 && verdicts.length >= MASS_EVENT_MIN_TOTAL) {
        const ratio = closures.length / verdicts.length
        if (ratio >= MASS_EVENT_RATIO) {
          log.error(
            {
              provider: provider.name,
              total: verdicts.length,
              wouldClose: closures.length,
              ratio: +ratio.toFixed(2),
              reasons: countReasons(closures),
            },
            'Mass-close event detected — refusing to close any deployments this pass (likely provider-wide outage)'
          )
          await opsAlert({
            key: `mass-close-event:${provider.name}`,
            severity: 'critical',
            title: `Sweeper aborted mass-close (${provider.name})`,
            message:
              `Sweeper would have closed ${closures.length}/${verdicts.length} ` +
              `${provider.name} deployments in a single pass (ratio ${(ratio * 100).toFixed(0)}%). ` +
              `Aborted to avoid nuking the fleet on a provider-wide outage. ` +
              `Investigate provider/RPC health; counters were reset so next pass starts fresh.`,
            context: {
              provider: provider.name,
              total: String(verdicts.length),
              wouldClose: String(closures.length),
              ratio: ratio.toFixed(2),
              reasons: JSON.stringify(countReasons(closures)),
              sweepTraceId,
            },
            suppressMs: 30 * 60 * 1000,
          }).catch((err) =>
            log.warn({ err }, 'opsAlert failed during mass-close abort'),
          )
          // Reset close-bound counters so the same deployments don't tip
          // over the threshold again on the very next pass while the
          // outage is still ongoing.
          for (const v of closures) failureCounters.delete(`${provider.name}:${v.id}`)
          continue
        }
      }

      // ─── Phase 3: execute closes (or the failover branch) ───
      for (const v of verdicts) {
        if (v.kind !== 'close') {
          if (v.kind === 'tracking') {
            log.debug(
              { provider: provider.name, deploymentId: v.id, failures: v.failures, reason: v.reason },
              'Deployment unhealthy/unknown/exception — tracking consecutive failures'
            )
          }
          continue
        }

        log.warn(
          { provider: provider.name, deploymentId: v.id, failures: v.failures, reason: v.reason, health: v.healthOverall },
          'Deployment confirmed dead — closing or failing over'
        )
        const closeAuditExtra: Record<string, unknown> = {
          reason: v.reason,
          failures: v.failures,
        }
        if (v.healthOverall) closeAuditExtra.overall = v.healthOverall
        if (v.probeError) closeAuditExtra.probeError = v.probeError

        const ok = await closeOrFailover(prisma, provider, v.id, sweepTraceId, closeAuditExtra)
        if (ok) totalReconciled++
        failureCounters.delete(`${provider.name}:${v.id}`)
      }
    } catch (err) {
      log.error({ provider: provider.name, err }, 'Failed to reconcile provider')
    }
  }

  if (totalReconciled > 0) {
    log.info({ reconciled: totalReconciled }, 'Reconciled dead deployments across all providers')
  }
}

function countReasons(closures: Array<{ reason: string }>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of closures) out[c.reason] = (out[c.reason] ?? 0) + 1
  return out
}

/**
 * Phase 44 audit helper — records one event per health-driven close. We
 * best-effort enrich the event with org/service context by looking up the
 * AkashDeployment row; Phala closes use the generic provider id as
 * deploymentId without enrichment. Fire-and-forget: any lookup failure is
 * swallowed so the sweep itself is never blocked by audit work.
 */
interface HealthCloseRow {
  id: string
  serviceId: string
  service: { projectId: string; project: { organizationId: string | null } | null } | null
}

function auditHealthClose(
  prisma: PrismaClient,
  traceId: string,
  providerName: string,
  providerDeploymentId: string,
  extra: Record<string, unknown>
): void {
  void (async () => {
    let row: HealthCloseRow | null = null
    try {
      if (providerName === 'akash') {
        row = (await prisma.akashDeployment.findFirst({
          where: { id: providerDeploymentId },
          select: {
            id: true,
            serviceId: true,
            service: { select: { projectId: true, project: { select: { organizationId: true } } } },
          },
        })) as HealthCloseRow | null
      }
    } catch (err) {
      log.debug({ err, providerName, providerDeploymentId }, 'audit enrichment lookup failed')
    }

    audit(prisma, {
      traceId,
      source: 'monitor',
      category: 'health',
      action: 'health.deployment_closed',
      status: 'error',
      orgId: row?.service?.project?.organizationId ?? null,
      projectId: row?.service?.projectId ?? null,
      serviceId: row?.serviceId ?? null,
      deploymentId: row?.id ?? providerDeploymentId,
      payload: { provider: providerName, ...extra },
    })
  })()
}

/**
 * Reconcile orphaned escrow records: any ACTIVE/DEPLETED escrow whose
 * linked AkashDeployment is in a terminal state should be settled and refunded.
 */
async function reconcileOrphanedEscrows(prisma: PrismaClient): Promise<void> {
  const TERMINAL_STATUSES = ['CLOSED', 'FAILED', 'PERMANENTLY_FAILED'] as const

  const orphaned = await prisma.deploymentEscrow.findMany({
    where: {
      status: { in: ['ACTIVE', 'DEPLETED'] },
      akashDeployment: { status: { in: [...TERMINAL_STATUSES] } },
    },
    include: {
      akashDeployment: { select: { closedAt: true } },
    },
  })

  if (orphaned.length === 0) return

  log.info(`Found ${orphaned.length} orphaned escrow(s) — settling and refunding`)

  const escrowService = getEscrowService(prisma)

  for (const esc of orphaned) {
    try {
      const settledAt = esc.akashDeployment?.closedAt || new Date()
      await settleAkashEscrowToTime(prisma, esc.akashDeploymentId, settledAt)
      await escrowService.refundEscrow(esc.akashDeploymentId)
      log.info(`Reconciled orphaned escrow ${esc.id} for deployment ${esc.akashDeploymentId}`)
    } catch (err) {
      log.warn({ escrowId: esc.id, err }, 'Failed to reconcile orphaned escrow')
    }
  }
}

/**
 * Phase 46 — auto-cancel deployments stuck in AWAITING_REGION_RESPONSE
 * for >REGION_AWAIT_THRESHOLD_MS. The state is the user-visible "no bids
 * in region X" pause; if the user walks away without picking an
 * alternative, we don't want a half-state deployment row sitting around
 * forever. Marks FAILED with a self-explanatory errorMessage. No on-chain
 * close needed — the row never reached a real dseq (still has the
 * negative-timestamp temp dseq from `deployService`).
 *
 * Runs in the existing sweep cycle alongside `sweepStaleDeployments` so
 * we don't pay for a separate scheduler.
 */
async function sweepAwaitingRegionResponse(prisma: PrismaClient): Promise<void> {
  const cutoff = new Date(Date.now() - REGION_AWAIT_THRESHOLD_MS)

  let stale: Array<{
    id: string
    region: string | null
    updatedAt: Date
    dseq: bigint | null
  }> = []
  try {
    stale = await prisma.akashDeployment.findMany({
      where: {
        status: 'AWAITING_REGION_RESPONSE',
        updatedAt: { lt: cutoff },
      },
      select: { id: true, region: true, updatedAt: true, dseq: true },
    })
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, 'AWAITING_REGION_RESPONSE scan failed')
    return
  }

  if (stale.length === 0) return

  for (const dep of stale) {
    // If a real dseq was assigned (positive — temp dseqs are negative),
    // the deployment exists on-chain with a locked deposit. We MUST close
    // it to prevent escrow leak until chain-side expiry. Mirrors the
    // close behavior in sweepStaleDeployments.
    let closeStatus: 'CLOSED' | 'ALREADY_CLOSED' | 'FAILED' | 'NO_DSEQ' = 'NO_DSEQ'
    let closeError: string | undefined
    if (dep.dseq && Number(dep.dseq) > 0) {
      try {
        const orchestrator = getAkashOrchestrator(prisma)
        const result = await orchestrator.closeDeployment(Number(dep.dseq))
        closeStatus = result.chainStatus
        if (result.chainStatus === 'CLOSED' || result.chainStatus === 'ALREADY_CLOSED') {
          log.info(
            { deploymentId: dep.id, dseq: String(dep.dseq), chainStatus: result.chainStatus },
            'Closed on-chain deployment for AWAITING_REGION_RESPONSE auto-cancel',
          )
        } else {
          closeError = result.error
          log.warn(
            { deploymentId: dep.id, dseq: String(dep.dseq), chainStatus: result.chainStatus, error: closeError },
            'On-chain close FAILED during AWAITING_REGION_RESPONSE auto-cancel — marking CLOSE_FAILED for retry',
          )
        }
      } catch (err) {
        closeError = err instanceof Error ? err.message : String(err)
        closeStatus = 'FAILED'
        log.warn(
          { deploymentId: dep.id, err: closeError },
          'orchestrator.closeDeployment threw during AWAITING_REGION_RESPONSE auto-cancel',
        )
      }
    }

    const finalStatus = closeStatus === 'FAILED' ? 'CLOSE_FAILED' : 'FAILED'
    const reasonSuffix = closeStatus === 'FAILED'
      ? ` Chain close failed (${closeError ?? 'unknown'}); marked CLOSE_FAILED for sweeper retry.`
      : ''

    try {
      await prisma.akashDeployment.update({
        where: { id: dep.id },
        data: {
          status: finalStatus,
          errorMessage:
            `No bids in region "${dep.region ?? 'unknown'}" — cancelled after ${Math.round(REGION_AWAIT_THRESHOLD_MS / 60_000)} min with no user retry.${reasonSuffix}`,
          closedAt: new Date(),
        },
      })
      log.info(
        { deploymentId: dep.id, region: dep.region, finalStatus },
        'Cancelled AWAITING_REGION_RESPONSE deployment past threshold'
      )
    } catch (err) {
      log.warn(
        { deploymentId: dep.id, err: err instanceof Error ? err.message : err },
        'Failed to mark AWAITING_REGION_RESPONSE deployment final status — will retry next sweep'
      )
    }
  }
}

function runSweep(prisma: PrismaClient): void {
  const sweep = (async () => {
    await sweepStaleDeployments(prisma)
    await sweepAwaitingRegionResponse(prisma)
    await reconcileActiveDeployments(prisma)
    await reconcileOrphanedEscrows(prisma)
  })()
    .catch(err => log.error(err as Error, 'Sweep failed'))
    .finally(() => { if (activeSweep === sweep) activeSweep = null })
  activeSweep = sweep
}

export function startStaleDeploymentSweeper(prisma: PrismaClient): void {
  runSweep(prisma)

  sweepInterval = setInterval(() => {
    if (!activeSweep) runSweep(prisma)
  }, SWEEP_INTERVAL_MS)

  log.info(`Stale deployment sweeper started (every ${SWEEP_INTERVAL_MS / 1000}s, threshold ${STALE_THRESHOLD_MS / 1000}s)`)
}

/**
 * Stop the sweeper and wait for any in-flight sweep to complete.
 * Safe to call during graceful shutdown — Prisma won't disconnect
 * while a sweep is still running.
 */
export async function stopStaleDeploymentSweeper(): Promise<void> {
  if (sweepInterval) {
    clearInterval(sweepInterval)
    sweepInterval = null
  }
  if (activeSweep) {
    log.info('Waiting for in-flight sweep to complete…')
    await activeSweep
  }
}
