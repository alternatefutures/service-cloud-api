/**
 * Launch guards — operational kill-switch, hourly cost cap, concurrency cap.
 *
 * These are env-driven circuit breakers that reject new deployments before any
 * on-chain or provider-side work happens. Complementary to `assertDeployBalance`
 * (which protects per-user funds) — these protect the PLATFORM from:
 *
 *   1. Known-bad state we can flip off without redeploying code
 *      (`DEPLOYMENTS_DISABLED=true`).
 *   2. Mis-clicks and obvious abuse (a beta user accidentally launching a
 *      $50/hr H200, or a griefer firing 20 leases in a minute)
 *      (`BETA_MAX_HOURLY_CENTS`, `MAX_ACTIVE_DEPLOYMENTS_PER_ORG`).
 *   3. Individual orgs that legitimately need higher limits
 *      (`BETA_HOURLY_CAP_ALLOWLIST` — CSV of organizationIds that bypass
 *      the hourly cap; concurrency cap still applies).
 *
 * Env vars are read per-call so ops can change them at runtime by rotating
 * the K8s configmap — no pod restart needed. `assertLaunchAllowed` is async
 * because the concurrency guard queries the DB.
 */

import { GraphQLError } from 'graphql'
import type { PrismaClient } from '@prisma/client'

function isTruthy(v: string | undefined): boolean {
  if (!v) return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function parsePositiveInt(v: string | undefined): number | null {
  if (!v) return null
  const n = parseInt(v.trim(), 10)
  if (!Number.isFinite(n) || n <= 0) return null
  return n
}

function parseCsvSet(v: string | undefined): Set<string> {
  if (!v) return new Set()
  return new Set(
    v.split(',')
      .map(s => s.trim())
      .filter(Boolean),
  )
}

/**
 * Reject all new deployments if the kill-switch is on.
 *
 * Set `DEPLOYMENTS_DISABLED=true` in the service-cloud-api configmap to flip
 * this without a code deploy. Useful for emergency incident response: stops
 * new bleed immediately while you debug.
 */
export function assertDeploymentsEnabled(): void {
  if (isTruthy(process.env.DEPLOYMENTS_DISABLED)) {
    const reason =
      process.env.DEPLOYMENTS_DISABLED_REASON?.trim() ||
      'Deployments are temporarily disabled while we investigate an issue. Please try again shortly.'
    throw new GraphQLError(reason, {
      extensions: { code: 'DEPLOYMENTS_DISABLED' },
    })
  }
}

/**
 * True if `organizationId` is in `BETA_HOURLY_CAP_ALLOWLIST` (CSV).
 * Exported so callers can surface the allowlist state in admin UIs if needed.
 */
export function isHourlyCapAllowlisted(organizationId: string | undefined | null): boolean {
  if (!organizationId) return false
  const allow = parseCsvSet(process.env.BETA_HOURLY_CAP_ALLOWLIST)
  return allow.has(organizationId)
}

/**
 * Enforce the per-deployment hourly cost cap.
 *
 * Set `BETA_MAX_HOURLY_CENTS` to a positive integer (e.g. 2000 = $20/hr) to
 * prevent any single deployment from exceeding that hourly rate. Unset or 0
 * disables the cap globally.
 *
 * Orgs listed in `BETA_HOURLY_CAP_ALLOWLIST` (CSV of organizationIds) bypass
 * this cap entirely. Use this to let specific power users launch $50/hr H200s
 * without lifting the platform-wide default.
 *
 * Rationale: the default cap is a safety net against mis-clicks and obvious
 * abuse. `assertDeployBalance` already ensures the user can actually afford
 * 1 hour of burn, so the cap is not a solvency gate — it's an upper bound on
 * "how wrong can a single click be".
 */
export function assertWithinHourlyCap(
  organizationId: string | undefined | null,
  projectedHourlyCostCents: number,
): void {
  const cap = parsePositiveInt(process.env.BETA_MAX_HOURLY_CENTS)
  if (cap === null) return // cap disabled globally
  if (isHourlyCapAllowlisted(organizationId)) return

  if (projectedHourlyCostCents > cap) {
    throw new GraphQLError(
      `Deployment hourly rate $${(projectedHourlyCostCents / 100).toFixed(2)}/hr ` +
      `exceeds the current account limit of $${(cap / 100).toFixed(2)}/hr. ` +
      `Contact support to raise your limit.`,
      {
        extensions: {
          code: 'HOURLY_CAP_EXCEEDED',
          projectedHourlyCostCents,
          maxHourlyCostCents: cap,
          allowlistable: true,
        },
      },
    )
  }
}

/**
 * Enforce a max number of concurrently-active compute deployments per org.
 *
 * Counts `AkashDeployment` + `PhalaDeployment` rows with status in an
 * "active or in-flight" set. Closed / suspended / failed do not count.
 *
 * `MAX_ACTIVE_DEPLOYMENTS_PER_ORG` — default 10 if unset (conservative beta).
 * Set to 0 to disable.
 *
 * Rationale: prevents a griefer with a funded wallet from spinning up 50
 * simultaneous leases to exhaust the deployer wallet's float or rate-limit
 * the Akash RPC. Also bounds the blast radius of a client bug that retries
 * deploy mutations in a loop.
 */
export async function assertOrgConcurrency(
  organizationId: string | undefined | null,
  prisma: PrismaClient,
): Promise<void> {
  if (!organizationId) return

  const rawCap = process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG
  // Unset → default 10. "0" → disabled. Anything non-numeric → default 10.
  let cap: number
  if (rawCap === undefined) {
    cap = 10
  } else if (rawCap.trim() === '0') {
    return // disabled
  } else {
    const parsed = parsePositiveInt(rawCap)
    cap = parsed ?? 10
  }

  const [akashActive, phalaActive] = await Promise.all([
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
  ])

  const total = akashActive + phalaActive
  if (total >= cap) {
    throw new GraphQLError(
      `You have ${total} active deployments, which is at the current limit of ${cap}. ` +
      `Close some before launching more, or contact support to raise your limit.`,
      {
        extensions: {
          code: 'CONCURRENCY_LIMIT_REACHED',
          activeDeployments: total,
          maxActiveDeployments: cap,
          akashActive,
          phalaActive,
        },
      },
    )
  }
}

/**
 * Convenience: run all three guards in order.
 * Call this at the very top of a deploy mutation, before any DB writes or
 * chain TXs. Pass the projected HOURLY cost (not daily).
 *
 * Order matters:
 *   1. Kill-switch — fail fast with no DB hits.
 *   2. Hourly cap  — synchronous env check, no DB.
 *   3. Concurrency — one DB count, runs last.
 */
export async function assertLaunchAllowed(
  organizationId: string | undefined | null,
  prisma: PrismaClient,
  projectedHourlyCostCents: number,
): Promise<void> {
  assertDeploymentsEnabled()
  assertWithinHourlyCap(organizationId, projectedHourlyCostCents)
  await assertOrgConcurrency(organizationId, prisma)
}
