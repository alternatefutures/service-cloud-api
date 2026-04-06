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
import { createLogger } from '../../lib/logger.js'

const log = createLogger('stale-sweeper')

const STALE_THRESHOLD_MS = 25 * 60 * 1000 // 25 minutes
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

  // Akash: find deployments stuck in intermediate states for >15 min
  try {
    const staleAkash = await prisma.akashDeployment.findMany({
      where: {
        status: { in: [...AKASH_INTERMEDIATE_STATES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, status: true, updatedAt: true, retryCount: true, dseq: true },
    })

    for (const dep of staleAkash) {
      log.warn(`Akash deployment ${dep.id} stuck in ${dep.status} since ${dep.updatedAt.toISOString()} — marking FAILED`)
      if (dep.dseq && Number(dep.dseq) > 0) {
        try {
          const orchestrator = getAkashOrchestrator(prisma)
          await orchestrator.closeDeployment(Number(dep.dseq))
          log.info(`Closed on-chain deployment dseq=${dep.dseq} during stale sweep`)
        } catch (closeErr) {
          log.warn({ dseq: String(dep.dseq), err: closeErr }, 'Failed to close on-chain deployment during sweep — may still be leaking')
        }
      }
      await prisma.akashDeployment.updateMany({
        where: { id: dep.id, status: dep.status },
        data: {
          status: 'FAILED',
          errorMessage: `Stale deployment detected: stuck in ${dep.status} for >15 minutes (swept at ${new Date().toISOString()})`,
        },
      })
    }

    if (staleAkash.length > 0) {
      log.info(`Marked ${staleAkash.length} stale Akash deployment(s) as FAILED`)
    }
  } catch (err) {
    log.error(err as Error, 'Error sweeping Akash deployments')
  }

  // Phala: find deployments stuck in intermediate states for >15 min
  try {
    const stalePhala = await prisma.phalaDeployment.findMany({
      where: {
        status: { in: [...PHALA_INTERMEDIATE_STATES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, status: true, updatedAt: true, retryCount: true, appId: true },
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
      await prisma.phalaDeployment.updateMany({
        where: { id: dep.id, status: dep.status },
        data: {
          status: 'FAILED',
          errorMessage: `Stale deployment detected: stuck in ${dep.status} for >15 minutes (swept at ${new Date().toISOString()})`,
        },
      })
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
const CONSECUTIVE_FAILURE_THRESHOLD = 3
const failureCounters = new Map<string, number>()

function isDefinitelyDead(health: { overall: string }): boolean {
  return health.overall === 'unhealthy'
}

async function reconcileActiveDeployments(_prisma: PrismaClient): Promise<void> {
  const providers = getAvailableProviders()
  let totalReconciled = 0

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

            if (count >= CONSECUTIVE_FAILURE_THRESHOLD) {
              log.warn(
                { provider: provider.name, deploymentId: id, failures: count, health: health?.overall },
                'Deployment confirmed dead after consecutive failures — closing'
              )
              try {
                await provider.close(id)
                totalReconciled++
              } catch (closeErr) {
                log.error(
                  { provider: provider.name, deploymentId: id, err: closeErr },
                  'Failed to close dead deployment'
                )
              }
              failureCounters.delete(counterKey)
            } else {
              log.debug(
                { provider: provider.name, deploymentId: id, failures: count, threshold: CONSECUTIVE_FAILURE_THRESHOLD },
                'Deployment unhealthy — tracking consecutive failures'
              )
            }
          } else if (health.overall === 'unknown') {
            const count = (failureCounters.get(counterKey) ?? 0) + 1
            failureCounters.set(counterKey, count)

            if (count >= CONSECUTIVE_FAILURE_THRESHOLD * 2) {
              log.warn(
                { provider: provider.name, deploymentId: id, failures: count },
                'Deployment returned unknown health for too many consecutive checks — closing'
              )
              try {
                await provider.close(id)
                totalReconciled++
              } catch (closeErr) {
                log.error(
                  { provider: provider.name, deploymentId: id, err: closeErr },
                  'Failed to close unknown-health deployment'
                )
              }
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

          if (count >= CONSECUTIVE_FAILURE_THRESHOLD) {
            log.warn(
              { provider: provider.name, deploymentId: id, failures: count },
              'Health check exceptions exceeded threshold — closing'
            )
            try {
              await provider.close(id)
              totalReconciled++
            } catch (closeErr) {
              log.error(
                { provider: provider.name, deploymentId: id, err: closeErr },
                'Failed to close deployment after health-check exceptions'
              )
            }
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
 * Reconcile orphaned escrow records: any ACTIVE/DEPLETED escrow whose
 * linked AkashDeployment is in a terminal state should be settled and refunded.
 */
async function reconcileOrphanedEscrows(prisma: PrismaClient): Promise<void> {
  const TERMINAL_STATUSES = ['CLOSED', 'FAILED', 'PERMANENTLY_FAILED']

  const orphaned = await prisma.deploymentEscrow.findMany({
    where: {
      status: { in: ['ACTIVE', 'DEPLETED'] },
      akashDeployment: { status: { in: TERMINAL_STATUSES } },
    },
    select: {
      id: true,
      akashDeploymentId: true,
      akashDeployment: { select: { closedAt: true } },
    },
  })

  if (orphaned.length === 0) return

  log.info(`Found ${orphaned.length} orphaned escrow(s) — settling and refunding`)

  const escrowService = getEscrowService(prisma)

  for (const esc of orphaned) {
    try {
      const settledAt = esc.akashDeployment.closedAt || new Date()
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
