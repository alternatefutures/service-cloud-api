import type { PrismaClient } from '@prisma/client'
import { publishJob, isQStashEnabled } from '../queue/qstashClient.js'
import type { PolicyExpirePayload } from '../queue/types.js'
import { createLogger } from '../../lib/logger.js'
import { stopForPolicy } from './enforcer.js'

const log = createLogger('policy-runtime-scheduler')

const MAX_TIMEOUT_MS = 2_147_483_647

function isDeploymentActive(policy: {
  akashDeployment: { status: string } | null
  phalaDeployment: { status: string } | null
}): boolean {
  return (
    policy.akashDeployment?.status === 'ACTIVE' ||
    policy.phalaDeployment?.status === 'ACTIVE'
  )
}

function scheduleLocalTimeout(payload: PolicyExpirePayload, delayMs: number) {
  const nextDelayMs = Math.min(delayMs, MAX_TIMEOUT_MS)
  setTimeout(() => {
    if (delayMs > MAX_TIMEOUT_MS) {
      scheduleLocalTimeout(payload, delayMs - nextDelayMs)
      return
    }

    void import('../queue/webhookHandler.js')
      .then(({ handlePolicyStep }) => handlePolicyStep(payload))
      .catch(err => {
        log.error(
          { policyId: payload.policyId, err },
          'Local policy expiry execution failed'
        )
      })
  }, nextDelayMs)
}

export async function schedulePolicyExpiry(
  policyId: string,
  expiresAt: Date
): Promise<void> {
  const payload: PolicyExpirePayload = {
    step: 'EXPIRE_POLICY',
    policyId,
    expectedExpiresAt: expiresAt.toISOString(),
  }
  const delayMs = expiresAt.getTime() - Date.now()

  if (isQStashEnabled()) {
    await publishJob(
      '/queue/policy/expire',
      payload as unknown as Record<string, unknown>,
      {
      delaySec: Math.max(0, Math.ceil(delayMs / 1000)),
      }
    )
    return
  }

  if (delayMs <= 0) {
    const { handlePolicyStep } = await import('../queue/webhookHandler.js')
    await handlePolicyStep(payload)
    return
  }

  scheduleLocalTimeout(payload, delayMs)
}

export async function scheduleOrEnforcePolicyExpiry(
  prisma: PrismaClient,
  policyId: string
): Promise<void> {
  const policy = await prisma.deploymentPolicy.findUnique({
    where: { id: policyId },
    include: {
      akashDeployment: {
        select: { id: true, dseq: true, status: true },
      },
      phalaDeployment: {
        select: { id: true, appId: true, status: true, name: true },
      },
    },
  })

  if (!policy?.expiresAt || policy.stopReason || !isDeploymentActive(policy)) {
    return
  }

  const now = new Date()
  if (policy.expiresAt <= now) {
    await stopForPolicy(prisma, policy, 'RUNTIME_EXPIRED')
    return
  }

  await schedulePolicyExpiry(policy.id, policy.expiresAt)
}

export async function handlePolicyExpiry(
  prisma: PrismaClient,
  payload: PolicyExpirePayload
): Promise<void> {
  const policy = await prisma.deploymentPolicy.findUnique({
    where: { id: payload.policyId },
    include: {
      akashDeployment: {
        select: { id: true, dseq: true, status: true },
      },
      phalaDeployment: {
        select: { id: true, appId: true, status: true, name: true },
      },
    },
  })

  if (!policy?.expiresAt) {
    return
  }

  if (policy.stopReason) {
    return
  }

  if (policy.expiresAt.toISOString() !== payload.expectedExpiresAt) {
    log.info(
      {
        policyId: payload.policyId,
        expectedExpiresAt: payload.expectedExpiresAt,
        actualExpiresAt: policy.expiresAt.toISOString(),
      },
      'Ignoring stale policy expiry job'
    )
    return
  }

  const now = new Date()
  if (policy.expiresAt > now || !isDeploymentActive(policy)) {
    return
  }

  await stopForPolicy(prisma, policy, 'RUNTIME_EXPIRED')
}

export async function reconcileActivePolicyExpirySchedules(
  prisma: PrismaClient
): Promise<void> {
  const now = new Date()
  const policies = await prisma.deploymentPolicy.findMany({
    where: {
      stopReason: null,
      expiresAt: { gt: now },
      OR: [
        { akashDeployment: { is: { status: 'ACTIVE' } } },
        { phalaDeployment: { is: { status: 'ACTIVE' } } },
      ],
    },
    select: {
      id: true,
      expiresAt: true,
    },
  })

  for (const policy of policies) {
    if (!policy.expiresAt) continue
    await schedulePolicyExpiry(policy.id, policy.expiresAt)
  }

  log.info(
    { scheduledCount: policies.length },
    'Reconciled active deployment policy expiry schedules'
  )
}
