import type { PrismaClient } from '@prisma/client'
import { getBillingApiClient } from './billingApiClient.js'
import { akashPricePerBlockToUsdPerDay, applyMargin, getAktUsdPrice } from '../../config/pricing.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('deployment-settlement')

const MINUTE_MS = 60_000
const DAY_MINUTES = 24 * 60

export function calculateProratedAkashCents(
  dailyRateCents: number,
  elapsedMs: number
): number {
  if (dailyRateCents <= 0 || elapsedMs <= 0) return 0

  const billableMinutes = Math.ceil(elapsedMs / MINUTE_MS)
  return Math.ceil((billableMinutes / DAY_MINUTES) * dailyRateCents)
}

export function calculateProratedPhalaCents(
  hourlyRateCents: number,
  elapsedMs: number
): number {
  if (hourlyRateCents <= 0 || elapsedMs <= 0) return 0

  const billableMinutes = Math.ceil(elapsedMs / MINUTE_MS)
  return Math.ceil((billableMinutes / 60) * hourlyRateCents)
}

/**
 * Settle Akash billing through the provided timestamp before pause/refund.
 *
 * For pay-as-you-go (depositCents=0): calls computeDebit for the prorated amount
 * since last billing, creating both ledger + usage entries atomically.
 *
 * For pre-funded (depositCents>0): updates consumedCents on the escrow record
 * (wallet was already debited at escrow creation).
 *
 * Both modes update the policy totalSpentUsd for consistent enforcement.
 */
export async function settleAkashEscrowToTime(
  prisma: PrismaClient,
  akashDeploymentId: string,
  settledAt = new Date()
): Promise<number> {
  const billingApi = getBillingApiClient()
  const escrow = await prisma.deploymentEscrow.findUnique({
    where: { akashDeploymentId },
    include: {
      akashDeployment: {
        select: {
          policyId: true,
          dseq: true,
          service: {
            select: {
              slug: true,
              name: true,
              templateId: true,
              project: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      },
    },
  })

  if (!escrow) {
    return settleAkashWithoutEscrow(prisma, billingApi, akashDeploymentId, settledAt)
  }

  if (escrow.status === 'REFUNDED') {
    return 0
  }

  if (escrow.status === 'PAUSED') {
    if (escrow.akashDeployment?.policyId) {
      await prisma.deploymentPolicy.update({
        where: { id: escrow.akashDeployment.policyId },
        data: { totalSpentUsd: escrow.consumedCents / 100 },
      })
    }
    return 0
  }

  const lastChargedAt = escrow.lastBilledAt || escrow.createdAt
  const elapsedMs = Math.max(0, settledAt.getTime() - lastChargedAt.getTime())
  const additionalCents = calculateProratedAkashCents(
    escrow.dailyRateCents,
    elapsedMs
  )

  if (additionalCents <= 0) {
    return 0
  }

  const nextConsumedCents = escrow.depositCents > 0
    ? Math.min(escrow.depositCents, escrow.consumedCents + additionalCents)
    : escrow.consumedCents + additionalCents

  await prisma.deploymentEscrow.update({
    where: { id: escrow.id },
    data: {
      consumedCents: nextConsumedCents,
      lastBilledAt: settledAt,
    },
  })

  if (escrow.akashDeployment?.policyId) {
    await prisma.deploymentPolicy.update({
      where: { id: escrow.akashDeployment.policyId },
      data: { totalSpentUsd: nextConsumedCents / 100 },
    })
  }

  // Pay-as-you-go: debit wallet for the final prorated amount
  if (escrow.depositCents === 0 && additionalCents > 0) {
    try {
      await billingApi.computeDebit({
        orgBillingId: escrow.orgBillingId,
        amountCents: additionalCents,
        serviceType: 'akash_compute',
        provider: 'akash',
        resource: escrow.akashDeployment?.service?.slug || akashDeploymentId,
        description: `Akash compute final settlement: $${(additionalCents / 100).toFixed(2)}`,
        idempotencyKey: `akash_final:${akashDeploymentId}:${settledAt.toISOString()}`,
        metadata: {
          deploymentId: akashDeploymentId,
          dseq: escrow.akashDeployment?.dseq?.toString(),
          source: 'akash_final_settlement',
        },
      })
    } catch (error) {
      log.warn(
        { akashDeploymentId, err: error },
        'Failed to debit final Akash settlement'
      )
    }
  }

  log.info(
    {
      akashDeploymentId,
      additionalCents,
      nextConsumedCents,
      mode: escrow.depositCents > 0 ? 'pre-funded' : 'pay-as-you-go',
    },
    'Settled Akash billing through shutdown time'
  )

  return additionalCents
}

async function settleAkashWithoutEscrow(
  prisma: PrismaClient,
  billingApi: ReturnType<typeof getBillingApiClient>,
  akashDeploymentId: string,
  settledAt: Date
): Promise<number> {
  const deployment = await prisma.akashDeployment.findUnique({
    where: { id: akashDeploymentId },
    select: {
      id: true,
      dseq: true,
      deployedAt: true,
      createdAt: true,
      closedAt: true,
      policyId: true,
      pricePerBlock: true,
      dailyRateCentsCharged: true,
      service: {
        select: {
          slug: true,
          project: {
            select: {
              organizationId: true,
            },
          },
        },
      },
    },
  })

  const organizationId = deployment?.service?.project?.organizationId
  if (!organizationId) {
    return 0
  }

  const dailyRateCents = await resolveAkashDailyRateCentsWithoutEscrow(
    { ...deployment, service: { ...deployment.service, project: { organizationId } } },
    billingApi
  )
  if (dailyRateCents <= 0) {
    return 0
  }

  const billedFrom = deployment.deployedAt || deployment.createdAt
  const elapsedMs = Math.max(0, settledAt.getTime() - billedFrom.getTime())
  const additionalCents = calculateProratedAkashCents(dailyRateCents, elapsedMs)
  if (additionalCents <= 0) {
    return 0
  }

  try {
    const orgBilling = await billingApi.getOrgBilling(organizationId)
    const result = await billingApi.computeDebit({
      orgBillingId: orgBilling.orgBillingId,
      amountCents: additionalCents,
      serviceType: 'akash_compute',
      provider: 'akash',
      resource: deployment.service.slug || akashDeploymentId,
      description: `Akash compute final settlement (escrow-missing): $${(additionalCents / 100).toFixed(2)}`,
      idempotencyKey: `akash_final_no_escrow:${akashDeploymentId}:${settledAt.toISOString()}`,
      metadata: {
        deploymentId: akashDeploymentId,
        dseq: deployment.dseq?.toString(),
        source: 'akash_final_settlement_no_escrow',
      },
    })

    if (!result.alreadyProcessed && deployment.policyId) {
      await prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: {
          totalSpentUsd: { increment: additionalCents / 100 },
        },
      })
    }

    log.warn(
      { akashDeploymentId, additionalCents },
      'Settled Akash billing without escrow fallback'
    )

    return additionalCents
  } catch (error) {
    log.warn(
      { akashDeploymentId, err: error },
      'Failed to settle Akash billing without escrow fallback'
    )
    return 0
  }
}

async function resolveAkashDailyRateCentsWithoutEscrow(
  deployment: {
    service: { project: { organizationId: string } }
    pricePerBlock: string | null
    dailyRateCentsCharged: number | null
  },
  billingApi: ReturnType<typeof getBillingApiClient>
): Promise<number> {
  if (deployment.dailyRateCentsCharged && deployment.dailyRateCentsCharged > 0) {
    return deployment.dailyRateCentsCharged
  }

  if (!deployment.pricePerBlock) return 0

  try {
    const [orgBilling, aktPrice] = await Promise.all([
      billingApi.getOrgBilling(deployment.service.project.organizationId),
      getAktUsdPrice(),
    ])
    const orgMarkup = await billingApi.getOrgMarkup(orgBilling.orgBillingId)
    const rawDailyUsd = akashPricePerBlockToUsdPerDay(
      deployment.pricePerBlock,
      aktPrice
    )
    return Math.ceil(applyMargin(rawDailyUsd, orgMarkup.marginRate) * 100)
  } catch {
    return 0
  }
}

/**
 * Bill Phala usage through the provided timestamp with minute-level precision.
 */
export async function processFinalPhalaBilling(
  prisma: PrismaClient,
  phalaDeploymentId: string,
  billedAt = new Date(),
  idempotencyPrefix = 'phala_final'
): Promise<number> {
  const deployment = await prisma.phalaDeployment.findUnique({
    where: { id: phalaDeploymentId },
    select: {
      id: true,
      orgBillingId: true,
      hourlyRateCents: true,
      lastBilledAt: true,
      activeStartedAt: true,
      createdAt: true,
      totalBilledCents: true,
      cvmSize: true,
      policyId: true,
    },
  })

  if (!deployment?.orgBillingId || !deployment.hourlyRateCents) {
    return 0
  }

  const lastBilled =
    deployment.lastBilledAt || deployment.activeStartedAt || deployment.createdAt
  const elapsedMs = Math.max(0, billedAt.getTime() - lastBilled.getTime())
  const amountCents = calculateProratedPhalaCents(
    deployment.hourlyRateCents,
    elapsedMs
  )

  if (amountCents <= 0) {
    return 0
  }

  try {
    const billingApi = getBillingApiClient()
    const idempotencyKey = `${idempotencyPrefix}:${deployment.id}:${billedAt.toISOString()}`
    const result = await billingApi.computeDebit({
      orgBillingId: deployment.orgBillingId,
      amountCents,
      serviceType: 'phala_tee',
      provider: 'phala',
      resource: deployment.id,
      description: `Phala TEE final billing: $${(amountCents / 100).toFixed(2)}`,
      idempotencyKey,
    })

    if (result.alreadyProcessed) {
      return amountCents
    }

    const nextTotalBilledCents = deployment.totalBilledCents + amountCents

    await prisma.phalaDeployment.update({
      where: { id: deployment.id },
      data: {
        lastBilledAt: billedAt,
        totalBilledCents: nextTotalBilledCents,
      },
    })

    if (deployment.policyId) {
      await prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { totalSpentUsd: nextTotalBilledCents / 100 },
      })
    }

    log.info(
      {
        phalaDeploymentId,
        amountCents,
        nextTotalBilledCents,
      },
      'Processed final Phala billing through shutdown time'
    )

    return amountCents
  } catch (error) {
    log.warn({ phalaDeploymentId, err: error }, 'Final Phala billing failed')
    return 0
  }
}
