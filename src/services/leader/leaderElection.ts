/**
 * Heartbeat-based leader election for singleton schedulers.
 *
 * The lease row in `scheduler_leader_lease` records who currently owns
 * a given scheduler key. A pod becomes leader by INSERTing or UPDATEing
 * the row in a single atomic statement that only succeeds if:
 *   * no row exists yet (first start ever), OR
 *   * the existing row has expired (previous leader crashed), OR
 *   * we are already the leader (heartbeat renewal).
 *
 * The leader renews `expires_at` every `LEADER_HEARTBEAT_MS`. If the
 * renewal fails (DB down, lost the lease, etc.) the local scheduler is
 * stopped immediately. Standbys keep polling and one of them takes
 * over once the previous lease expires.
 *
 * IMPORTANT: every scheduler wrapped by `runWithLeadership` MUST be
 * idempotent under "skipped one tick" semantics. There is a window of
 * up to `LEASE_TTL_MS - HEARTBEAT_MS` after a leader crash where no
 * pod is running the scheduler.
 */

import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('leader-election')

const HEARTBEAT_MS = parseInt(process.env.LEADER_HEARTBEAT_MS ?? '20000', 10)
const LEASE_TTL_MS = parseInt(process.env.LEADER_LEASE_TTL_MS ?? '60000', 10)
const LEADER_DISABLED = process.env.LEADER_ELECTION_DISABLED === 'true'

if (LEASE_TTL_MS <= HEARTBEAT_MS * 2) {
  // Misconfiguration that would cause flapping (renewal fails to land
  // before expiry under any DB latency). Loud at boot, never silent.
  log.warn(
    { HEARTBEAT_MS, LEASE_TTL_MS },
    'LEADER_LEASE_TTL_MS should be at least 2x LEADER_HEARTBEAT_MS to tolerate transient DB latency',
  )
}

const PROCESS_LEADER_ID = `${process.env.HOSTNAME ?? 'unknown'}:${randomUUID()}`

export interface LeaderHandle {
  readonly schedulerKey: string
  readonly leaderId: string
  /** Released by the lifecycle manager — callers should not invoke directly. */
  stop(): Promise<void>
  /** True while we still believe we own the lease. */
  isLeader(): boolean
}

export interface RunWithLeadershipOptions {
  /** Override the global heartbeat interval for this scheduler. */
  heartbeatMs?: number
  /** Override the global lease TTL for this scheduler. */
  leaseTtlMs?: number
  /**
   * Called when leadership is lost (renewal failure, race, etc). The
   * caller must stop the scheduler. Re-acquisition is handled by the
   * outer poll loop and `onAcquire` will fire again.
   */
  onLost?: (reason: string) => void | Promise<void>
}

interface SchedulerLifecycle {
  /** Called once when this pod becomes leader. Start the work. */
  onAcquire: (handle: LeaderHandle) => void | Promise<void>
  /** Called when leadership is lost. Stop the work. */
  onRelease: () => void | Promise<void>
}

interface RunningLease {
  schedulerKey: string
  leaderId: string
  heartbeatMs: number
  leaseTtlMs: number
  intervalHandle: ReturnType<typeof setInterval> | null
  pollHandle: ReturnType<typeof setInterval> | null
  isLeader: boolean
  stopped: boolean
  lifecycle: SchedulerLifecycle
  options: RunWithLeadershipOptions
}

const running = new Map<string, RunningLease>()

async function tryAcquire(
  prisma: PrismaClient,
  schedulerKey: string,
  leaderId: string,
  leaseTtlMs: number,
): Promise<boolean> {
  // Atomic acquire-or-renew. Postgres UPSERT semantics:
  //   * row missing → INSERT, rows[0].leader_id = us → success
  //   * row exists with our id → UPDATE (renewal), success
  //   * row exists, different id, expired → UPDATE (steal), success
  //   * row exists, different id, NOT expired → no rows updated, fail
  //
  // We compare leader_id in a CTE so that the WHERE clause runs against
  // the ROW that was there pre-update; otherwise the freshly-written
  // value would always equal `leaderId` and we'd think every collision
  // succeeded.
  const rows = await prisma.$queryRawUnsafe<{ leader_id: string }[]>(
    `INSERT INTO scheduler_leader_lease (scheduler_key, leader_id, acquired_at, expires_at, "updatedAt")
     VALUES ($1, $2, NOW(), NOW() + ($3 || ' milliseconds')::interval, NOW())
     ON CONFLICT (scheduler_key) DO UPDATE
       SET leader_id = EXCLUDED.leader_id,
           acquired_at = CASE WHEN scheduler_leader_lease.leader_id = EXCLUDED.leader_id
                              THEN scheduler_leader_lease.acquired_at
                              ELSE EXCLUDED.acquired_at END,
           expires_at = EXCLUDED.expires_at,
           "updatedAt" = NOW()
       WHERE scheduler_leader_lease.expires_at < NOW()
          OR scheduler_leader_lease.leader_id = EXCLUDED.leader_id
     RETURNING leader_id`,
    schedulerKey,
    leaderId,
    String(leaseTtlMs),
  )
  return rows.length > 0 && rows[0].leader_id === leaderId
}

async function releaseLease(
  prisma: PrismaClient,
  schedulerKey: string,
  leaderId: string,
): Promise<void> {
  // Only release if we still hold the lease — guards against accidental
  // delete after a steal.
  await prisma
    .$executeRawUnsafe(
      `DELETE FROM scheduler_leader_lease
       WHERE scheduler_key = $1 AND leader_id = $2`,
      schedulerKey,
      leaderId,
    )
    .catch((err) => {
      log.warn({ err, schedulerKey }, 'Failed to release leader lease (will expire naturally)')
    })
}

async function onLost(state: RunningLease, reason: string): Promise<void> {
  if (!state.isLeader) return
  state.isLeader = false
  log.warn({ schedulerKey: state.schedulerKey, reason }, 'Leadership lost')
  try {
    await state.lifecycle.onRelease()
  } catch (err) {
    log.error({ err, schedulerKey: state.schedulerKey }, 'onRelease threw — scheduler may be in a torn state')
  }
  if (state.options.onLost) {
    try {
      await state.options.onLost(reason)
    } catch (err) {
      log.warn({ err, schedulerKey: state.schedulerKey }, 'onLost callback threw')
    }
  }
}

async function attemptAcquireAndStart(
  prisma: PrismaClient,
  state: RunningLease,
): Promise<void> {
  if (state.isLeader || state.stopped) return
  let won = false
  try {
    won = await tryAcquire(prisma, state.schedulerKey, state.leaderId, state.leaseTtlMs)
  } catch (err) {
    log.warn({ err, schedulerKey: state.schedulerKey }, 'Lease acquire failed (will retry)')
    return
  }
  if (!won) return

  state.isLeader = true
  log.info(
    { schedulerKey: state.schedulerKey, leaderId: state.leaderId },
    'Acquired leader lease — starting scheduler',
  )

  // Start heartbeat first so a slow `onAcquire` doesn't lose us the
  // lease while we boot.
  state.intervalHandle = setInterval(() => {
    void (async () => {
      if (state.stopped) return
      try {
        const ok = await tryAcquire(prisma, state.schedulerKey, state.leaderId, state.leaseTtlMs)
        if (!ok) {
          await onLost(state, 'heartbeat-renewal-rejected')
        }
      } catch (err) {
        log.error({ err, schedulerKey: state.schedulerKey }, 'Heartbeat threw — relinquishing leadership')
        await onLost(state, 'heartbeat-threw')
      }
    })()
  }, state.heartbeatMs)

  try {
    const handle: LeaderHandle = {
      schedulerKey: state.schedulerKey,
      leaderId: state.leaderId,
      isLeader: () => state.isLeader,
      stop: () => stopLifecycle(prisma, state),
    }
    await state.lifecycle.onAcquire(handle)
  } catch (err) {
    log.error({ err, schedulerKey: state.schedulerKey }, 'onAcquire threw — releasing lease')
    await onLost(state, 'on-acquire-threw')
    if (state.intervalHandle) clearInterval(state.intervalHandle)
    state.intervalHandle = null
    await releaseLease(prisma, state.schedulerKey, state.leaderId)
  }
}

async function stopLifecycle(prisma: PrismaClient, state: RunningLease): Promise<void> {
  if (state.stopped) return
  state.stopped = true
  if (state.intervalHandle) clearInterval(state.intervalHandle)
  state.intervalHandle = null
  if (state.pollHandle) clearInterval(state.pollHandle)
  state.pollHandle = null
  if (state.isLeader) {
    state.isLeader = false
    try {
      await state.lifecycle.onRelease()
    } catch (err) {
      log.error({ err, schedulerKey: state.schedulerKey }, 'onRelease threw during shutdown')
    }
    await releaseLease(prisma, state.schedulerKey, state.leaderId)
  }
  running.delete(state.schedulerKey)
}

/**
 * Run a singleton scheduler under a leader lease. Multiple replicas
 * can call this concurrently — only one will be elected. The others
 * keep polling so they can take over within `leaseTtlMs` if the
 * current leader crashes.
 *
 * The returned handle is idempotent: calling `stop()` multiple times
 * is safe.
 *
 * Setting `LEADER_ELECTION_DISABLED=true` in the env runs the
 * scheduler immediately without any election, for local dev with one
 * replica or for emergencies where the lease table itself is
 * unavailable.
 */
export async function runWithLeadership(
  prisma: PrismaClient,
  schedulerKey: string,
  lifecycle: SchedulerLifecycle,
  options: RunWithLeadershipOptions = {},
): Promise<LeaderHandle> {
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS

  if (LEADER_DISABLED) {
    log.warn(
      { schedulerKey },
      'LEADER_ELECTION_DISABLED=true — running scheduler without lease (single-replica mode)',
    )
    const handle: LeaderHandle = {
      schedulerKey,
      leaderId: PROCESS_LEADER_ID,
      isLeader: () => true,
      stop: async () => {
        try {
          await lifecycle.onRelease()
        } catch (err) {
          log.error({ err, schedulerKey }, 'onRelease threw during disabled-mode shutdown')
        }
      },
    }
    await lifecycle.onAcquire(handle)
    return handle
  }

  if (running.has(schedulerKey)) {
    throw new Error(`Scheduler ${schedulerKey} already registered with leader election`)
  }

  const state: RunningLease = {
    schedulerKey,
    leaderId: PROCESS_LEADER_ID,
    heartbeatMs,
    leaseTtlMs,
    intervalHandle: null,
    pollHandle: null,
    isLeader: false,
    stopped: false,
    lifecycle,
    options,
  }
  running.set(schedulerKey, state)

  // Try once eagerly so a single-replica deploy doesn't wait the full
  // poll interval before starting the scheduler.
  await attemptAcquireAndStart(prisma, state)

  // Poll for the lease at twice the heartbeat rate. Followers check
  // often enough that takeover happens within ~1 heartbeat of crash.
  state.pollHandle = setInterval(() => {
    void attemptAcquireAndStart(prisma, state)
  }, Math.max(1000, Math.floor(heartbeatMs / 2)))

  return {
    schedulerKey,
    leaderId: PROCESS_LEADER_ID,
    isLeader: () => state.isLeader,
    stop: () => stopLifecycle(prisma, state),
  }
}

/**
 * Stop every leader-managed scheduler in this process. Used during
 * graceful shutdown so we release leases promptly (otherwise standbys
 * wait for `LEASE_TTL_MS` before taking over).
 */
export async function stopAllLeaderSchedulers(prisma: PrismaClient): Promise<void> {
  const states = Array.from(running.values())
  await Promise.all(states.map((s) => stopLifecycle(prisma, s)))
}
