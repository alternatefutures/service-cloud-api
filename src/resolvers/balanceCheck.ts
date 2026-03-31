/**
 * Pre-deploy balance gate.
 *
 * Prevents deployments when the org wallet balance is below the
 * configured minimum. Runs before any on-chain work so failures
 * are cheap and user-visible.
 */

import { GraphQLError } from 'graphql'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
import { BILLING_CONFIG } from '../config/billing.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('balance-check')

export async function assertDeployBalance(
  organizationId: string | undefined,
  provider: 'akash' | 'phala'
): Promise<void> {
  if (!organizationId) return

  const minCents = BILLING_CONFIG[provider].minBalanceCentsToLaunch

  try {
    const client = getBillingApiClient()
    const orgBilling = await client.getOrgBilling(organizationId)
    const balance = await client.getOrgBalance(orgBilling.orgBillingId)

    if (balance.balanceCents < minCents) {
      throw new GraphQLError(
        `Insufficient balance to deploy. Minimum $${(minCents / 100).toFixed(2)} required, current balance is $${(balance.balanceCents / 100).toFixed(2)}.`,
        { extensions: { code: 'INSUFFICIENT_BALANCE', balanceCents: balance.balanceCents, requiredCents: minCents } }
      )
    }
  } catch (error) {
    if (error instanceof GraphQLError) throw error
    log.warn(error as Error, 'Failed to check balance — allowing deploy (fail-open)')
  }
}
