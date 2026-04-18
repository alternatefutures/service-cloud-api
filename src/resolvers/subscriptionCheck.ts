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

    // Block all states where the org has no current entitlement to deploy.
    // service-auth returns one of: ACTIVE, TRIALING, TRIAL_EXPIRED, SUSPENDED,
    // PAST_DUE, CANCELED. Any state other than ACTIVE/TRIALING (and
    // TRIAL_EXPIRED while still inside the 3-day grace window) means we
    // should not start new deployments — otherwise we keep accruing infra
    // cost against an org that cannot legally be billed.
    switch (status.status) {
      case 'SUSPENDED':
        throw new GraphQLError(
          'Your subscription is suspended. Please contact support to continue deploying.',
          { extensions: { code: 'SUBSCRIPTION_SUSPENDED' } },
        )
      case 'PAST_DUE':
        throw new GraphQLError(
          'Your last payment failed. Please update your payment method to continue deploying.',
          { extensions: { code: 'SUBSCRIPTION_PAST_DUE' } },
        )
      case 'CANCELED':
        throw new GraphQLError(
          'Your subscription has been canceled. Please re-subscribe to continue deploying.',
          { extensions: { code: 'SUBSCRIPTION_CANCELED' } },
        )
      case 'TRIAL_EXPIRED':
        if ((status.graceRemaining ?? 0) <= 0) {
          throw new GraphQLError(
            'Your trial has expired. Please subscribe to continue deploying.',
            { extensions: { code: 'TRIAL_EXPIRED' } },
          )
        }
        break
      // ACTIVE, TRIALING, TRIAL_EXPIRED-within-grace fall through.
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
