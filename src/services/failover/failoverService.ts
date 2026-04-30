/**
 * Health-aware Auto-failover (Phase 43)
 *
 * When the stale-deployment sweeper detects an ACTIVE deployment whose lease
 * is dead but where the failure looks like a *provider* problem (NOT an app
 * problem), we redeploy the same SDL to a different provider instead of
 * plain-closing it.
 *
 * This file is the single decision and execution point. The sweeper calls
 * `evaluateFailoverEligibility()` first, then `executeFailover()` only if
 * the evaluation said yes. Splitting evaluate/execute lets us audit the
 * "skip" path (with a precise reason code) without entering the failover
 * code path at all.
 *
 * Safety guards (see `evaluateFailoverEligibility`):
 *  - service.failoverPolicy must opt-in (defaults to disabled)
 *  - service has NO persistent volumes — failing over to a fresh provider
 *    silently loses /data; volumes-aware failover is a separate phase
 *  - container had been ACTIVE before (deployedAt != null) — otherwise this
 *    is a deploy-time failure and the existing 3-retry chain handles it
 *  - last application probe (Phase 42) is NOT failing — that points at the
 *    user's app, not the provider
 *  - attempts in window < cap — never burn escrow indefinitely on a buggy
 *    user setup
 *
 * The new deployment record carries forward `excludedProviders` (the union
 * of every provider this chain has run on), so `handleCheckBids` can skip
 * known-bad bidders before consulting `selectPreferredBid`.
 */

import { Prisma } from '@prisma/client'
import type { PrismaClient, AkashDeployment } from '@prisma/client'
import { audit } from '../../lib/audit.js'
import { createLogger } from '../../lib/logger.js'
import { getApplicationHealthRunner } from '../health/applicationHealthRunner.js'

const log = createLogger('failover')

export type FailoverSkipReason =
  | 'policy_disabled'
  | 'unsupported_provider'
  | 'has_volumes'
  | 'never_active'
  | 'app_unhealthy'
  | 'cap_exceeded'
  | 'no_chain_root'

export type FailoverEligibility =
  | {
      eligible: true
      attemptsInWindow: number
      maxAttempts: number
      windowHours: number
      excludedProviders: string[]
    }
  | { eligible: false; reason: FailoverSkipReason; detail?: string }

export interface FailoverPolicy {
  enabled: boolean
  maxAttempts: number
  windowHours: number
}

const DEFAULT_POLICY: FailoverPolicy = {
  enabled: false,
  maxAttempts: 3,
  windowHours: 24,
}

const MAX_ATTEMPTS_HARD_CAP = 10
const MIN_WINDOW_HOURS = 1
const MAX_WINDOW_HOURS = 24 * 30

/**
 * Parse the JSON column on Service into a strict policy struct, applying
 * defaults and clamping out-of-range values. Always returns a value — null
 * input means "all defaults", which has `enabled: false`.
 */
export function parseFailoverPolicy(raw: unknown): FailoverPolicy {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_POLICY }
  const obj = raw as Record<string, unknown>
  const enabled = obj.enabled === true
  const maxAttempts = clamp(numberOr(obj.maxAttempts, DEFAULT_POLICY.maxAttempts), 1, MAX_ATTEMPTS_HARD_CAP)
  const windowHours = clamp(numberOr(obj.windowHours, DEFAULT_POLICY.windowHours), MIN_WINDOW_HOURS, MAX_WINDOW_HOURS)
  return { enabled, maxAttempts, windowHours }
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v)
  if (typeof v === 'string') {
    const n = parseInt(v, 10)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/**
 * Walk the failover chain backward and count how many failover-spawned
 * deployments exist within the policy window. The current deployment counts
 * as the latest attempt; the cap is on TOTAL attempts in the window so a
 * cap of 3 means "the original + 2 failovers".
 */
export async function countAttemptsInWindow(
  prisma: PrismaClient,
  serviceId: string,
  windowHours: number
): Promise<number> {
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000)
  return prisma.akashDeployment.count({
    where: {
      serviceId,
      failoverParentId: { not: null },
      createdAt: { gte: since },
    },
  })
}

/**
 * Optional dependency seam for tests — lets the smoke test inject a fake
 * application-health probe lookup without going through the runner module
 * (which is an ESM singleton and therefore not patchable at runtime).
 */
export interface EvaluateDeps {
  getProbeOverall?: (serviceId: string) => 'unknown' | 'healthy' | 'unhealthy' | 'starting' | 'disabled'
}

/**
 * Decide whether this dead deployment should be failed over rather than
 * closed. Returns a discriminated union so the caller can both branch and
 * audit the skip reason in one place.
 */
export async function evaluateFailoverEligibility(
  prisma: PrismaClient,
  deploymentId: string,
  deps: EvaluateDeps = {}
): Promise<FailoverEligibility> {
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    select: {
      id: true,
      serviceId: true,
      provider: true,
      deployedAt: true,
      excludedProviders: true,
      service: {
        select: {
          id: true,
          volumes: true,
          failoverPolicy: true,
        },
      },
    },
  })

  if (!deployment || !deployment.service) {
    return { eligible: false, reason: 'no_chain_root', detail: 'deployment row missing' }
  }

  const policy = parseFailoverPolicy(deployment.service.failoverPolicy)
  if (!policy.enabled) {
    return { eligible: false, reason: 'policy_disabled' }
  }

  const volumes = Array.isArray(deployment.service.volumes) ? deployment.service.volumes : []
  if (volumes.length > 0) {
    return { eligible: false, reason: 'has_volumes', detail: `${volumes.length} volume(s)` }
  }

  if (!deployment.deployedAt) {
    return { eligible: false, reason: 'never_active' }
  }

  const probeLookup = deps.getProbeOverall ?? ((sid: string) => getApplicationHealthRunner().getOverall(sid))
  const probe = probeLookup(deployment.serviceId)
  if (probe === 'unhealthy') {
    return { eligible: false, reason: 'app_unhealthy' }
  }

  const attemptsInWindow = await countAttemptsInWindow(
    prisma,
    deployment.serviceId,
    policy.windowHours
  )
  if (attemptsInWindow >= policy.maxAttempts) {
    return {
      eligible: false,
      reason: 'cap_exceeded',
      detail: `${attemptsInWindow}/${policy.maxAttempts} in ${policy.windowHours}h`,
    }
  }

  const excluded = new Set<string>(deployment.excludedProviders ?? [])
  if (deployment.provider) excluded.add(deployment.provider)

  return {
    eligible: true,
    attemptsInWindow,
    maxAttempts: policy.maxAttempts,
    windowHours: policy.windowHours,
    excludedProviders: [...excluded],
  }
}

/**
 * Execute a failover for a deployment that has been judged eligible.
 *
 * Strict ordering:
 *   1. Close the dead deployment (settles billing — REQUIRED before we spend
 *      escrow on a fresh provider).
 *   2. Clone the policy row (same shape as queue-step retry chain) so the
 *      new deployment has its own budget tracking.
 *   3. Insert a new AkashDeployment in CREATING with `failoverParentId` and
 *      the carried-forward `excludedProviders` array.
 *   4. Audit + enqueue SUBMIT_TX (in-process or via QStash, same path the
 *      original deployment used).
 *
 * Returns the new deployment id so the caller can correlate logs.
 */
export async function executeFailover(
  prisma: PrismaClient,
  deploymentId: string,
  context: {
    excludedProviders: string[]
    reason: string
    triggeredBy: 'sweeper' | 'manual'
    traceId: string
  }
): Promise<{ newDeploymentId: string }> {
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: deploymentId },
    include: { service: { select: { id: true, projectId: true, project: { select: { organizationId: true } } } } },
  })
  if (!deployment) throw new Error(`Deployment not found: ${deploymentId}`)

  const oldProvider = deployment.provider
  const orgId = deployment.service?.project?.organizationId ?? null
  const projectId = deployment.service?.projectId ?? null
  const serviceId = deployment.serviceId

  // 1. Close current. We import lazily to avoid a top-level circular: the
  // provider registry pulls failoverService transitively via the sweeper.
  const { tryGetProvider } = await import('../providers/registry.js')
  const provider = tryGetProvider('akash')
  if (!provider) throw new Error('Akash provider not registered — cannot failover')

  try {
    await provider.close(deploymentId)
  } catch (closeErr) {
    log.warn(
      { deploymentId, err: closeErr instanceof Error ? closeErr.message : closeErr },
      'failover: close of old deployment failed — continuing so we still re-deploy'
    )
  }

  // 2. Clone policy row (mirror handleFailure semantics).
  let retryPolicyId: string | undefined
  if (deployment.policyId) {
    const existingPolicy = await prisma.deploymentPolicy.findUnique({
      where: { id: deployment.policyId },
    })
    if (existingPolicy) {
      const retryPolicy = await prisma.deploymentPolicy.create({
        data: {
          acceptableGpuModels: existingPolicy.acceptableGpuModels,
          gpuUnits: existingPolicy.gpuUnits,
          gpuVendor: existingPolicy.gpuVendor,
          maxBudgetUsd: existingPolicy.maxBudgetUsd,
          maxMonthlyUsd: existingPolicy.maxMonthlyUsd,
          runtimeMinutes: existingPolicy.runtimeMinutes,
          expiresAt: existingPolicy.runtimeMinutes
            ? new Date(Date.now() + existingPolicy.runtimeMinutes * 60_000)
            : null,
          reservedCents: existingPolicy.reservedCents,
          totalSpentUsd: existingPolicy.totalSpentUsd,
        },
      })
      retryPolicyId = retryPolicy.id
    }
  }

  // 3. Spawn the new deployment row. Negative dseq is the same temporary
  // marker the orchestrator uses pre-SUBMIT_TX (avoids the unique constraint).
  //
  // Phase 46/47 — carry `region` forward so the user's intent survives
  // failover. Without this, the failover row has region=NULL, the
  // server-side bid filter (akashSteps.handleCheckBids) doesn't fire,
  // and the deployment lands wherever's cheapest globally — often a
  // different region than the user picked. The "Failover policy: tiered"
  // design (M4) will eventually relax this to soft-region after N
  // exclusions; for now the user's region choice is honored every time.
  const newDeployment = await prisma.akashDeployment.create({
    data: {
      owner: deployment.owner,
      dseq: BigInt(-Date.now()),
      sdlContent: deployment.sdlContent,
      serviceId: deployment.serviceId,
      afFunctionId: deployment.afFunctionId,
      siteId: deployment.siteId,
      depositUakt: deployment.depositUakt,
      gpuModel: deployment.gpuModel,
      status: 'CREATING',
      retryCount: 0,
      failoverParentId: deploymentId,
      excludedProviders: context.excludedProviders,
      failoverReason: context.reason,
      policyId: retryPolicyId,
      region: deployment.region,
    } as Prisma.AkashDeploymentUncheckedCreateInput,
  })

  audit(prisma, {
    traceId: context.traceId,
    source: context.triggeredBy === 'sweeper' ? 'monitor' : 'cloud-api',
    category: 'deployment',
    action: 'failover.triggered',
    status: 'warn',
    orgId,
    projectId,
    serviceId,
    deploymentId: newDeployment.id,
    payload: {
      fromDeploymentId: deploymentId,
      oldProvider,
      excludedProviders: context.excludedProviders,
      reason: context.reason,
    },
  })

  // 4. Enqueue SUBMIT_TX. Use the same indirection the orchestrator uses so
  // local dev (no QStash) and prod take the same code path.
  const { isQStashEnabled, publishJob } = await import('../queue/qstashClient.js')
  if (isQStashEnabled()) {
    await publishJob('/queue/akash/step', {
      step: 'SUBMIT_TX',
      deploymentId: newDeployment.id,
    })
  } else {
    const { handleAkashStep } = await import('../queue/webhookHandler.js')
    handleAkashStep({ step: 'SUBMIT_TX', deploymentId: newDeployment.id }).catch((err) => {
      log.error({ err, deploymentId: newDeployment.id }, 'failover: in-process SUBMIT_TX dispatch failed')
    })
  }

  log.info(
    {
      fromDeploymentId: deploymentId,
      newDeploymentId: newDeployment.id,
      excludedProviders: context.excludedProviders,
      reason: context.reason,
    },
    'failover: spawned replacement deployment'
  )

  return { newDeploymentId: newDeployment.id }
}

/**
 * Convenience for the sweeper: emit a structured skip event so the audit log
 * has the same `failover.skipped` row regardless of where the decision was
 * made. We only emit when failover was even *considered* (i.e. policy was
 * enabled), to avoid drowning the log in `policy_disabled` rows for the
 * default-off majority of services.
 */
export function auditFailoverSkipped(
  prisma: PrismaClient,
  args: {
    traceId: string
    deployment: Pick<AkashDeployment, 'id' | 'serviceId'> & {
      service?: { projectId?: string | null; project?: { organizationId?: string | null } | null } | null
    }
    reason: FailoverSkipReason
    detail?: string
  }
): void {
  audit(prisma, {
    traceId: args.traceId,
    source: 'monitor',
    category: 'deployment',
    action: 'failover.skipped',
    status: 'warn',
    orgId: args.deployment.service?.project?.organizationId ?? null,
    projectId: args.deployment.service?.projectId ?? null,
    serviceId: args.deployment.serviceId,
    deploymentId: args.deployment.id,
    payload: { reason: args.reason, ...(args.detail ? { detail: args.detail } : {}) },
  })
}
