/**
 * Stale Deployment Sweeper
 *
 * Periodically scans for deployments stuck in intermediate states and marks
 * them FAILED so the retry mechanism can pick them up (or they reach terminal
 * state). This is the safety net for any lost QStash messages, server restarts,
 * or enqueueNext failures.
 *
 * Runs on startup and then every SWEEP_INTERVAL_MS.
 */

import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('stale-sweeper')

const STALE_THRESHOLD_MS = 15 * 60 * 1000 // 15 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000   // 5 minutes

const AKASH_INTERMEDIATE_STATES = [
  'CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING',
] as const

const PHALA_INTERMEDIATE_STATES = [
  'CREATING', 'STARTING',
] as const

let sweepInterval: ReturnType<typeof setInterval> | null = null

async function sweepStaleDeployments(prisma: PrismaClient): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS)

  // Akash: find deployments stuck in intermediate states for >15 min
  try {
    const staleAkash = await prisma.akashDeployment.findMany({
      where: {
        status: { in: [...AKASH_INTERMEDIATE_STATES] },
        updatedAt: { lt: cutoff },
      },
      select: { id: true, status: true, updatedAt: true, retryCount: true },
    })

    for (const dep of staleAkash) {
      log.warn(`Akash deployment ${dep.id} stuck in ${dep.status} since ${dep.updatedAt.toISOString()} — marking FAILED`)
      await prisma.akashDeployment.update({
        where: { id: dep.id },
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
      select: { id: true, status: true, updatedAt: true, retryCount: true },
    })

    for (const dep of stalePhala) {
      log.warn(`Phala deployment ${dep.id} stuck in ${dep.status} since ${dep.updatedAt.toISOString()} — marking FAILED`)
      await prisma.phalaDeployment.update({
        where: { id: dep.id },
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

export function startStaleDeploymentSweeper(prisma: PrismaClient): void {
  // Run immediately on startup
  sweepStaleDeployments(prisma).catch(err => {
    log.error(err as Error, 'Initial sweep failed')
  })

  // Then run periodically
  sweepInterval = setInterval(() => {
    sweepStaleDeployments(prisma).catch(err => {
      log.error(err as Error, 'Periodic sweep failed')
    })
  }, SWEEP_INTERVAL_MS)

  log.info(`Stale deployment sweeper started (every ${SWEEP_INTERVAL_MS / 1000}s, threshold ${STALE_THRESHOLD_MS / 1000}s)`)
}

export function stopStaleDeploymentSweeper(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval)
    sweepInterval = null
  }
}
