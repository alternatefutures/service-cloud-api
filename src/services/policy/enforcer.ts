import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { getEscrowService } from '../billing/escrowService.js'
import {
  processFinalPhalaBilling,
  processFinalSpheronBilling,
  settleAkashEscrowToTime,
} from '../billing/deploymentSettlement.js'
import { tryGetProvider } from '../providers/registry.js'
import { audit } from '../../lib/audit.js'

const log = createLogger('policy-enforcer')

export interface PolicyEnforcementStats {
  budgetStopped: number
  runtimeExpired: number
  errors: number
}

/**
 * Check all active deployments with policies and stop any that exceed limits.
 * Called from the billing scheduler after billing steps complete.
 */
export async function checkPolicyLimits(prisma: PrismaClient): Promise<PolicyEnforcementStats> {
  const stats: PolicyEnforcementStats = { budgetStopped: 0, runtimeExpired: 0, errors: 0 }
  const now = new Date()

  const policiesNeedingEnforcement = await prisma.deploymentPolicy.findMany({
    where: {
      stopReason: null,
      OR: [
        { expiresAt: { lte: now } },
        {
          maxBudgetUsd: { not: null },
        },
      ],
    },
    include: {
      akashDeployment: { select: { id: true, dseq: true, status: true } },
      phalaDeployment: { select: { id: true, appId: true, status: true, name: true } },
      spheronDeployment: { select: { id: true, providerDeploymentId: true, status: true } },
    },
  })

  log.info({ count: policiesNeedingEnforcement.length }, 'Checking policies for enforcement')

  for (const policy of policiesNeedingEnforcement) {
    try {
      const deployment =
        policy.akashDeployment ?? policy.phalaDeployment ?? policy.spheronDeployment
      if (!deployment) continue

      const isActive =
        policy.akashDeployment?.status === 'ACTIVE' ||
        policy.phalaDeployment?.status === 'ACTIVE' ||
        policy.spheronDeployment?.status === 'ACTIVE'
      if (!isActive) continue

      // Runtime expiration check
      if (policy.expiresAt && policy.expiresAt <= now) {
        log.info({ policyId: policy.id }, 'Policy runtime expired')
        await stopForPolicy(prisma, policy, 'RUNTIME_EXPIRED')
        stats.runtimeExpired++
        continue
      }

      // Budget check
      if (policy.maxBudgetUsd != null && policy.totalSpentUsd >= policy.maxBudgetUsd) {
        log.info(
          { policyId: policy.id, spent: policy.totalSpentUsd, cap: policy.maxBudgetUsd },
          'Policy budget exceeded'
        )
        await stopForPolicy(prisma, policy, 'BUDGET_EXCEEDED')
        stats.budgetStopped++
        continue
      }
    } catch (error) {
      stats.errors++
      log.error({ policyId: policy.id, err: error }, 'Policy enforcement error')
    }
  }

  log.info(stats, 'Policy enforcement complete')
  return stats
}

/**
 * Stop a deployment due to policy violation and record the reason.
 */
export async function stopForPolicy(
  prisma: PrismaClient,
  policy: {
    id: string
    akashDeployment: { id: string; dseq: bigint | string | null } | null
    phalaDeployment: { id: string; appId: string } | null
    spheronDeployment: { id: string; providerDeploymentId: string | null } | null
  },
  reason: 'BUDGET_EXCEEDED' | 'RUNTIME_EXPIRED'
) {
  const now = new Date()

  // Clearing the reservation lets the unused funds flow back into the org's
  // effective balance via balanceCheck.ts.
  await prisma.deploymentPolicy.update({
    where: { id: policy.id },
    data: { stopReason: reason, stoppedAt: now, reservedCents: 0 },
  })

  if (policy.akashDeployment) {
    try {
      const { getAkashOrchestrator } = await import('../akash/orchestrator.js')
      const orchestrator = getAkashOrchestrator(prisma)
      await orchestrator.closeDeployment(Number(policy.akashDeployment.dseq))
    } catch (err) {
      log.warn({ dseq: policy.akashDeployment.dseq, err }, 'Failed to close Akash on-chain')
    }

    await prisma.akashDeployment.update({
      where: { id: policy.akashDeployment.id },
      data: { status: 'CLOSED', closedAt: now },
    })

    await settleAkashEscrowToTime(prisma, policy.akashDeployment.id, now)
    await getEscrowService(prisma).refundEscrow(policy.akashDeployment.id)
  }

  if (policy.phalaDeployment) {
    await processFinalPhalaBilling(
      prisma,
      policy.phalaDeployment.id,
      now,
      `policy_${reason.toLowerCase()}`
    )

    try {
      const { getPhalaOrchestrator } = await import('../phala/orchestrator.js')
      const orchestrator = getPhalaOrchestrator(prisma)
      await orchestrator.stopPhalaDeployment(policy.phalaDeployment.appId)
    } catch (err) {
      log.warn({ appId: policy.phalaDeployment.appId, err }, 'Failed to stop Phala CVM')
    }

    await prisma.phalaDeployment.update({
      where: { id: policy.phalaDeployment.id },
      data: { status: 'STOPPED' },
    })
  }

  if (policy.spheronDeployment) {
    // Spheron settles inside provider.close(); call the registry path to
    // keep the on-chain billing contract identical to user-initiated close.
    await processFinalSpheronBilling(
      prisma,
      policy.spheronDeployment.id,
      now,
      `policy_${reason.toLowerCase()}`
    )

    const spheron = tryGetProvider('spheron')
    if (spheron) {
      try {
        await spheron.close(policy.spheronDeployment.id)
      } catch (err) {
        log.warn(
          { id: policy.spheronDeployment.id, err },
          'Failed to close Spheron deployment for policy stop',
        )
      }
    }
  }

  const provider = policy.akashDeployment
    ? 'akash'
    : policy.phalaDeployment
      ? 'phala'
      : 'spheron'
  const deploymentId =
    policy.akashDeployment?.id ??
    policy.phalaDeployment?.id ??
    policy.spheronDeployment?.id

  log.info({ policyId: policy.id, reason, provider }, 'Deployment stopped by policy')

  audit(prisma, {
    category: 'deployment',
    action: 'policy.auto_stopped',
    status: 'ok',
    deploymentId,
    payload: { reason, policyId: policy.id, provider },
  })
}

/**
 * Update totalSpentUsd on a policy from billing data.
 */
export async function updatePolicySpend(
  prisma: PrismaClient,
  policyId: string,
  additionalUsd: number
) {
  await prisma.deploymentPolicy.update({
    where: { id: policyId },
    data: { totalSpentUsd: { increment: additionalUsd } },
  })
}
