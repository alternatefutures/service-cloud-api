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

      expect(result).toBe('pm-local-123');
      expect(mockStripePaymentMethods.attach).toHaveBeenCalledWith('pm-123', {
        customer: 'stripe-cust-123',
      });
      expect(mockPrisma.paymentMethod.updateMany).toHaveBeenCalled();
      expect(mockPrisma.customer.update).toHaveBeenCalled();
    });

    it('should throw error if customer not found', async () => {
      mockPrisma.customer.findUnique.mockResolvedValue(null);

      await expect(service.addPaymentMethod('user-123', 'pm-123')).rejects.toThrow('Customer not found');
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
      mockStripeSubscriptions.create.mockResolvedValue(stripeSubscription);
      mockPrisma.subscription.create.mockResolvedValue(createdSubscription);

      const result = await service.createSubscription('user-123', 'PRO', 1);

      expect(result).toBe('sub-123');
      expect(mockStripeSubscriptions.create).toHaveBeenCalled();
      expect(mockPrisma.subscription.create).toHaveBeenCalled();
    });

    it('should throw error if no default payment method', async () => {
      const customer = {
        id: 'cust-123',
        stripeCustomerId: 'stripe-cust-123',
        defaultPaymentMethodId: null,
      };

      mockPrisma.customer.findUnique.mockResolvedValue(customer);

      await expect(service.createSubscription('user-123', 'PRO')).rejects.toThrow(
        'No default payment method set'
      );
    });
  });

  describe('updateSubscriptionSeats', () => {
    it('should update subscription seats', async () => {
      const subscription = {
        id: 'sub-123',
        stripeSubscriptionId: 'sub-stripe-123',
        seats: 1,
      };

      const stripeSubscription = {
        id: 'sub-stripe-123',
        items: {
          data: [{ id: 'si-123' }],
        },
      };

      const updatedSubscription = {
        ...subscription,
        seats: 5,
      };

      mockPrisma.subscription.findUnique.mockResolvedValue(subscription);
      mockStripeSubscriptions.retrieve.mockResolvedValue(stripeSubscription);
      mockStripeSubscriptions.update.mockResolvedValue(stripeSubscription);
      mockPrisma.subscription.update.mockResolvedValue(updatedSubscription);

      const result = await service.updateSubscriptionSeats('sub-123', 5);

      expect(result).toBe('sub-123');
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-123' },
        data: { seats: 5 },
      });
    });
  });

  describe('cancelSubscription', () => {
    it('should cancel subscription immediately', async () => {
      const subscription = {
        id: 'sub-123',
        stripeSubscriptionId: 'sub-stripe-123',
      };

      mockPrisma.subscription.findUnique.mockResolvedValue(subscription);
      mockStripeSubscriptions.cancel.mockResolvedValue({ id: 'sub-stripe-123', status: 'canceled' });
      mockPrisma.subscription.update.mockResolvedValue({ ...subscription, status: 'CANCELED' });

      const result = await service.cancelSubscription('sub-123', true);

      expect(result).toBe('sub-123');
      expect(mockStripeSubscriptions.cancel).toHaveBeenCalledWith('sub-stripe-123');
      expect(mockPrisma.subscription.update).toHaveBeenCalledWith({
        where: { id: 'sub-123' },
        data: { status: 'CANCELED' },
      });
    });

    it('should cancel subscription at period end', async () => {
      const subscription = {
        id: 'sub-123',
        stripeSubscriptionId: 'sub-stripe-123',
      };

      const updatedStripeSubscription = {
        id: 'sub-stripe-123',
        cancel_at_period_end: true,
        cancel_at: 1234567890,
      };

      mockPrisma.subscription.findUnique.mockResolvedValue(subscription);
      mockStripeSubscriptions.update.mockResolvedValue(updatedStripeSubscription);
      mockPrisma.subscription.update.mockResolvedValue({
        ...subscription,
        cancelAt: new Date(1234567890 * 1000),
      });

      const result = await service.cancelSubscription('sub-123', false);

      expect(result).toBe('sub-123');
      expect(mockStripeSubscriptions.update).toHaveBeenCalledWith('sub-stripe-123', {
        cancel_at_period_end: true,
      });
    });

    it('should throw error if subscription not found', async () => {
      mockPrisma.subscription.findUnique.mockResolvedValue(null);

      await expect(service.cancelSubscription('sub-123')).rejects.toThrow('Subscription not found');
    });
  });
});
