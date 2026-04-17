import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PromoService } from './promoService.js'

// ─── Stripe mock ─────────────────────────────────────────────────────────────

const {
  mockStripeSubscriptions,
  mockStripeCoupons,
  MockStripe,
} = vi.hoisted(() => {
  const mockStripeSubscriptions = {
    update: vi.fn().mockResolvedValue({}),
  }
  const mockStripeCoupons = {
    retrieve: vi.fn(),
    create: vi.fn().mockResolvedValue({}),
  }
  class MockStripe {
    subscriptions = mockStripeSubscriptions
    coupons = mockStripeCoupons
    constructor(_apiKey: string, _opts: any) {}
  }
  return { mockStripeSubscriptions, mockStripeCoupons, MockStripe }
})

vi.mock('stripe', () => ({ default: MockStripe }))

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePromoCode(overrides: Partial<ReturnType<typeof makePromoCode>> = {}) {
  return {
    id: 'promo-1',
    code: 'PRODUCTHUNT',
    description: '6 months free Pro',
    discountType: 'FREE_MONTHS' as const,
    discountValue: 6,
    appliesToPlan: 'PRO',
    maxRedemptions: 500,
    redemptionCount: 0,
    expiresAt: new Date('2099-01-01'),
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeMockPrisma(promoCode = makePromoCode()): any {
  return {
    promoCode: {
      findUnique: vi.fn().mockResolvedValue(promoCode),
      update: vi.fn().mockResolvedValue({ ...promoCode, redemptionCount: promoCode.redemptionCount + 1 }),
    },
    promoCodeRedemption: {
      findUnique: vi.fn().mockResolvedValue(null), // no prior redemption by default
      create: vi.fn().mockResolvedValue({ id: 'redemption-1' }),
      update: vi.fn().mockResolvedValue({}),
    },
    customer: {
      findUnique: vi.fn().mockResolvedValue(null), // no Stripe customer by default
    },
    subscription: {
      update: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(makeMockPrisma(promoCode))),
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PromoService.validateCode', () => {
  it('returns validated code with isValid=true for an active, in-cap code', async () => {
    const mockPrisma = makeMockPrisma()
    const service = new PromoService(mockPrisma)

    const result = await service.validateCode('PRODUCTHUNT')

    expect(result).not.toBeNull()
    expect(result?.isValid).toBe(true)
    expect(result?.code).toBe('PRODUCTHUNT')
    expect(result?.discountType).toBe('FREE_MONTHS')
    expect(result?.discountValue).toBe(6)
  })

  it('returns isValid=false for an expired code', async () => {
    const expired = makePromoCode({ expiresAt: new Date('2020-01-01') })
    const mockPrisma = makeMockPrisma(expired)
    const service = new PromoService(mockPrisma)

    const result = await service.validateCode('PRODUCTHUNT')
    expect(result?.isValid).toBe(false)
  })

  it('returns isValid=false for an inactive code', async () => {
    const inactive = makePromoCode({ isActive: false })
    const mockPrisma = makeMockPrisma(inactive)
    const service = new PromoService(mockPrisma)

    const result = await service.validateCode('PRODUCTHUNT')
    expect(result?.isValid).toBe(false)
  })

  it('returns isValid=false when redemption cap is reached', async () => {
    const capped = makePromoCode({ maxRedemptions: 500, redemptionCount: 500 })
    const mockPrisma = makeMockPrisma(capped)
    const service = new PromoService(mockPrisma)

    const result = await service.validateCode('PRODUCTHUNT')
    expect(result?.isValid).toBe(false)
  })

  it('returns null when code does not exist', async () => {
    const mockPrisma = makeMockPrisma()
    mockPrisma.promoCode.findUnique.mockResolvedValue(null)
    const service = new PromoService(mockPrisma)

    const result = await service.validateCode('NONEXISTENT')
    expect(result).toBeNull()
  })
})

describe('PromoService.redeemCode', () => {
  it('successfully redeems a valid code and increments redemptionCount', async () => {
    const mockPrisma = makeMockPrisma()
    // $transaction calls the fn with a fresh mock of itself
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const txPrisma = makeMockPrisma()
      return fn(txPrisma)
    })
    const service = new PromoService(mockPrisma)

    const result = await service.redeemCode('PRODUCTHUNT', 'user-1')

    expect(result.success).toBe(true)
    expect(result.error).toBeNull()
    expect(result.promoCode?.code).toBe('PRODUCTHUNT')
  })

  it('rejects expired code', async () => {
    const expired = makePromoCode({ expiresAt: new Date('2020-01-01') })
    const mockPrisma = makeMockPrisma(expired)
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn(makeMockPrisma(expired))
    })
    const service = new PromoService(mockPrisma)

    const result = await service.redeemCode('PRODUCTHUNT', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/expired/)
  })

  it('rejects inactive code', async () => {
    const inactive = makePromoCode({ isActive: false })
    const mockPrisma = makeMockPrisma(inactive)
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn(makeMockPrisma(inactive))
    })
    const service = new PromoService(mockPrisma)

    const result = await service.redeemCode('PRODUCTHUNT', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/no longer active/)
  })

  it('rejects when redemption cap is reached (501st attempt)', async () => {
    const capped = makePromoCode({ maxRedemptions: 500, redemptionCount: 500 })
    const mockPrisma = makeMockPrisma(capped)
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn(makeMockPrisma(capped))
    })
    const service = new PromoService(mockPrisma)

    const result = await service.redeemCode('PRODUCTHUNT', 'user-501')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/redemption limit/)
  })

  it('rejects double redemption by the same user', async () => {
    const code = makePromoCode()
    const existingRedemption = { id: 'redemption-old', promoCodeId: code.id, userId: 'user-1' }

    const mockPrisma = makeMockPrisma(code)
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const txPrisma = makeMockPrisma(code)
      txPrisma.promoCodeRedemption.findUnique.mockResolvedValue(existingRedemption)
      return fn(txPrisma)
    })
    const service = new PromoService(mockPrisma)

    const result = await service.redeemCode('PRODUCTHUNT', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/already redeemed/)
  })

  it('returns error when code does not exist', async () => {
    const mockPrisma = makeMockPrisma()
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const txPrisma = makeMockPrisma()
      txPrisma.promoCode.findUnique.mockResolvedValue(null)
      return fn(txPrisma)
    })
    const service = new PromoService(mockPrisma)

    const result = await service.redeemCode('BOGUS', 'user-1')

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('extends Stripe trial_end by discountValue months for FREE_MONTHS codes', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_fake'

    const code = makePromoCode({ discountType: 'FREE_MONTHS', discountValue: 6 })
    const mockPrisma = makeMockPrisma(code)

    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      return fn(makeMockPrisma(code))
    })

    // Customer with active Stripe subscription
    mockPrisma.customer.findUnique.mockResolvedValue({
      id: 'cust-1',
      stripeCustomerId: 'cus_test',
      subscriptions: [
        {
          id: 'sub-db-1',
          stripeSubscriptionId: 'sub_test',
          status: 'ACTIVE',
          trialEnd: null,
        },
      ],
    })

    // Redemption lookup after transaction
    mockPrisma.promoCodeRedemption.findUnique.mockResolvedValue({ id: 'redemption-1' })
    mockStripeSubscriptions.update.mockResolvedValue({})

    const service = new PromoService(mockPrisma)
    const result = await service.redeemCode('PRODUCTHUNT', 'user-1')

    expect(result.success).toBe(true)
    expect(mockStripeSubscriptions.update).toHaveBeenCalledWith(
      'sub_test',
      expect.objectContaining({ trial_end: expect.any(Number) })
    )

    delete process.env.STRIPE_SECRET_KEY
  })
})
