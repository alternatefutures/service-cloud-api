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
// 404 from provider = definitively dead, close immediately (1 check).
// Transient errors (unknown) get more chances before closing.
const UNHEALTHY_THRESHOLD = 1
const UNKNOWN_THRESHOLD = 3
const EXCEPTION_THRESHOLD = 3
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

      for (const id of activeIds) {
        const counterKey = `${provider.name}:${id}`

        try {
          const health = await provider.getHealth(id)

          if (!health || isDefinitelyDead(health)) {
            const count = (failureCounters.get(counterKey) ?? 0) + 1
            failureCounters.set(counterKey, count)

            if (count >= UNHEALTHY_THRESHOLD) {
              log.warn(
                { provider: provider.name, deploymentId: id, failures: count, health: health?.overall },
                'Deployment confirmed dead (unhealthy/404) — closing or failing over'
              )
              const ok = await closeOrFailover(prisma, provider, id, sweepTraceId, {
                reason: 'unhealthy',
                overall: health?.overall ?? '404',
                failures: count,
              })
              if (ok) totalReconciled++
              failureCounters.delete(counterKey)
            } else {
              log.debug(
                { provider: provider.name, deploymentId: id, failures: count, threshold: UNHEALTHY_THRESHOLD },
                'Deployment unhealthy — tracking consecutive failures'
              )
            }
          } else if (health.overall === 'unknown') {
            const count = (failureCounters.get(counterKey) ?? 0) + 1
            failureCounters.set(counterKey, count)

            if (count >= UNKNOWN_THRESHOLD) {
              log.warn(
                { provider: provider.name, deploymentId: id, failures: count },
                'Deployment returned unknown health for too many consecutive checks — closing or failing over'
              )
              const ok = await closeOrFailover(prisma, provider, id, sweepTraceId, {
                reason: 'unknown_health',
                overall: 'unknown',
                failures: count,
              })
              if (ok) totalReconciled++
              failureCounters.delete(counterKey)
            }
          } else {
            failureCounters.delete(counterKey)
          }
        } catch (err) {
          const count = (failureCounters.get(counterKey) ?? 0) + 1
          failureCounters.set(counterKey, count)
          log.warn(
            { provider: provider.name, deploymentId: id, err, failures: count },
            'Health check threw — counting as failure'
          )

          if (count >= EXCEPTION_THRESHOLD) {
            log.warn(
              { provider: provider.name, deploymentId: id, failures: count },
              'Health check exceptions exceeded threshold — closing or failing over'
            )
            const ok = await closeOrFailover(prisma, provider, id, sweepTraceId, {
              reason: 'probe_exception',
              failures: count,
              probeError: err instanceof Error ? err.message : String(err),
            })
            if (ok) totalReconciled++
            failureCounters.delete(counterKey)
          }
        }
      }
    } catch (err) {
      log.error({ provider: provider.name, err }, 'Failed to reconcile provider')
    }
  }

  if (totalReconciled > 0) {
    log.info({ reconciled: totalReconciled }, 'Reconciled dead deployments across all providers')
  }
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

function runSweep(prisma: PrismaClient): void {
  const sweep = (async () => {
    await sweepStaleDeployments(prisma)
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
