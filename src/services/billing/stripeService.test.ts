import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StripeService } from './stripeService.js';
import type { PrismaClient } from '@prisma/client';

// Create mock Stripe methods
const { mockStripeCustomers, mockStripePaymentMethods, mockStripeSubscriptions, MockStripe } = vi.hoisted(() => {
  const mockStripeCustomers = {
    create: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
  };

  const mockStripePaymentMethods = {
    attach: vi.fn(),
    detach: vi.fn(),
    retrieve: vi.fn(),
  };

  const mockStripeSubscriptions = {
    create: vi.fn(),
    update: vi.fn(),
    cancel: vi.fn(),
    retrieve: vi.fn(),
  };

  class MockStripe {
    customers = mockStripeCustomers;
    paymentMethods = mockStripePaymentMethods;
    subscriptions = mockStripeSubscriptions;
    webhooks = {
      constructEvent: vi.fn(),
    };

    constructor(apiKey: string, options: any) {}
  }

  return { mockStripeCustomers, mockStripePaymentMethods, mockStripeSubscriptions, MockStripe };
});

// Mock the Stripe module
vi.mock('stripe', () => ({
  default: MockStripe,
}));

describe('StripeService', () => {
  let service: StripeService;
  let mockPrisma: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up environment variables
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';

    // Create mock Prisma client
    mockPrisma = {
      customer: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      paymentMethod: {
        create: vi.fn(),
        findUnique: vi.fn(),
        findMany: vi.fn(),
        delete: vi.fn(),
        updateMany: vi.fn(),
        update: vi.fn(),
      },
      subscription: {
        create: vi.fn(),
        update: vi.fn(),
        findUnique: vi.fn(),
      },
      invoice: {
        update: vi.fn(),
      },
      payment: {
        create: vi.fn(),
      },
      billingSettings: {
        findFirst: vi.fn(),
      },
    } as any;

    service = new StripeService(mockPrisma as PrismaClient);
  });

  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  describe('getOrCreateCustomer', () => {
    it('should return existing customer if found', async () => {
      const existingCustomer = {
        id: 'cust-123',
        userId: 'user-123',
        stripeCustomerId: 'stripe-cust-123',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(existingCustomer);

      const result = await service.getOrCreateCustomer('user-123');

      expect(result).toEqual({
        customerId: 'cust-123',
        stripeCustomerId: 'stripe-cust-123',
      });
      expect(mockPrisma.customer.findUnique).toHaveBeenCalledWith({
        where: { userId: 'user-123' },
      });
    });

    it('should create new customer if not found', async () => {
      const user = {
        id: 'user-123',
        email: 'test@example.com',
        username: 'testuser',
      };

      const stripeCustomer = {
        id: 'stripe-cust-456',
      };

      const newCustomer = {
        id: 'cust-456',
        userId: 'user-123',
        stripeCustomerId: 'stripe-cust-456',
        email: 'test@example.com',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(user);
      mockStripeCustomers.create.mockResolvedValue(stripeCustomer);
      mockPrisma.customer.create.mockResolvedValue(newCustomer);

      const result = await service.getOrCreateCustomer('user-123');

      expect(result).toEqual({
        customerId: 'cust-456',
        stripeCustomerId: 'stripe-cust-456',
      });
      expect(mockStripeCustomers.create).toHaveBeenCalledWith({
        email: 'test@example.com',
        name: 'testuser',
        metadata: { userId: 'user-123' },
      });
      expect(mockPrisma.customer.create).toHaveBeenCalled();
    });

    it('should throw error if user not found', async () => {
      mockPrisma.customer.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.getOrCreateCustomer('user-123')).rejects.toThrow('User not found');
    });
  });

  describe('addPaymentMethod', () => {
    it('should add payment method and set as default when requested', async () => {
      const customer = {
        id: 'cust-123',
        stripeCustomerId: 'stripe-cust-123',
      };

      const stripePaymentMethod = {
        id: 'pm-123',
        type: 'card',
        card: {
          brand: 'visa',
          last4: '4242',
          exp_month: 12,
          exp_year: 2025,
        },
      };

      const createdPaymentMethod = {
        id: 'pm-local-123',
        customerId: 'cust-123',
        stripePaymentMethodId: 'pm-123',
        type: 'CARD',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockStripePaymentMethods.attach.mockResolvedValue(stripePaymentMethod);
      mockStripePaymentMethods.retrieve.mockResolvedValue(stripePaymentMethod);
      mockPrisma.paymentMethod.create.mockResolvedValue(createdPaymentMethod);
      mockPrisma.paymentMethod.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.customer.update.mockResolvedValue({ ...customer, defaultPaymentMethodId: 'pm-local-123' });

      const result = await service.addPaymentMethod('user-123', 'pm-123', true);

      expect(result).toEqual({
        id: 'pm-local-123',
        last4: '',
        brand: '',
      });
      expect(mockStripePaymentMethods.attach).toHaveBeenCalledWith('pm-123', {
        customer: 'stripe-cust-123',
      });
      expect(mockPrisma.paymentMethod.updateMany).toHaveBeenCalled();
      expect(mockPrisma.customer.update).toHaveBeenCalled();
    });

    it('should throw error if user not found', async () => {
      mockPrisma.customer.findUnique.mockResolvedValue(null);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(service.addPaymentMethod('user-123', 'pm-123')).rejects.toThrow('User not found');
    });
  });

  describe('createSubscription', () => {
    it('should create subscription with default values', async () => {
      const customer = {
        id: 'cust-123',
        stripeCustomerId: 'stripe-cust-123',
        defaultPaymentMethodId: 'pm-123',
      };

      const stripeSubscription = {
        id: 'sub-stripe-123',
        status: 'active',
        current_period_start: 1234567890,
        current_period_end: 1234567890,
      };

      const createdSubscription = {
        id: 'sub-123',
        customerId: 'cust-123',
        plan: 'PRO',
        status: 'ACTIVE',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.billingSettings.findFirst.mockResolvedValue({
        pricePerSeatCents: 1000,
        usageMarkupPercent: 20,
      });
      mockStripeSubscriptions.create.mockResolvedValue(stripeSubscription);
      mockPrisma.subscription.create.mockResolvedValue(createdSubscription);

      const result = await service.createSubscription('user-123', 'PRO', 1);

      expect(result).toBe('sub-123');
      expect(mockStripeSubscriptions.create).toHaveBeenCalled();
      expect(mockPrisma.subscription.create).toHaveBeenCalled();
    });
  });

  describe('cancelSubscription', () => {
    it('should cancel subscription immediately', async () => {
      const customer = {
        id: 'cust-123',
        userId: 'user-123',
        stripeCustomerId: 'stripe-cust-123',
      };

      const subscription = {
        id: 'sub-123',
        customerId: 'cust-123',
        stripeSubscriptionId: 'sub-stripe-123',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findUnique.mockResolvedValue(subscription);
      mockStripeSubscriptions.cancel.mockResolvedValue({ id: 'sub-stripe-123', status: 'canceled' });
      mockPrisma.subscription.update.mockResolvedValue({ ...subscription, status: 'CANCELED' });

      await service.cancelSubscription('user-123', 'sub-123', true);

      expect(mockStripeSubscriptions.cancel).toHaveBeenCalledWith('sub-stripe-123');
      expect(mockPrisma.subscription.update).toHaveBeenCalled();
    });

    it('should cancel subscription at period end', async () => {
      const customer = {
        id: 'cust-123',
        userId: 'user-123',
        stripeCustomerId: 'stripe-cust-123',
      };

      const subscription = {
        id: 'sub-123',
        customerId: 'cust-123',
        stripeSubscriptionId: 'sub-stripe-123',
        currentPeriodEnd: new Date('2025-12-31'),
      };

      const updatedStripeSubscription = {
        id: 'sub-stripe-123',
        cancel_at_period_end: true,
        cancel_at: 1234567890,
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findUnique.mockResolvedValue(subscription);
      mockStripeSubscriptions.update.mockResolvedValue(updatedStripeSubscription);
      mockPrisma.subscription.update.mockResolvedValue({
        ...subscription,
        cancelAt: new Date(1234567890 * 1000),
      });

      await service.cancelSubscription('user-123', 'sub-123', false);

      expect(mockStripeSubscriptions.update).toHaveBeenCalledWith('sub-stripe-123', {
        cancel_at_period_end: true,
      });
    });

    it('should throw error if subscription not found', async () => {
      const customer = {
        id: 'cust-123',
        userId: 'user-123',
        stripeCustomerId: 'stripe-cust-123',
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.cancelSubscription('user-123', 'sub-123')).rejects.toThrow('Subscription not found');
    });
  });
});
