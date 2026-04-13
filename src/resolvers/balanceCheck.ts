/**
 * Pre-deploy balance gate.
 *
 * Prevents deployments when the org wallet cannot sustain at least 1 day
 * of the new deployment PLUS its existing active deployments.
 *
 * Three enforcement tiers:
 *   1. balance >= existingDailyBurn + projectedDailyCost  (accounts for all active compute)
 *   2. Fail-closed for expensive deploys (GPU tier) when billing service is unavailable
 *   3. Fail-open only for cheap CPU deploys (< $5/day) where exposure is negligible
 */

import { GraphQLError } from 'graphql'
import type { PrismaClient } from '@prisma/client'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
import { BILLING_CONFIG } from '../config/billing.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('balance-check')

interface DeployCostEstimate {
  dailyCostCents: number
}

/**
 * Total HOURLY burn in cents for ALL active services in the org.
 * Sums Akash escrows (daily rate / 24) + Phala deployments (hourly rate).
 */
export async function getOrgHourlyBurnCents(
  prisma: PrismaClient,
  orgBillingId: string
): Promise<number> {
  const [akashEscrows, phalaDeployments] = await Promise.all([
    prisma.deploymentEscrow.findMany({
      where: { orgBillingId, status: 'ACTIVE' },
      select: { dailyRateCents: true },
    }),
    prisma.phalaDeployment.findMany({
      where: { orgBillingId, status: 'ACTIVE', hourlyRateCents: { not: null } },
      select: { hourlyRateCents: true },
    }),
  ])

  let totalCents = 0
  for (const e of akashEscrows) totalCents += e.dailyRateCents / 24
  for (const p of phalaDeployments) totalCents += (p.hourlyRateCents ?? 0)
  return totalCents
}

/** @deprecated Use getOrgHourlyBurnCents instead. Kept for backward compat. */
export async function getExistingDailyBurn(
  prisma: PrismaClient,
  orgBillingId: string
): Promise<number> {
  return (await getOrgHourlyBurnCents(prisma, orgBillingId)) * 24
}

export async function assertDeployBalance(
  organizationId: string | undefined,
  provider: 'akash' | 'phala',
  prisma?: PrismaClient,
  estimate?: DeployCostEstimate
): Promise<void> {
  if (!organizationId) return

  const projectedDailyCost = estimate?.dailyCostCents ?? 0
  const isExpensive = projectedDailyCost > BILLING_CONFIG.thresholds.failClosedAboveCentsPerDay

  try {
    const client = getBillingApiClient()
    const orgBilling = await client.getOrgBilling(organizationId)
    const balance = await client.getOrgBalance(orgBilling.orgBillingId)

    let existingBurn = 0
    if (prisma) {
      existingBurn = await getExistingDailyBurn(prisma, orgBilling.orgBillingId)
    }

    const requiredCents = Math.max(
      BILLING_CONFIG[provider].minBalanceCentsToLaunch,
      existingBurn + projectedDailyCost
    )

    if (balance.balanceCents < requiredCents) {
      const balanceStr = `$${(balance.balanceCents / 100).toFixed(2)}`
      const requiredStr = `$${(requiredCents / 100).toFixed(2)}`
      const burnStr = existingBurn > 0 ? ` (existing daily burn: $${(existingBurn / 100).toFixed(2)})` : ''

      throw new GraphQLError(
        `Insufficient balance to deploy. Need ${requiredStr} for 1 day of compute${burnStr}, current balance is ${balanceStr}.`,
        {
          extensions: {
            code: 'INSUFFICIENT_BALANCE',
            balanceCents: balance.balanceCents,
            requiredCents,
            existingDailyBurnCents: existingBurn,
            projectedDailyCostCents: projectedDailyCost,
          },
        }
      )
    }
  } catch (error) {
    if (error instanceof GraphQLError) throw error

    if (isExpensive) {
      log.error(error as Error, 'Billing service unavailable — blocking expensive deploy (fail-closed)')
      throw new GraphQLError(
        'Billing service temporarily unavailable. Please try again in a few minutes.',
        { extensions: { code: 'BILLING_UNAVAILABLE' } }
      )
    }

    log.warn(error as Error, 'Failed to check balance — allowing cheap deploy (fail-open)')
  }
}
