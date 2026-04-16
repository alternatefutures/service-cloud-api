/**
 * Pre-deploy subscription status check.
 *
 * Calls service-auth's internal API to verify the org's subscription is not
 * SUSPENDED before allowing deployments, and returns the resolved status so
 * downstream guards (e.g. tier-based concurrency caps in `launchGuards.ts`)
 * can reuse it without a second round-trip.
 */

import { GraphQLError } from 'graphql'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'
import { createLogger } from '../lib/logger.js'

const log = createLogger('subscription-check')

/**
 * Raw subscription status object returned by `service-auth`.
 * `status` is `null` when the billing API fail-opened (unreachable) — callers
 * that depend on tier-specific behavior should treat that as the most
 * restrictive tier (trial).
 */
export interface SubscriptionStatusInfo {
  status: string | null
  trialEnd: number | null
  daysRemaining: number | null
  graceRemaining: number | null
  planName: string | null
}

export async function assertSubscriptionActive(
  organizationId?: string,
): Promise<SubscriptionStatusInfo | null> {
  if (!organizationId) return null

  try {
    const client = getBillingApiClient()
    const status = await client.getSubscriptionStatus(organizationId)

    if (status.status === 'SUSPENDED') {
      throw new GraphQLError(
        'Your subscription is suspended. Please subscribe to continue deploying.',
        { extensions: { code: 'SUBSCRIPTION_SUSPENDED' } },
      )
    }

    return status
  } catch (error) {
    if (error instanceof GraphQLError) throw error
    // If the billing API is unreachable, allow the deploy (fail-open) but
    // return null so downstream tier-aware guards fall back to the most
    // restrictive tier.
    log.warn(error as Error, 'failed to check subscription status — allowing deploy (fail-open)')
    return null
  }
}
