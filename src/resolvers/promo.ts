import { GraphQLError } from 'graphql'
import type { Context } from './types.js'
import { PromoService } from '../services/billing/promoService.js'

export const promoQueries = {
  /**
   * Public — validate a promo code without redeeming it.
   * Returns null if the code doesn't exist.
   */
  validatePromoCode: async (
    _: unknown,
    { code }: { code: string },
    context: Context
  ) => {
    const service = new PromoService(context.prisma)
    return service.validateCode(code)
  },
}

export const promoMutations = {
  /**
   * Authenticated — redeem a promo code against the caller's subscription.
   */
  redeemPromoCode: async (
    _: unknown,
    { code }: { code: string },
    context: Context
  ) => {
    if (!context.userId) {
      throw new GraphQLError('Not authenticated', {
        extensions: { code: 'UNAUTHENTICATED' },
      })
    }

    const service = new PromoService(context.prisma)
    return service.redeemCode(code, context.userId)
  },
}
