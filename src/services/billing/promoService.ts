/**
 * Promo Code Service
 *
 * Handles validation and redemption of promotional codes.
 * Supports FREE_MONTHS, PERCENT_OFF, and AMOUNT_OFF discount types.
 * Integrates with Stripe for applying discounts to subscriptions.
 */

import Stripe from 'stripe'
import type { PrismaClient } from '@prisma/client'

// Lazy Stripe client (same pattern as stripeService.ts)
let stripe: Stripe | null = null

function getStripeClient(): Stripe | null {
  if (!stripe) {
    const apiKey = process.env.STRIPE_SECRET_KEY
    if (!apiKey) return null
    stripe = new Stripe(apiKey, { apiVersion: '2025-10-29.clover' })
  }
  return stripe
}

export interface ValidatedPromoCode {
  id: string
  code: string
  description: string | null
  discountType: 'FREE_MONTHS' | 'PERCENT_OFF' | 'AMOUNT_OFF'
  discountValue: number
  appliesToPlan: string | null
  expiresAt: Date | null
  isValid: boolean
}

export interface RedemptionResult {
  success: boolean
  promoCode: ValidatedPromoCode | null
  subscriptionId: string | null
  error: string | null
}

export class PromoService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Compute isValid for a PromoCode record.
   * Valid = active + not expired + under redemption cap.
   */
  private computeIsValid(code: {
    isActive: boolean
    expiresAt: Date | null
    maxRedemptions: number | null
    redemptionCount: number
  }): boolean {
    if (!code.isActive) return false
    if (code.expiresAt && code.expiresAt < new Date()) return false
    if (code.maxRedemptions !== null && code.redemptionCount >= code.maxRedemptions) return false
    return true
  }

  /**
   * Public validation — looks up the code without redeeming it.
   * Returns null if the code doesn't exist at all.
   */
  async validateCode(code: string): Promise<ValidatedPromoCode | null> {
    const promoCode = await this.prisma.promoCode.findUnique({
      where: { code: code.toUpperCase().trim() },
    })

    if (!promoCode) return null

    return {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      discountType: promoCode.discountType as ValidatedPromoCode['discountType'],
      discountValue: promoCode.discountValue,
      appliesToPlan: promoCode.appliesToPlan,
      expiresAt: promoCode.expiresAt,
      isValid: this.computeIsValid(promoCode),
    }
  }

  /**
   * Authenticated redemption — atomically validates + redeems + applies discount.
   * Must be called with an authenticated userId.
   */
  async redeemCode(code: string, userId: string): Promise<RedemptionResult> {
    const normalizedCode = code.toUpperCase().trim()

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        // Lock the promo code row for the duration of this transaction
        const promoCode = await tx.promoCode.findUnique({
          where: { code: normalizedCode },
        })

        if (!promoCode) {
          return { error: 'Promo code not found', promoCode: null, subscriptionId: null }
        }

        // Re-check validity inside the transaction (cap enforcement)
        if (!promoCode.isActive) {
          return { error: 'This promo code is no longer active', promoCode, subscriptionId: null }
        }
        if (promoCode.expiresAt && promoCode.expiresAt < new Date()) {
          return { error: 'This promo code has expired', promoCode, subscriptionId: null }
        }
        if (promoCode.maxRedemptions !== null && promoCode.redemptionCount >= promoCode.maxRedemptions) {
          return { error: 'This promo code has reached its redemption limit', promoCode, subscriptionId: null }
        }

        // Check for duplicate redemption (unique constraint guard)
        const existing = await tx.promoCodeRedemption.findUnique({
          where: { promoCodeId_userId: { promoCodeId: promoCode.id, userId } },
        })
        if (existing) {
          return { error: 'You have already redeemed this promo code', promoCode, subscriptionId: null }
        }

        // Atomically increment count + create redemption record
        const [updatedCode, redemption] = await Promise.all([
          tx.promoCode.update({
            where: { id: promoCode.id },
            data: { redemptionCount: { increment: 1 } },
          }),
          tx.promoCodeRedemption.create({
            data: { promoCodeId: promoCode.id, userId },
          }),
        ])

        return { error: null, promoCode: updatedCode, redemption, subscriptionId: null }
      })

      if (result.error || !result.promoCode) {
        const validated = result.promoCode
          ? {
              id: result.promoCode.id,
              code: result.promoCode.code,
              description: result.promoCode.description,
              discountType: result.promoCode.discountType as ValidatedPromoCode['discountType'],
              discountValue: result.promoCode.discountValue,
              appliesToPlan: result.promoCode.appliesToPlan,
              expiresAt: result.promoCode.expiresAt,
              isValid: false,
            }
          : null
        return { success: false, promoCode: validated, subscriptionId: null, error: result.error }
      }

      // Apply discount to Stripe subscription (best-effort; redemption already recorded)
      let stripeSubscriptionId: string | null = null
      try {
        stripeSubscriptionId = await this.applyToStripe(result.promoCode, userId)
        // Persist the subscriptionId on the redemption record if we got one
        if (stripeSubscriptionId) {
          const redemption = await this.prisma.promoCodeRedemption.findUnique({
            where: { promoCodeId_userId: { promoCodeId: result.promoCode.id, userId } },
          })
          if (redemption) {
            await this.prisma.promoCodeRedemption.update({
              where: { id: redemption.id },
              data: { subscriptionId: stripeSubscriptionId },
            })
          }
        }
      } catch (stripeErr) {
        // Log but don't fail — redemption is already recorded
        console.error('[PromoService] Stripe apply failed (redemption still recorded):', stripeErr)
      }

      const validated: ValidatedPromoCode = {
        id: result.promoCode.id,
        code: result.promoCode.code,
        description: result.promoCode.description,
        discountType: result.promoCode.discountType as ValidatedPromoCode['discountType'],
        discountValue: result.promoCode.discountValue,
        appliesToPlan: result.promoCode.appliesToPlan,
        expiresAt: result.promoCode.expiresAt,
        isValid: this.computeIsValid(result.promoCode),
      }

      return { success: true, promoCode: validated, subscriptionId: stripeSubscriptionId, error: null }
    } catch (err: any) {
      // Unique constraint violation = race condition — another request redeemed simultaneously
      if (err?.code === 'P2002') {
        return { success: false, promoCode: null, subscriptionId: null, error: 'You have already redeemed this promo code' }
      }
      console.error('[PromoService] redeemCode error:', err)
      return { success: false, promoCode: null, subscriptionId: null, error: 'An unexpected error occurred' }
    }
  }

  /**
   * Apply the promo code discount to the user's Stripe subscription.
   * Returns the Stripe subscription ID that was updated, or null if no subscription found.
   *
   * FREE_MONTHS: extends trial_end by N months on the existing subscription.
   * PERCENT_OFF / AMOUNT_OFF: lazy-creates a Stripe coupon and applies it.
   */
  private async applyToStripe(
    promoCode: { id: string; discountType: string; discountValue: number; appliesToPlan: string | null },
    userId: string
  ): Promise<string | null> {
    const stripeClient = getStripeClient()
    if (!stripeClient) return null

    // Look up the user's customer + active subscription
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
      include: {
        subscriptions: {
          where: { status: { in: ['ACTIVE', 'TRIALING'] } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    })

    if (!customer?.stripeCustomerId) return null

    const subscription = customer.subscriptions[0]
    if (!subscription?.stripeSubscriptionId) return null

    if (promoCode.discountType === 'FREE_MONTHS') {
      // Extend trial_end by discountValue months from now (or from current trial_end if already trialing)
      const baseDate = subscription.trialEnd && subscription.trialEnd > new Date()
        ? subscription.trialEnd
        : new Date()

      const trialEnd = new Date(baseDate)
      trialEnd.setMonth(trialEnd.getMonth() + promoCode.discountValue)

      await stripeClient.subscriptions.update(subscription.stripeSubscriptionId, {
        trial_end: Math.floor(trialEnd.getTime() / 1000),
      } as any)

      // Mirror trialEnd in our DB
      await this.prisma.subscription.update({
        where: { id: subscription.id },
        data: { trialEnd, status: 'TRIALING' },
      })
    } else {
      // PERCENT_OFF or AMOUNT_OFF — lazy-create Stripe coupon
      const couponId = `af-promo-${promoCode.id}`

      try {
        await stripeClient.coupons.retrieve(couponId)
      } catch {
        // Coupon doesn't exist yet — create it
        const couponParams: Stripe.CouponCreateParams =
          promoCode.discountType === 'PERCENT_OFF'
            ? { id: couponId, percent_off: promoCode.discountValue, duration: 'once' }
            : { id: couponId, amount_off: promoCode.discountValue, currency: 'usd', duration: 'once' }

        await stripeClient.coupons.create(couponParams)
      }

      await stripeClient.subscriptions.update(subscription.stripeSubscriptionId, {
        discounts: [{ coupon: couponId }],
      } as any)
    }

    return subscription.stripeSubscriptionId
  }
}
