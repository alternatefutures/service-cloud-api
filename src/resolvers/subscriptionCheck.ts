/**
 * Pre-deploy subscription status check.
 *
 * Calls service-auth's internal API to verify the org's subscription
 * is not SUSPENDED before allowing deployments.
 */

import { GraphQLError } from 'graphql'
import { getBillingApiClient } from '../services/billing/billingApiClient.js'

export async function assertSubscriptionActive(organizationId?: string): Promise<void> {
  if (!organizationId) return

  try {
    const client = getBillingApiClient()
    const status = await client.getSubscriptionStatus(organizationId)

    if (status.status === 'SUSPENDED') {
      throw new GraphQLError(
        'Your subscription is suspended. Please subscribe to continue deploying.',
        { extensions: { code: 'SUBSCRIPTION_SUSPENDED' } }
      )
    }
  } catch (error) {
    if (error instanceof GraphQLError) throw error
    // If the billing API is unreachable, allow the deploy (fail-open)
    console.warn('[subscriptionCheck] Failed to check subscription status:', error)
  }
}
