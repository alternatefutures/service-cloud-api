/**
 * Launch guards — operational kill-switch, hourly cost cap, tier-aware
 * concurrency cap.
 *
 * These are env-driven circuit breakers that reject new deployments before any
 * on-chain or provider-side work happens. Complementary to `assertDeployBalance`
 * (which protects per-user funds) — these protect the PLATFORM from:
 *
 *   1. Known-bad state we can flip off without redeploying code
 *      (`DEPLOYMENTS_DISABLED=true`).
 *   2. Mis-clicks and obvious abuse (a beta user accidentally launching a
 *      $50/hr H200, or a griefer firing 20 leases in a minute)
 *      (`BETA_MAX_HOURLY_CENTS`, tier-based concurrency caps).
 *   3. Individual orgs that legitimately need higher limits
 *      (`BETA_HOURLY_CAP_ALLOWLIST` — CSV of organizationIds that bypass
 *      the hourly cap; concurrency cap still applies, sized by tier).
 *
 * Concurrency tiering (new in Phase 36):
 *   - TRIALING / unknown → `MAX_ACTIVE_DEPLOYMENTS_TRIAL` (default 10)
 *   - ACTIVE / PAST_DUE  → `MAX_ACTIVE_DEPLOYMENTS_PAID`  (default 25)
 *
 * Rationale: trial users start with a bounded credit grant ($5), so even the
 * maximum damage they can self-inflict is capped by balance. Once a user
 * subscribes they've committed a payment method and we can trust them with
 * a higher blast radius. `MAX_ACTIVE_DEPLOYMENTS_PER_ORG` acts as a hard
 * global override (e.g. during an incident) and ALWAYS wins when set.
 *
 * Env vars are read per-call so ops can change them at runtime by rotating
 * the K8s configmap — no pod restart needed. `assertLaunchAllowed` is async
 * because the concurrency guard queries the DB.
 */

import { GraphQLError } from 'graphql'
import type { PrismaClient } from '@prisma/client'
import type { SubscriptionStatusInfo } from './subscriptionCheck.js'

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

export type OrgTier = 'trial' | 'paid'

/**
 * Classify a subscription status into the two billing tiers that drive
 * concurrency caps. `null` / unknown defaults to `'trial'` (most restrictive,
 * fail-safe when the auth service is unreachable).
 *
 * TRIAL statuses: TRIALING, TRIAL_EXPIRED (the expired case is normally blocked
 * earlier by `assertSubscriptionActive`, but if it leaks through we want the
 * tighter cap).
 *
 * PAID statuses: ACTIVE (paid subscriber in good standing), PAST_DUE (paid
 * subscriber with a temporarily failed payment — still trusted, grace period).
 *
 * Everything else (null, SUSPENDED, CANCELED, UNPAID, INCOMPLETE) → trial.
 * Those paths are normally blocked upstream by `assertSubscriptionActive`;
 * the conservative mapping here is defense-in-depth.
 */
export function classifyTier(status: SubscriptionStatusInfo | null): OrgTier {
  const s = status?.status
  if (s === 'ACTIVE' || s === 'PAST_DUE') return 'paid'
  return 'trial'
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
 */
export function assertWithinHourlyCap(
  organizationId: string | undefined | null,
  projectedHourlyCostCents: number,
): void {
  const cap = parsePositiveInt(process.env.BETA_MAX_HOURLY_CENTS)
  if (cap === null) return
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
 * Resolve the active concurrency cap for a given tier, honoring:
 *   1. `MAX_ACTIVE_DEPLOYMENTS_PER_ORG` — global override, ALWAYS wins if set
 *      (including being set to exactly "0" which disables the guard entirely).
 *      Intended for incident response (lower it fast) or demos (disable it).
 *   2. `MAX_ACTIVE_DEPLOYMENTS_TRIAL` / `MAX_ACTIVE_DEPLOYMENTS_PAID` — normal
 *      per-tier values.
 *   3. Hard-coded defaults: 10 for trial, 25 for paid.
 *
 * Returns `null` when the guard is disabled (global override `"0"`). In that
 * case `assertOrgConcurrency` skips the DB query entirely.
 */
export function resolveConcurrencyCap(tier: OrgTier): number | null {
  const globalOverride = process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG
  if (globalOverride !== undefined) {
    if (globalOverride.trim() === '0') return null
    const parsed = parsePositiveInt(globalOverride)
    if (parsed !== null) return parsed
    // garbage → fall through to tier defaults
  }

  const tierEnv = tier === 'paid'
    ? process.env.MAX_ACTIVE_DEPLOYMENTS_PAID
    : process.env.MAX_ACTIVE_DEPLOYMENTS_TRIAL

  const parsed = parsePositiveInt(tierEnv)
  if (parsed !== null) return parsed

  return tier === 'paid' ? 25 : 10
}

/**
 * Enforce a max number of concurrently-active compute deployments per org,
 * sized by the org's subscription tier.
 *
 * Counts `AkashDeployment` + `PhalaDeployment` rows in any "active or in-flight"
 * status. Closed / suspended / failed / stopped do not count.
 */
export async function assertOrgConcurrency(
  organizationId: string | undefined | null,
  prisma: PrismaClient,
  subscriptionStatus: SubscriptionStatusInfo | null,
): Promise<void> {
  if (!organizationId) return

  const tier = classifyTier(subscriptionStatus)
  const cap = resolveConcurrencyCap(tier)
  if (cap === null) return // disabled globally

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
    const upgradeHint = tier === 'trial'
      ? ' Subscribe to a paid plan for a higher limit.'
      : ' Close some before launching more, or contact support to raise your limit.'

    throw new GraphQLError(
      `You have ${total} active deployments, which is at the current limit of ${cap} for your ${tier} plan.${upgradeHint}`,
      {
        extensions: {
          code: 'CONCURRENCY_LIMIT_REACHED',
          tier,
          activeDeployments: total,
          maxActiveDeployments: cap,
          akashActive,
          phalaActive,
          upgradeable: tier === 'trial',
        },
      },
    )
  }
}

/**
 * Convenience: run all three guards in order.
 * Call this at the very top of a deploy mutation, before any DB writes or
 * chain TXs. Pass the projected HOURLY cost (not daily) and the result of
 * `assertSubscriptionActive` so we don't double-fetch the subscription.
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
  subscriptionStatus: SubscriptionStatusInfo | null,
): Promise<void> {
  assertDeploymentsEnabled()
  assertWithinHourlyCap(organizationId, projectedHourlyCostCents)
  await assertOrgConcurrency(organizationId, prisma, subscriptionStatus)
}
