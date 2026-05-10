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
import { getSpheronClient, SpheronApiError } from '../spheron/client.js'
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
// Sweeper philosophy (2026-05-03 — explicit redesign after rustfs-p1td
// incident, refined in Phase 49b after the loophole audit):
//
//   The sweeper closes leases that are GENUINELY GONE on-chain. It does
//   NOT close leases just because a container is unhealthy.
//
// Rationale: a crashed container is the user's problem to debug. Killing
// the lease destroys their forensic context (logs, mounted volumes,
// provider record), bills them again to redeploy, and leaves them with
// zero feedback about what failed. Container health is surfaced in the
// UI/audit log so the user sees what's broken; opt-in failoverPolicy is
// the ONLY automated remediation for unhealth — and only because the
// user explicitly asked for it.
//
// What still triggers a sweeper close:
//   • `overall === 'gone'`  — provider returned 404 / "not found" on
//     lease-status, OR our DB has the deployment in a terminal failure
//     state, OR (Phase 49b) Phala's CVM existence probe says the appId
//     no longer exists at the provider. The chain-side / provider-side
//     resource is dead; we're just syncing bookkeeping.
//
// What does NOT trigger close:
//   • `overall === 'unhealthy'`         (container down, lease alive)
//   • `overall === 'unknown'`           (we couldn't tell)
//   • Probe exception that isn't 404    (timeout, RPC blip)
//
// Failover (opt-in, gated by service.failoverPolicy.enabled) still acts
// on `unhealthy` after UNHEALTHY_THRESHOLD consecutive ticks — that's a
// user-requested behaviour and stays.
const GONE_THRESHOLD = 3        // 15 min of confirmed-gone before close
const UNHEALTHY_THRESHOLD = 3   // failover trigger only (if policy enabled)

// Mass-event guard. If a single sweep pass would close ≥ MASS_EVENT_RATIO
// of all ACTIVE deployments AND the population is at least
// MASS_EVENT_MIN_TOTAL, abort the close path entirely — that's a
// provider-wide outage / RPC blip, not real death. Counters are reset so
// the next pass starts fresh once the underlying issue clears.
//
// 2026-05-03 (Phase 49b) — the same guard is now applied to failover_check
// verdicts. Previously only `close_gone` was counted, so a provider-wide
// outage that flipped many opted-in services to `'unhealthy'` could trigger
// fleet-wide auto-failover (each calling provider.close on its old lease)
// without ever tripping the abort. Now both close paths are protected.
const MASS_EVENT_MIN_TOTAL = 5
const MASS_EVENT_RATIO = 0.5

// Per-verdict-kind streak counters. Phase 49 introduced the verdict
// taxonomy; Phase 49b separates the buckets so streaks of one kind don't
// inflate the threshold for another. Previously `unhealthyCounters` was
// shared across `'unhealthy'`, `'unknown'`, and probe-exception streaks,
// which meant an alternating `unhealthy → unknown → unhealthy` sequence
// could fire failover at the second `'unhealthy'` instead of the third.
//
// Now:
//  • goneCounters         — strictly `'gone'` streak; drives close_gone.
//  • unhealthyCounters    — strictly `'unhealthy'` streak; drives
//                           failover_check.
//  • observabilityCounters — `'unknown'` and probe-exception streaks; never
//                           drives a close, only used to fire the first-tick
//                           audit + recovery audit.
const goneCounters = new Map<string, number>()
const unhealthyCounters = new Map<string, number>()
const observabilityCounters = new Map<string, number>()

/**
 * Per-deployment verdict from the probe phase. The reconciler collects all
 * verdicts before deciding to close any of them — this lets the
 * mass-event guard (`MASS_EVENT_RATIO`) abort the close path entirely
 * when a provider-wide blip would otherwise nuke half the fleet.
 *
 * Verdict kinds:
 *  - 'close_gone'       — lease is genuinely gone on-chain. Sweeper closes
 *                         to sync our DB. This is the ONLY close path.
 *  - 'failover_check'   — container reports unhealthy; lease still exists.
 *                         Sweeper does NOT close. If failoverPolicy is
 *                         enabled it triggers `executeFailover`; otherwise
 *                         it audits and moves on. Container stays alive
 *                         so the user can read logs and debug.
 *  - 'visible_only'     — unhealthy/unknown/probe-exception that shouldn't
 *                         drive any action this tick (e.g. still under
 *                         threshold, or 'unknown' which never closes).
 *                         Audit row written for forensic visibility.
 *  - 'healthy'          — nothing to do.
 */
type ReconcileVerdict =
  | {
      id: string
      kind: 'close_gone'
      reason: 'gone' | 'probe_exception_gone'
      failures: number
      healthOverall?: string
      probeError?: string
    }
  | {
      id: string
      kind: 'failover_check'
      reason: 'unhealthy'
      failures: number
      healthOverall: string
    }
  | {
      id: string
      kind: 'visible_only'
      reason: 'unhealthy' | 'unknown_health' | 'probe_exception_other'
      failures: number
      healthOverall?: string
      probeError?: string
    }
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
        const goneKey = `${provider.name}:gone:${id}`
        const unhealthyKey = `${provider.name}:unhealthy:${id}`
        const observabilityKey = `${provider.name}:observability:${id}`

        // Helper closure: when we transition into a new verdict bucket we
        // reset the buckets we're leaving so streaks of one kind don't
        // pollute the threshold for another. Each bucket is strictly
        // single-purpose post-Phase 49b — see counter declarations above.
        const resetOthers = (keep: 'gone' | 'unhealthy' | 'observability') => {
          if (keep !== 'gone') goneCounters.delete(goneKey)
          if (keep !== 'unhealthy') unhealthyCounters.delete(unhealthyKey)
          if (keep !== 'observability') observabilityCounters.delete(observabilityKey)
        }

        try {
          const health = await provider.getHealth(id)

          if (!health) {
            // No DB row for this deployment — orphan at our end. Treat as
            // 'gone' since we can't manage what we can't find.
            const count = (goneCounters.get(goneKey) ?? 0) + 1
            goneCounters.set(goneKey, count)
            resetOthers('gone')
            verdicts.push(
              count >= GONE_THRESHOLD
                ? { id, kind: 'close_gone', reason: 'gone', failures: count, healthOverall: 'no_record' }
                : { id, kind: 'visible_only', reason: 'unknown_health', failures: count, healthOverall: 'no_record' }
            )
          } else if (health.overall === 'gone') {
            // Lease genuinely gone on-chain (provider 404 or our DB has a
            // terminal failure status). Sweeper close path.
            const count = (goneCounters.get(goneKey) ?? 0) + 1
            goneCounters.set(goneKey, count)
            resetOthers('gone')
            verdicts.push(
              count >= GONE_THRESHOLD
                ? { id, kind: 'close_gone', reason: 'gone', failures: count, healthOverall: 'gone' }
                : { id, kind: 'visible_only', reason: 'unknown_health', failures: count, healthOverall: 'gone' }
            )
          } else if (health.overall === 'unhealthy') {
            // Container down, lease still alive. NEVER close from here —
            // the user needs the lease to debug. Only run the opt-in
            // failover branch; if no policy, audit-only. Strict counter:
            // ONLY consecutive `'unhealthy'` ticks count toward the
            // failover threshold (Phase 49b). Any `'unknown'` /
            // probe-exception in between resets the streak.
            const count = (unhealthyCounters.get(unhealthyKey) ?? 0) + 1
            unhealthyCounters.set(unhealthyKey, count)
            resetOthers('unhealthy')
            verdicts.push(
              count >= UNHEALTHY_THRESHOLD
                ? { id, kind: 'failover_check', reason: 'unhealthy', failures: count, healthOverall: 'unhealthy' }
                : { id, kind: 'visible_only', reason: 'unhealthy', failures: count, healthOverall: 'unhealthy' }
            )
          } else if (health.overall === 'unknown') {
            // Can't tell. Never closes. Tracked in its own bucket so it
            // doesn't inflate the unhealthy/gone thresholds.
            const count = (observabilityCounters.get(observabilityKey) ?? 0) + 1
            observabilityCounters.set(observabilityKey, count)
            resetOthers('observability')
            verdicts.push({
              id,
              kind: 'visible_only',
              reason: 'unknown_health',
              failures: count,
              healthOverall: 'unknown',
            })
          } else {
            // healthy / starting / degraded — nothing to do, reset counters.
            const wasUnhealthy = (unhealthyCounters.get(unhealthyKey) ?? 0) > 0
            const wasGone = (goneCounters.get(goneKey) ?? 0) > 0
            const wasObservability = (observabilityCounters.get(observabilityKey) ?? 0) > 0
            goneCounters.delete(goneKey)
            unhealthyCounters.delete(unhealthyKey)
            observabilityCounters.delete(observabilityKey)
            if (wasUnhealthy || wasGone || wasObservability) {
              const previousState = wasGone
                ? 'gone'
                : wasUnhealthy
                  ? 'unhealthy'
                  : 'observability'
              auditHealthRecovered(prisma, sweepTraceId, provider.name, id, {
                overall: health.overall,
                previousState,
              })
            }
            verdicts.push({ id, kind: 'healthy' })
          }
        } catch (err) {
          // Probe threw. Could be RPC timeout, CLI death, network blip.
          // We never close on raw exceptions — the provider 404 path is
          // already mapped to 'gone' inside getHealth(). Tracked in the
          // observability bucket (Phase 49b) so a transient probe blip
          // doesn't burn a tick of the unhealthy/failover counter.
          const errMsg = err instanceof Error ? err.message : String(err)
          const count = (observabilityCounters.get(observabilityKey) ?? 0) + 1
          observabilityCounters.set(observabilityKey, count)
          resetOthers('observability')
          log.warn(
            { provider: provider.name, deploymentId: id, err, failures: count },
            'Health check threw — recording probe exception (will NOT close)'
          )
          verdicts.push({
            id,
            kind: 'visible_only',
            reason: 'probe_exception_other',
            failures: count,
            probeError: errMsg,
          })
        }
      }

      // ─── Phase 2: mass-event guard ───
      // Trips on EITHER `close_gone` OR `failover_check` saturation. Phase 49b:
      // previously only `close_gone` counted, so a provider-wide outage that
      // flipped many opted-in services to `'unhealthy'` could fan out
      // fleet-wide auto-failover (each calling provider.close on its old
      // lease) without ever tripping the abort. We now treat both as
      // close-driving signals at the fleet level — any single pass with
      // ≥ MASS_EVENT_RATIO of total verdicts pointing at a close-shaped
      // action aborts ALL of them.
      const closures = verdicts.filter(
        (v): v is Extract<ReconcileVerdict, { kind: 'close_gone' }> => v.kind === 'close_gone'
      )
      const failovers = verdicts.filter(
        (v): v is Extract<ReconcileVerdict, { kind: 'failover_check' }> => v.kind === 'failover_check'
      )
      const closeShapedTotal = closures.length + failovers.length
      if (closeShapedTotal > 0 && verdicts.length >= MASS_EVENT_MIN_TOTAL) {
        const ratio = closeShapedTotal / verdicts.length
        if (ratio >= MASS_EVENT_RATIO) {
          const reasonBreakdown = {
            ...countReasons(closures),
            ...countReasons(failovers.map((f) => ({ reason: `failover:${f.reason}` }))),
          }
          log.error(
            {
              provider: provider.name,
              total: verdicts.length,
              wouldClose: closures.length,
              wouldFailover: failovers.length,
              ratio: +ratio.toFixed(2),
              reasons: reasonBreakdown,
            },
            'Mass close-shaped event detected — aborting close + failover this pass (likely provider-wide outage)'
          )
          await opsAlert({
            key: `mass-close-event:${provider.name}`,
            severity: 'critical',
            title: `Sweeper aborted mass close+failover (${provider.name})`,
            message:
              `Sweeper would have closed ${closures.length} and failed-over ${failovers.length} ` +
              `${provider.name} deployments in a single pass ` +
              `(${closeShapedTotal}/${verdicts.length}, ratio ${(ratio * 100).toFixed(0)}%). ` +
              `Aborted to avoid nuking the fleet on a provider-wide outage. ` +
              `Investigate provider/RPC health; counters were reset so next pass starts fresh.`,
            context: {
              provider: provider.name,
              total: String(verdicts.length),
              wouldClose: String(closures.length),
              wouldFailover: String(failovers.length),
              ratio: ratio.toFixed(2),
              reasons: JSON.stringify(reasonBreakdown),
              sweepTraceId,
            },
            suppressMs: 30 * 60 * 1000,
          }).catch((err) =>
            log.warn({ err }, 'opsAlert failed during mass-close abort'),
          )
          // Reset both buckets so the next pass starts fresh.
          for (const v of closures) goneCounters.delete(`${provider.name}:gone:${v.id}`)
          for (const v of failovers) unhealthyCounters.delete(`${provider.name}:unhealthy:${v.id}`)
          continue
        }
      }

      // ─── Phase 3: act on verdicts ───
      for (const v of verdicts) {
        if (v.kind === 'healthy') continue

        if (v.kind === 'visible_only') {
          // Audit on the first tick of a new unhealthy/unknown/exception
          // streak so the user has a forensic trail. Subsequent ticks of
          // the same streak don't re-audit (avoids spam) — but the close
          // audit (if it ever happens) has the full failure count anyway.
          if (v.failures === 1) {
            auditHealthObserved(prisma, sweepTraceId, provider.name, v.id, {
              reason: v.reason,
              healthOverall: v.healthOverall,
              probeError: v.probeError,
            })
          }
          log.debug(
            { provider: provider.name, deploymentId: v.id, failures: v.failures, reason: v.reason },
            'Deployment unhealthy/unknown/exception — recorded for visibility (no close)'
          )
          continue
        }

        if (v.kind === 'failover_check') {
          // Container reports unhealthy past UNHEALTHY_THRESHOLD ticks.
          // Try the opt-in failover path. If failover is disabled or
          // ineligible, we LOG/AUDIT the skip but do NOT close — the
          // user keeps their lease for debugging.
          await tryFailoverNoFallbackClose(prisma, provider, v.id, sweepTraceId, {
            reason: 'unhealthy',
            failures: v.failures,
            overall: v.healthOverall,
          })
          continue
        }

        // close_gone — the only path that actually closes.
        log.warn(
          {
            provider: provider.name,
            deploymentId: v.id,
            failures: v.failures,
            reason: v.reason,
            health: v.healthOverall,
          },
          'Deployment lease confirmed gone on-chain — closing to sync DB'
        )
        const closeAuditExtra: Record<string, unknown> = {
          reason: v.reason,
          failures: v.failures,
        }
        if (v.healthOverall) closeAuditExtra.overall = v.healthOverall
        if (v.probeError) closeAuditExtra.probeError = v.probeError

        try {
          await provider.close(v.id)
          auditHealthClose(prisma, sweepTraceId, provider.name, v.id, closeAuditExtra)
          totalReconciled++
        } catch (closeErr) {
          log.error(
            { provider: provider.name, deploymentId: v.id, err: closeErr },
            'Failed to close gone-lease deployment'
          )
        }
        goneCounters.delete(`${provider.name}:gone:${v.id}`)
        unhealthyCounters.delete(`${provider.name}:unhealthy:${v.id}`)
        observabilityCounters.delete(`${provider.name}:observability:${v.id}`)
      }
    } catch (err) {
      log.error({ provider: provider.name, err }, 'Failed to reconcile provider')
    }
  }

  if (totalReconciled > 0) {
    log.info({ reconciled: totalReconciled }, 'Reconciled gone-lease deployments across all providers')
  }
}

/**
 * Try the opt-in failover path for a container-unhealthy deployment.
 * Critical contract: this NEVER falls back to plain `close()`. If failover
 * is disabled or ineligible, the lease stays alive — the user keeps
 * forensic context. We only audit the skip reason so it's discoverable.
 */
async function tryFailoverNoFallbackClose(
  prisma: PrismaClient,
  provider: { name: string },
  deploymentId: string,
  sweepTraceId: string,
  extra: Record<string, unknown>
): Promise<void> {
  if (provider.name !== 'akash') {
    // Phala/etc don't have failover yet; skip silently.
    return
  }

  let eligibility: Awaited<ReturnType<typeof evaluateFailoverEligibility>>
  try {
    eligibility = await evaluateFailoverEligibility(prisma, deploymentId)
  } catch (evalErr) {
    log.warn(
      { deploymentId, err: evalErr },
      'failover eligibility evaluation threw — skipping (no close)'
    )
    return
  }

  if (!eligibility.eligible) {
    // Audit the skip when the user actually opted in (so they can see why
    // their failover policy didn't fire). Disabled-by-default services
    // would drown the audit log otherwise.
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
    log.debug(
      { deploymentId, reason: eligibility.reason, ...extra },
      'failover skipped — lease left alive (user can inspect logs / redeploy)'
    )
    return
  }

  try {
    const result = await executeFailover(prisma, deploymentId, {
      excludedProviders: eligibility.excludedProviders,
      reason: String(extra.reason ?? 'unhealthy'),
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
      'failover triggered for unhealthy deployment'
    )
  } catch (failoverErr) {
    log.error(
      { deploymentId, err: failoverErr },
      'failover execution failed — leaving lease alive (no fallback close)'
    )
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
    const row = await loadHealthCloseRow(prisma, providerName, providerDeploymentId)
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
 * Per-streak audit — fired the first time we observe an unhealthy /
 * unknown / probe-exception state (i.e. counter goes 0→1). Gives the user
 * a forensic trail "we noticed your deployment is broken at T" without
 * spamming an audit row every 5 minutes.
 */
function auditHealthObserved(
  prisma: PrismaClient,
  traceId: string,
  providerName: string,
  providerDeploymentId: string,
  extra: Record<string, unknown>
): void {
  void (async () => {
    const row = await loadHealthCloseRow(prisma, providerName, providerDeploymentId)
    audit(prisma, {
      traceId,
      source: 'monitor',
      category: 'health',
      action: 'health.deployment_unhealthy_observed',
      status: 'warn',
      orgId: row?.service?.project?.organizationId ?? null,
      projectId: row?.service?.projectId ?? null,
      serviceId: row?.serviceId ?? null,
      deploymentId: row?.id ?? providerDeploymentId,
      payload: { provider: providerName, ...extra },
    })
  })()
}

/**
 * Recovery audit — fired when a deployment that was previously unhealthy
 * / gone / unknown returns to a healthy state. Pairs with
 * `auditHealthObserved` to bracket the unhealthy window in the log.
 */
function auditHealthRecovered(
  prisma: PrismaClient,
  traceId: string,
  providerName: string,
  providerDeploymentId: string,
  extra: Record<string, unknown>
): void {
  void (async () => {
    const row = await loadHealthCloseRow(prisma, providerName, providerDeploymentId)
    audit(prisma, {
      traceId,
      source: 'monitor',
      category: 'health',
      action: 'health.deployment_health_recovered',
      status: 'ok',
      orgId: row?.service?.project?.organizationId ?? null,
      projectId: row?.service?.projectId ?? null,
      serviceId: row?.serviceId ?? null,
      deploymentId: row?.id ?? providerDeploymentId,
      payload: { provider: providerName, ...extra },
    })
  })()
}

async function loadHealthCloseRow(
  prisma: PrismaClient,
  providerName: string,
  providerDeploymentId: string
): Promise<HealthCloseRow | null> {
  if (providerName !== 'akash') return null
  try {
    return (await prisma.akashDeployment.findFirst({
      where: { id: providerDeploymentId },
      select: {
        id: true,
        serviceId: true,
        service: { select: { projectId: true, project: { select: { organizationId: true } } } },
      },
    })) as HealthCloseRow | null
  } catch (err) {
    log.debug({ err, providerName, providerDeploymentId }, 'audit enrichment lookup failed')
    return null
  }
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

/**
 * Spheron-specific upstream-cleanup retry pass.
 *
 * Spheron's DELETE endpoint enforces a 20-minute server-side minimum
 * runtime. When the user / sweeper / scheduler closes a Spheron VM
 * inside that floor, `spheronProvider.close()` settles billing locally
 * and marks `status = DELETED` but leaves `upstreamDeletedAt = null` so
 * this pass can finish the upstream cleanup once the floor elapses.
 *
 * Pass selects rows where:
 *   status = DELETED
 *   providerDeploymentId IS NOT NULL
 *   upstreamDeletedAt IS NULL
 *
 * For each, calls `client.deleteDeployment(providerDeploymentId)`:
 *   - Success → set upstreamDeletedAt = now()
 *   - isAlreadyGone (404 / "already deleted") → set upstreamDeletedAt = now()
 *   - isMinimumRuntimeNotMet → leave upstreamDeletedAt null, retry next sweep
 *   - Other error → leave null + log; retry next sweep
 *
 * Bound by `SPHERON_UPSTREAM_CLEANUP_BATCH` so a single bad sweep doesn't
 * spend the rate-limit budget. Errors NEVER escape — the sweep cycle
 * continues to other passes regardless.
 */
const SPHERON_UPSTREAM_CLEANUP_BATCH = 20

async function reconcileSpheronUpstreamCleanups(prisma: PrismaClient): Promise<void> {
  const client = getSpheronClient()
  if (!client) return // Spheron not configured — nothing to reconcile.

  let pending: Array<{
    id: string
    providerDeploymentId: string | null
    updatedAt: Date
  }> = []
  try {
    pending = await prisma.spheronDeployment.findMany({
      where: {
        status: 'DELETED',
        upstreamDeletedAt: null,
        providerDeploymentId: { not: null },
      },
      select: {
        id: true,
        providerDeploymentId: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: SPHERON_UPSTREAM_CLEANUP_BATCH,
    })
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, 'Spheron upstream-cleanup scan failed')
    return
  }

  if (pending.length === 0) return

  log.info(`Spheron upstream cleanup: ${pending.length} pending DELETE(s)`)

  for (const row of pending) {
    if (!row.providerDeploymentId) continue // narrowed by query; defensive.
    try {
      await client.deleteDeployment(row.providerDeploymentId)
      await prisma.spheronDeployment.update({
        where: { id: row.id },
        data: { upstreamDeletedAt: new Date() },
      })
      log.info(
        { localId: row.id, providerDeploymentId: row.providerDeploymentId },
        'Spheron upstream DELETE retry succeeded',
      )
    } catch (err) {
      if (err instanceof SpheronApiError) {
        if (err.isAlreadyGone()) {
          await prisma.spheronDeployment.update({
            where: { id: row.id },
            data: { upstreamDeletedAt: new Date() },
          }).catch(() => undefined)
          log.info(
            { localId: row.id, providerDeploymentId: row.providerDeploymentId },
            'Spheron upstream already gone — stamping upstreamDeletedAt',
          )
          continue
        }
        const min = err.isMinimumRuntimeNotMet()
        if (min) {
          log.debug(
            {
              localId: row.id,
              providerDeploymentId: row.providerDeploymentId,
              timeRemainingMinutes: min.timeRemainingMinutes,
            },
            'Spheron upstream DELETE still inside minimum-runtime window — will retry next sweep',
          )
          continue
        }
      }
      log.warn(
        {
          localId: row.id,
          providerDeploymentId: row.providerDeploymentId,
          err: err instanceof Error ? err.message : err,
        },
        'Spheron upstream DELETE retry failed — will retry next sweep',
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
    await reconcileSpheronUpstreamCleanups(prisma)
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
