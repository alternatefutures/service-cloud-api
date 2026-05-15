/**
 * Per-org concurrency counter service.
 *
 * Replaces the racy COUNT(*) check in `assertOrgConcurrency` with a
 * row-locked counter in `OrganizationConcurrencyCounter`. The full
 * lifecycle is:
 *
 *   1. Caller asks `assertAndIncrement(orgId, cap)`.
 *      - Open transaction.
 *      - SELECT FOR UPDATE the counter row (creating it at 0 if needed).
 *      - If `activeCount + 1 > cap` → throw, transaction rolls back.
 *      - Otherwise UPDATE active_count = active_count + 1, commit.
 *
 *   2. On every close path (success, failure, sweeper, suspension)
 *      caller invokes `decrement(orgId)`. The counter is clamped at 0
 *      so a double-decrement is idempotent.
 *
 *   3. The hourly reconciler `reconcileAll()` recomputes activeCount
 *      from the deployments table and overwrites the counter, so
 *      drift never accumulates past one cycle.
 */

import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('concurrency-service')

export class ConcurrencyCapExceededError extends Error {
  constructor(
    public readonly organizationId: string,
    public readonly activeCount: number,
    public readonly cap: number,
  ) {
    super(`Concurrency cap exceeded for org ${organizationId}: ${activeCount}/${cap}`)
    this.name = 'ConcurrencyCapExceededError'
  }
}

/**
 * Reserve a concurrency slot for `organizationId`. Throws
 * `ConcurrencyCapExceededError` if the cap would be exceeded; that
 * sentinel lets callers translate to the appropriate user-facing error
 * (GraphQLError CONCURRENCY_LIMIT_REACHED) without coupling this layer
 * to GraphQL.
 *
 * `cap` is passed in so the caller (launchGuards) controls the tier
 * lookup; this service only enforces the row-locked claim.
 */
export async function assertAndIncrementOrgConcurrency(
  prisma: PrismaClient,
  organizationId: string,
  cap: number,
): Promise<{ activeCount: number }> {
  return prisma.$transaction(async (tx) => {
    // Bootstrap the row if missing — happens on first deploy ever for
    // an org. We do NOT use upsert here because we need the SELECT FOR
    // UPDATE lock and Prisma's upsert doesn't expose row-level locking.
    const existingRows = await tx.$queryRawUnsafe<{ active_count: number }[]>(
      `SELECT active_count FROM organization_concurrency_counter
       WHERE organization_id = $1
       FOR UPDATE`,
      organizationId,
    )

    let current: number
    if (existingRows.length === 0) {
      // Concurrent inserts of the same orgId can race; we let the unique
      // PK reject the loser and re-read.
      try {
        await tx.organizationConcurrencyCounter.create({
          data: { organizationId, activeCount: 0 },
        })
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err
      }
      const reread = await tx.$queryRawUnsafe<{ active_count: number }[]>(
        `SELECT active_count FROM organization_concurrency_counter
         WHERE organization_id = $1
         FOR UPDATE`,
        organizationId,
      )
      current = reread[0]?.active_count ?? 0
    } else {
      current = existingRows[0].active_count
    }

    if (current + 1 > cap) {
      throw new ConcurrencyCapExceededError(organizationId, current, cap)
    }

    const updated = await tx.organizationConcurrencyCounter.update({
      where: { organizationId },
      data: { activeCount: current + 1 },
    })
    return { activeCount: updated.activeCount }
  })
}

/**
 * Release a concurrency slot. Idempotent: clamps at 0 so a double-call
 * (one from the resolver, one from the sweeper, etc.) is safe.
 *
 * If the row doesn't exist there is nothing to decrement — just no-op.
 */
export async function decrementOrgConcurrency(
  prisma: PrismaClient,
  organizationId: string | null | undefined,
): Promise<void> {
  if (!organizationId) return

  // The clamping `GREATEST(0, …)` is what makes double-decrements safe.
  // We use a raw query because Prisma's `decrement` doesn't have a
  // built-in floor and a TX wrapper for one statement is overkill.
  await prisma.$executeRawUnsafe(
    `UPDATE organization_concurrency_counter
     SET active_count = GREATEST(0, active_count - 1),
         "updatedAt" = NOW()
     WHERE organization_id = $1`,
    organizationId,
  )
}

/**
 * Counts the deployments that should occupy a concurrency slot for an org.
 * Mirrors the WHERE clause in `assertOrgConcurrency` so the reconciler
 * stays in lock-step with the launch-time check.
 */
async function countActiveDeploymentsForOrg(
  prisma: PrismaClient,
  organizationId: string,
): Promise<number> {
  const [akashActive, phalaActive, spheronActive] = await Promise.all([
    prisma.akashDeployment.count({
      where: {
        status: { in: ['CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING', 'ACTIVE'] },
        service: { project: { organizationId } },
      },
    }),
    prisma.phalaDeployment.count({
      where: {
        status: { in: ['CREATING', 'STARTING', 'ACTIVE'] },
        organizationId,
      },
    }),
    prisma.spheronDeployment.count({
      where: {
        status: { in: ['CREATING', 'STARTING', 'ACTIVE'] },
        service: { project: { organizationId } },
      },
    }),
  ])
  return akashActive + phalaActive + spheronActive
}

/**
 * Recompute the counter for a single org from the deployment tables.
 * Used by the reconciler and by callers that need to bootstrap a row
 * during runtime (e.g. legacy orgs that pre-date the counter).
 */
export async function recomputeOrgConcurrency(
  prisma: PrismaClient,
  organizationId: string,
): Promise<{ activeCount: number; previous: number | null }> {
  const actual = await countActiveDeploymentsForOrg(prisma, organizationId)
  const upserted = await prisma.organizationConcurrencyCounter.upsert({
    where: { organizationId },
    update: { activeCount: actual },
    create: { organizationId, activeCount: actual },
  })
  return { activeCount: upserted.activeCount, previous: null }
}

/**
 * Hourly reconciler: walk every counter row + every org that has a
 * counter-eligible deployment, recompute, and overwrite. Drift is
 * logged so we can see whether a particular close path is missing a
 * decrement.
 *
 * Bounded `limit` because we don't want a one-off inventory walk to
 * pin the DB. The job re-runs hourly so anything skipped this cycle
 * gets picked up next.
 */
export async function reconcileAll(
  prisma: PrismaClient,
  opts: { limit?: number } = {},
): Promise<{ scanned: number; drifted: number }> {
  const limit = opts.limit ?? 5000

  // Union of (orgs with a counter row) ∪ (orgs that currently own a
  // counter-eligible deployment). The right-hand side catches orgs
  // that have never had a counter row yet still have live deployments
  // (legacy data from before the counter shipped).
  const counterOrgs = await prisma.organizationConcurrencyCounter.findMany({
    select: { organizationId: true, activeCount: true },
    take: limit,
  })
  const phalaOrgs = await prisma.phalaDeployment.findMany({
    where: { organizationId: { not: null }, status: { in: ['CREATING', 'STARTING', 'ACTIVE'] } },
    select: { organizationId: true },
    distinct: ['organizationId'],
    take: limit,
  })
  const akashOrgsRaw = await prisma.akashDeployment.findMany({
    where: { status: { in: ['CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING', 'ACTIVE'] } },
    select: { service: { select: { project: { select: { organizationId: true } } } } },
    take: limit,
  })
  const spheronOrgsRaw = await prisma.spheronDeployment.findMany({
    where: { status: { in: ['CREATING', 'STARTING', 'ACTIVE'] } },
    select: { service: { select: { project: { select: { organizationId: true } } } } },
    take: limit,
  })

  const orgIds = new Set<string>()
  for (const c of counterOrgs) orgIds.add(c.organizationId)
  for (const p of phalaOrgs) {
    if (p.organizationId) orgIds.add(p.organizationId)
  }
  for (const a of akashOrgsRaw) {
    const id = a.service?.project?.organizationId
    if (id) orgIds.add(id)
  }
  for (const s of spheronOrgsRaw) {
    const id = s.service?.project?.organizationId
    if (id) orgIds.add(id)
  }

  const counterMap = new Map(counterOrgs.map((c) => [c.organizationId, c.activeCount]))

  let drifted = 0
  for (const orgId of orgIds) {
    const actual = await countActiveDeploymentsForOrg(prisma, orgId)
    const stored = counterMap.get(orgId) ?? null
    if (stored !== actual) {
      drifted++
      log.warn(
        { orgId, stored, actual },
        'Concurrency counter drift — recomputing from deployments table',
      )
    }
    await prisma.organizationConcurrencyCounter.upsert({
      where: { organizationId: orgId },
      update: { activeCount: actual },
      create: { organizationId: orgId, activeCount: actual },
    })
  }

  return { scanned: orgIds.size, drifted }
}
