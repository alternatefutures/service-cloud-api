/**
 * Lease-chain resolution helpers.
 *
 * The frontend's "Running for Xh" timer must reflect how long the user's
 * workload has been continuously up — NOT how long the most recent
 * `AkashDeployment` / `PhalaDeployment` row has been ACTIVE.
 *
 * A new row is created (and the most recent row is closed) whenever:
 *   - a queue-step retry fires inside a single deploy attempt
 *     (`parentDeploymentId` is set on the new row), or
 *   - the auto-failover sweeper declares the previous lease dead and
 *     spawns a replacement on a different provider
 *     (`failoverParentId` is set on the new row), or
 *   - the org wallet topped up after a balance-low SUSPEND and
 *     `resumeHandler` redeployed the saved SDL on a fresh row
 *     (`resumedFromId` is set on the new row).
 *
 * From the user's perspective all three cases are still the same continuously
 * running deployment — only a manual close + redeploy should reset the
 * timer (which it does naturally, because that creates a fresh row with
 * none of `parentDeploymentId` / `failoverParentId` / `resumedFromId`).
 *
 * These helpers walk the parent chain backwards and return the EARLIEST
 * `deployedAt` (Akash) / `activeStartedAt` (Phala) seen in the chain.
 */

import type { PrismaClient } from '@prisma/client'

/**
 * Hard cap on chain depth. Prevents pathological loops if a row ever
 * pointed at itself (shouldn't happen — the schema enforces a forward-
 * only reference because the parent must already exist when the child
 * row is created — but defensive depth caps cost nothing and a runaway
 * recursion in a GraphQL field resolver would lock up the API).
 */
const MAX_CHAIN_DEPTH = 100

/**
 * Walk back through (failoverParentId ?? resumedFromId ?? parentDeploymentId)
 * and return the earliest `deployedAt` in the chain. Returns null if NO row
 * in the chain ever reached ACTIVE (deployedAt only gets set on the ACTIVE
 * transition in `akashSteps.ts`).
 *
 * Precedence rationale:
 *   - failoverParentId ranks first because it's the strongest "this is a
 *     direct continuation of a different lease" signal — the sweeper only
 *     sets it when the previous lease was provably dead.
 *   - resumedFromId ranks second — it's the strongest "this is the same
 *     workload the user paused 2h ago" signal.
 *   - parentDeploymentId is the weakest — it's set by queue-step retries
 *     before the row ever reached ACTIVE, so the parent often has a null
 *     `deployedAt` anyway, but we still walk it so the chain's first
 *     successful ACTIVE row is found if a retry succeeded after several
 *     failed attempts.
 *
 * The visited-set guard catches any cycle introduced by a buggy resume
 * loop (defensive — real data should be a forward DAG).
 */
export async function resolveAkashActiveSince(
  prisma: PrismaClient,
  deploymentId: string,
): Promise<Date | null> {
  let earliest: Date | null = null
  const visited = new Set<string>()
  let cursor: {
    id: string
    deployedAt: Date | null
    failoverParentId: string | null
    resumedFromId: string | null
    parentDeploymentId: string | null
  } | null = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      deployedAt: true,
      failoverParentId: true,
      resumedFromId: true,
      parentDeploymentId: true,
    },
  })

  for (let i = 0; i < MAX_CHAIN_DEPTH && cursor; i++) {
    if (visited.has(cursor.id)) break
    visited.add(cursor.id)

    if (cursor.deployedAt && (!earliest || cursor.deployedAt < earliest)) {
      earliest = cursor.deployedAt
    }
    const parentId =
      cursor.failoverParentId ?? cursor.resumedFromId ?? cursor.parentDeploymentId
    if (!parentId) break
    cursor = await prisma.akashDeployment.findUnique({
      where: { id: parentId },
      select: {
        id: true,
        deployedAt: true,
        failoverParentId: true,
        resumedFromId: true,
        parentDeploymentId: true,
      },
    })
  }

  return earliest
}

/**
 * Phala equivalent. Phala's `activeStartedAt` is set when the CVM transitions
 * to ACTIVE. We walk:
 *   - resumedFromId: reserved for a future symmetry with Akash (see schema
 *     comment) — currently always null because Phala's `resumeHandler` reuses
 *     the existing row instead of spawning a new one.
 *   - parentDeploymentId: queue-step retries (set in `phalaSteps.ts`).
 *
 * The Phala resume timer-reset bug is fixed at the source — `resumeHandler`
 * no longer overwrites `activeStartedAt` on resume — so this walker stays
 * simple and the row-level value is the source of truth.
 */
export async function resolvePhalaActiveSince(
  prisma: PrismaClient,
  deploymentId: string,
): Promise<Date | null> {
  let earliest: Date | null = null
  const visited = new Set<string>()
  let cursor: {
    id: string
    activeStartedAt: Date | null
    resumedFromId: string | null
    parentDeploymentId: string | null
  } | null = await prisma.phalaDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      activeStartedAt: true,
      resumedFromId: true,
      parentDeploymentId: true,
    },
  })

  for (let i = 0; i < MAX_CHAIN_DEPTH && cursor; i++) {
    if (visited.has(cursor.id)) break
    visited.add(cursor.id)

    if (
      cursor.activeStartedAt &&
      (!earliest || cursor.activeStartedAt < earliest)
    ) {
      earliest = cursor.activeStartedAt
    }
    const parentId = cursor.resumedFromId ?? cursor.parentDeploymentId
    if (!parentId) break
    cursor = await prisma.phalaDeployment.findUnique({
      where: { id: parentId },
      select: {
        id: true,
        activeStartedAt: true,
        resumedFromId: true,
        parentDeploymentId: true,
      },
    })
  }

  return earliest
}
