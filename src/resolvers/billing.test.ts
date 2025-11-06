import { describe, it, expect, vi, beforeEach } from 'vitest';
import { billingResolvers } from './billing.js';
import type { Context } from './index.js';

// Mock the billing services
vi.mock('../services/billing/index.js', () => ({
  stripeService: vi.fn(() => ({
    getOrCreateCustomer: vi.fn(),
    addPaymentMethod: vi.fn(),
    removePaymentMethod: vi.fn(),
    setDefaultPaymentMethod: vi.fn(),
    createSubscription: vi.fn(),
    cancelSubscription: vi.fn(),
    updateSubscriptionSeats: vi.fn(),
    processPayment: vi.fn(),
  })),
  cryptoService: vi.fn(() => ({
    addCryptoWallet: vi.fn(),
    recordCryptoPayment: vi.fn(),
  })),
  usageService: vi.fn(() => ({
    getCurrentUsage: vi.fn(),
    getUsageForPeriod: vi.fn(),
  })),
  invoiceService: vi.fn(() => ({
    generateInvoice: vi.fn(),
  })),
  StorageTracker: vi.fn(() => ({
    getActivePins: vi.fn(),
    getSnapshots: vi.fn(),
    getCurrentStorage: vi.fn(),
    getPinCount: vi.fn(),
    createDailySnapshot: vi.fn(),
  })),
  StorageSnapshotScheduler: vi.fn(() => ({
    runNow: vi.fn(),
  })),
  InvoiceScheduler: vi.fn(() => ({
    runNow: vi.fn(),
  })),
}));

describe('Billing Resolvers', () => {
  let mockContext: Context;

  beforeEach(() => {
    vi.clearAllMocks();

    mockContext = {
      prisma: {
        customer: {
          findUnique: vi.fn(),
        },
        paymentMethod: {
          findMany: vi.fn(),
          findUnique: vi.fn(),
          delete: vi.fn(),
          update: vi.fn(),
          updateMany: vi.fn(),
        },
        subscription: {
          findMany: vi.fn(),
          findFirst: vi.fn(),
          findUnique: vi.fn(),
          update: vi.fn(),
        },
        invoice: {
          findMany: vi.fn(),
          findUnique: vi.fn(),
        },
        billingSettings: {
          findFirst: vi.fn(),
          upsert: vi.fn(),
        },
      } as any,
      userId: 'user-123',
    } as any;
  });

  describe('Query Resolvers', () => {
    describe('customer', () => {
      it('should return customer for authenticated user', async () => {
        const customer = {
          id: 'cust-123',
          userId: 'user-123',
          email: 'test@example.com',
          name: 'Test User',
        };

        vi.mocked(mockContext.prisma.customer.findUnique).mockResolvedValue(customer);

        const result = await billingResolvers.Query.customer({}, {}, mockContext);

        expect(result).toEqual(customer);
        expect(mockContext.prisma.customer.findUnique).toHaveBeenCalledWith({
          where: { userId: 'user-123' },
          include: expect.any(Object),
        });
      });

      it('should throw error if not authenticated', async () => {
        mockContext.userId = undefined;

        await expect(billingResolvers.Query.customer({}, {}, mockContext)).rejects.toThrow(
          'Authentication required'
        );
      });
    });

    describe('paymentMethods', () => {
      it('should return payment methods for user', async () => {
        const customer = { id: 'cust-123', userId: 'user-123' };
        const paymentMethods = [
          {
            id: 'pm-1',
            type: 'CARD',
            cardBrand: 'visa',
            cardLast4: '4242',
            isDefault: true,
          },
          {
            id: 'pm-2',
            type: 'CRYPTO_WALLET',
            blockchain: 'ethereum',
            walletAddress: '0xabcd',
            isDefault: false,
          },
        ];

        vi.mocked(mockContext.prisma.customer.findUnique).mockResolvedValue(customer);
        vi.mocked(mockContext.prisma.paymentMethod.findMany).mockResolvedValue(paymentMethods);

        const result = await billingResolvers.Query.paymentMethods({}, {}, mockContext);

        expect(result).toEqual(paymentMethods);
      });

      it('should return empty array if customer not found', async () => {
        vi.mocked(mockContext.prisma.customer.findUnique).mockResolvedValue(null);

        const result = await billingResolvers.Query.paymentMethods({}, {}, mockContext);

        expect(result).toEqual([]);
      });
    });

    describe('subscriptions', () => {
      it('should return all subscriptions for user', async () => {
        const customer = { id: 'cust-123', userId: 'user-123' };
        const subscriptions = [
          {
            id: 'sub-1',
            plan: 'PRO',
            status: 'ACTIVE',
            seats: 2,
          },
        ];

        vi.mocked(mockContext.prisma.customer.findUnique).mockResolvedValue(customer);
        vi.mocked(mockContext.prisma.subscription.findMany).mockResolvedValue(subscriptions);

        const result = await billingResolvers.Query.subscriptions({}, {}, mockContext);

        expect(result).toEqual(subscriptions);
      });
    });

    describe('invoices', () => {
      it('should return invoices with optional status filter', async () => {
        const customer = { id: 'cust-123', userId: 'user-123' };
        const invoices = [
          {
            id: 'inv-1',
            invoiceNumber: 'INV-001',
            status: 'PAID',
            total: 5000,
          },
          {
            id: 'inv-2',
            invoiceNumber: 'INV-002',
            status: 'OPEN',
            total: 3000,
          },
        ];

        vi.mocked(mockContext.prisma.customer.findUnique).mockResolvedValue(customer);
        vi.mocked(mockContext.prisma.invoice.findMany).mockResolvedValue([invoices[1]]);

        const result = await billingResolvers.Query.invoices(
          {},
          { status: 'OPEN', limit: 10 },
          mockContext
        );

        expect(result).toEqual([invoices[1]]);
        expect(mockContext.prisma.invoice.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              status: 'OPEN',
            }),
            take: 10,
          })
        );
      });
    });

    describe('currentUsage', () => {
      it('should return current usage for user', async () => {
        const usage = {
          storage: { quantity: 100, amount: 1000 },
          bandwidth: { quantity: 200, amount: 1000 },
          compute: { quantity: 10, amount: 200 },
          requests: { quantity: 5000, amount: 5 },
          total: 2205,
        };

        const { usageService } = await import('../services/billing/index.js');
        vi.mocked(usageService).mockReturnValue({
          getCurrentUsage: vi.fn().mockResolvedValue(usage),
        } as any);

        const result = await billingResolvers.Query.currentUsage({}, {}, mockContext);

        expect(result).toEqual(usage);
      });
    });

    describe('Storage Tracking Queries', () => {
      describe('pinnedContent', () => {
        it('should return list of pinned content', async () => {
          const pins = [
            {
              id: 'pin-1',
              userId: 'user-123',
              cid: 'QmTest1',
              sizeBytes: BigInt(1024 * 1024 * 50),
              pinnedAt: new Date(),
              filename: 'file1.jpg',
            },
            {
              id: 'pin-2',
              userId: 'user-123',
              cid: 'QmTest2',
              sizeBytes: BigInt(1024 * 1024 * 75),
              pinnedAt: new Date(),
              filename: 'file2.png',
            },
          ];

          const { StorageTracker } = await import('../services/billing/index.js');
          vi.mocked(StorageTracker).mockReturnValue({
            getActivePins: vi.fn().mockResolvedValue(pins),
          } as any);

          const result = await billingResolvers.Query.pinnedContent({}, { limit: 100 }, mockContext);

          expect(result).toHaveLength(2);
          expect(result[0].sizeBytes).toBe((BigInt(1024 * 1024 * 50)).toString());
          expect(result[1].sizeBytes).toBe((BigInt(1024 * 1024 * 75)).toString());
        });

        it('should throw error if not authenticated', async () => {
          mockContext.userId = undefined;

          await expect(billingResolvers.Query.pinnedContent({}, {}, mockContext)).rejects.toThrow(
            'Authentication required'
          );
        });
      });

      describe('storageSnapshots', () => {
        it('should return storage snapshots within date range', async () => {
          const snapshots = [
            {
              id: 'snap-1',
              userId: 'user-123',
              date: new Date('2024-01-01'),
              totalBytes: BigInt(1024 * 1024 * 1024 * 50),
              pinCount: 25,
            },
            {
              id: 'snap-2',
              userId: 'user-123',
              date: new Date('2024-01-15'),
              totalBytes: BigInt(1024 * 1024 * 1024 * 55),
              pinCount: 27,
            },
          ];

          const { StorageTracker } = await import('../services/billing/index.js');
          vi.mocked(StorageTracker).mockReturnValue({
            getSnapshots: vi.fn().mockResolvedValue(snapshots),
          } as any);

          const result = await billingResolvers.Query.storageSnapshots(
            {},
            {
              startDate: new Date('2024-01-01'),
              endDate: new Date('2024-01-31'),
              limit: 30,
            },
            mockContext
          );

          expect(result).toHaveLength(2);
          expect(result[0].totalBytes).toBe((BigInt(1024 * 1024 * 1024 * 50)).toString());
        });
      });

      describe('storageStats', () => {
        it('should return current storage statistics', async () => {
          const { StorageTracker } = await import('../services/billing/index.js');
          vi.mocked(StorageTracker).mockReturnValue({
            getCurrentStorage: vi.fn().mockResolvedValue(BigInt(1024 * 1024 * 1024 * 10)),
            getPinCount: vi.fn().mockResolvedValue(15),
            getSnapshots: vi.fn().mockResolvedValue([]),
          } as any);

          const result = await billingResolvers.Query.storageStats({}, {}, mockContext);

          expect(result.currentBytes).toBe((BigInt(1024 * 1024 * 1024 * 10)).toString());
          expect(result.currentBytesFormatted).toBe('10.00 GB');
          expect(result.pinCount).toBe(15);
        });

        it('should format MB for small storage', async () => {
          const { StorageTracker } = await import('../services/billing/index.js');
          vi.mocked(StorageTracker).mockReturnValue({
            getCurrentStorage: vi.fn().mockResolvedValue(BigInt(1024 * 1024 * 5)),
            getPinCount: vi.fn().mockResolvedValue(2),
            getSnapshots: vi.fn().mockResolvedValue([]),
          } as any);

          const result = await billingResolvers.Query.storageStats({}, {}, mockContext);

          expect(result.currentBytesFormatted).toContain('MB');
        });
      });
    });
  });

  describe('Mutation Resolvers', () => {
    describe('createSubscription', () => {
      it('should create subscription', async () => {
        const input = { plan: 'PRO', seats: 2 };
        const createdSubscription = {
          id: 'sub-123',
          plan: 'PRO',
          seats: 2,
          status: 'ACTIVE',
        };

        const { stripeService } = await import('../services/billing/index.js');
        vi.mocked(stripeService).mockReturnValue({
          createSubscription: vi.fn().mockResolvedValue('sub-123'),
        } as any);

        vi.mocked(mockContext.prisma.subscription.findUnique).mockResolvedValue(
          createdSubscription
        );

        const result = await billingResolvers.Mutation.createSubscription(
          {},
          { input },
          mockContext
        );

        expect(result).toEqual(createdSubscription);
      });

      it('should throw error if not authenticated', async () => {
        mockContext.userId = undefined;

        await expect(
          billingResolvers.Mutation.createSubscription({}, { input: { plan: 'PRO' } }, mockContext)
        ).rejects.toThrow('Authentication required');
      });
    });

    describe('cancelSubscription', () => {
      it('should cancel subscription immediately', async () => {
        const canceledSubscription = {
          id: 'sub-123',
          status: 'CANCELED',
        };

        const { stripeService } = await import('../services/billing/index.js');
        vi.mocked(stripeService).mockReturnValue({
          cancelSubscription: vi.fn().mockResolvedValue('sub-123'),
        } as any);

        vi.mocked(mockContext.prisma.subscription.findUnique).mockResolvedValue(
          canceledSubscription
        );

        const result = await billingResolvers.Mutation.cancelSubscription(
          {},
          { id: 'sub-123', immediately: true },
          mockContext
        );

        expect(result).toEqual(canceledSubscription);
      });
    });

    describe('updateSubscriptionSeats', () => {
      it('should update subscription seats', async () => {
        const updatedSubscription = {
          id: 'sub-123',
          seats: 5,
        };

        const { stripeService } = await import('../services/billing/index.js');
        vi.mocked(stripeService).mockReturnValue({
          updateSubscriptionSeats: vi.fn().mockResolvedValue('sub-123'),
        } as any);

        vi.mocked(mockContext.prisma.subscription.findUnique).mockResolvedValue(
          updatedSubscription
        );

        const result = await billingResolvers.Mutation.updateSubscriptionSeats(
          {},
          { id: 'sub-123', seats: 5 },
          mockContext
        );

        expect(result).toEqual(updatedSubscription);
      });

      it('should throw error for invalid seat count', async () => {
        await expect(
          billingResolvers.Mutation.updateSubscriptionSeats(
            {},
            { id: 'sub-123', seats: 0 },
            mockContext
          )
        ).rejects.toThrow('Seats must be at least 1');
      });
    });

    describe('addPaymentMethod', () => {
      it('should add card payment method', async () => {
        const input = {
          type: 'CARD',
          paymentMethodId: 'pm-123',
          setAsDefault: true,
        };

        const addedPaymentMethod = {
          id: 'pm-local-123',
          type: 'CARD',
          cardBrand: 'visa',
          cardLast4: '4242',
          isDefault: true,
        };

        const { stripeService } = await import('../services/billing/index.js');
        vi.mocked(stripeService).mockReturnValue({
          addPaymentMethod: vi.fn().mockResolvedValue('pm-local-123'),
        } as any);

        vi.mocked(mockContext.prisma.paymentMethod.findUnique).mockResolvedValue(
          addedPaymentMethod
        );

        const result = await billingResolvers.Mutation.addPaymentMethod({}, { input }, mockContext);

        expect(result).toEqual(addedPaymentMethod);
      });

      it('should add crypto wallet payment method', async () => {
        const input = {
          type: 'CRYPTO_WALLET',
          walletAddress: '0xabcd',
          blockchain: 'ethereum',
          setAsDefault: false,
        };

        const addedWallet = {
          id: 'pm-crypto-123',
          type: 'CRYPTO_WALLET',
          blockchain: 'ethereum',
          walletAddress: '0xabcd',
          isDefault: false,
        };

        const { cryptoService } = await import('../services/billing/index.js');
        vi.mocked(cryptoService).mockReturnValue({
          addCryptoWallet: vi.fn().mockResolvedValue('pm-crypto-123'),
        } as any);

        vi.mocked(mockContext.prisma.paymentMethod.findUnique).mockResolvedValue(addedWallet);

        const result = await billingResolvers.Mutation.addPaymentMethod({}, { input }, mockContext);

        expect(result).toEqual(addedWallet);
      });
    });

    describe('removePaymentMethod', () => {
      it('should remove payment method', async () => {
        const paymentMethod = {
          id: 'pm-123',
          customerId: 'cust-123',
          customer: { userId: 'user-123' },
        };

        vi.mocked(mockContext.prisma.paymentMethod.findUnique).mockResolvedValue(paymentMethod);
        vi.mocked(mockContext.prisma.paymentMethod.delete).mockResolvedValue(paymentMethod);

        const result = await billingResolvers.Mutation.removePaymentMethod(
          {},
          { id: 'pm-123' },
          mockContext
        );

        expect(result).toBe(true);
      });

      it('should throw error if payment method not found', async () => {
        vi.mocked(mockContext.prisma.paymentMethod.findUnique).mockResolvedValue(null);

        await expect(
          billingResolvers.Mutation.removePaymentMethod({}, { id: 'pm-123' }, mockContext)
        ).rejects.toThrow('Payment method not found');
      });
    });

    describe('recordCryptoPayment', () => {
      it('should record crypto payment', async () => {
        const input = {
          txHash: '0xtxhash',
          blockchain: 'ethereum',
          amount: 100,
        };

        const recordedPayment = {
          id: 'payment-123',
          amount: 10000,
          currency: 'USD',
          status: 'COMPLETED',
        };

        const { cryptoService } = await import('../services/billing/index.js');
        vi.mocked(cryptoService).mockReturnValue({
          recordCryptoPayment: vi.fn().mockResolvedValue('payment-123'),
        } as any);

        mockContext.prisma.payment = {
          findUnique: vi.fn().mockResolvedValue(recordedPayment),
        } as any;

        const result = await billingResolvers.Mutation.recordCryptoPayment(
          {},
          { input },
          mockContext
        );

        expect(result).toEqual(recordedPayment);
      });
    });

    describe('generateInvoice', () => {
      it('should generate invoice for subscription', async () => {
        const generatedInvoice = {
          id: 'inv-123',
          invoiceNumber: 'INV-001',
          status: 'OPEN',
          total: 5000,
        };

        const { invoiceService } = await import('../services/billing/index.js');
        vi.mocked(invoiceService).mockReturnValue({
          generateInvoice: vi.fn().mockResolvedValue('inv-123'),
        } as any);

        vi.mocked(mockContext.prisma.invoice.findUnique).mockResolvedValue(generatedInvoice);

        const result = await billingResolvers.Mutation.generateInvoice(
          {},
          { subscriptionId: 'sub-123' },
          mockContext
        );

        expect(result).toEqual(generatedInvoice);
      });
    });

    describe('updateBillingSettings', () => {
      it('should update billing settings (admin only)', async () => {
        mockContext.userId = 'admin-user';
        mockContext.user = { role: 'ADMIN' } as any;

        const input = {
          storagePerGBCents: 15,
          bandwidthPerGBCents: 8,
          computePerHourCents: 25,
          requestsPer1000Cents: 2,
        };

        const updatedSettings = {
          id: 'settings-1',
          ...input,
        };

        vi.mocked(mockContext.prisma.billingSettings.upsert).mockResolvedValue(updatedSettings);

        const result = await billingResolvers.Mutation.updateBillingSettings(
          {},
          { input },
          mockContext
        );

        expect(result).toEqual(updatedSettings);
      });

      it('should throw error if not admin', async () => {
        mockContext.user = { role: 'USER' } as any;

        await expect(
          billingResolvers.Mutation.updateBillingSettings(
            {},
            { input: { storagePerGBCents: 15 } },
            mockContext
          )
        ).rejects.toThrow('Admin access required');
      });
    });

    describe('Storage Tracking Mutations', () => {
      beforeEach(() => {
        mockContext.prisma.storageSnapshot = {
          findUnique: vi.fn(),
          upsert: vi.fn(),
        } as any;
        mockContext.prisma.invoice = {
          ...mockContext.prisma.invoice,
          findMany: vi.fn(),
        } as any;
      });

      describe('triggerStorageSnapshot', () => {
        it('should create storage snapshot for user', async () => {
          const snapshot = {
            id: 'snapshot-123',
            userId: 'user-123',
            date: new Date(),
            totalBytes: BigInt(1024 * 1024 * 1024 * 50),
            pinCount: 25,
            createdAt: new Date(),
          };

          const { StorageTracker } = await import('../services/billing/index.js');
          vi.mocked(StorageTracker).mockReturnValue({
            createDailySnapshot: vi.fn().mockResolvedValue('snapshot-123'),
          } as any);

          vi.mocked(mockContext.prisma.storageSnapshot.findUnique).mockResolvedValue(snapshot);

          const result = await billingResolvers.Mutation.triggerStorageSnapshot(
            {},
            {},
            mockContext
          );

          expect(result.id).toBe('snapshot-123');
          expect(result.totalBytes).toBe((BigInt(1024 * 1024 * 1024 * 50)).toString());
        });

        it('should throw error if not authenticated', async () => {
          mockContext.userId = undefined;

          await expect(
            billingResolvers.Mutation.triggerStorageSnapshot({}, {}, mockContext)
          ).rejects.toThrow('Authentication required');
        });
      });

      describe('triggerInvoiceGeneration', () => {
        it('should trigger invoice generation and return recent invoices', async () => {
          const recentInvoices = [
            {
              id: 'inv-1',
              invoiceNumber: 'INV-001',
              status: 'OPEN',
              total: 5000,
              lineItems: [],
            },
            {
              id: 'inv-2',
              invoiceNumber: 'INV-002',
              status: 'OPEN',
              total: 3000,
              lineItems: [],
            },
          ];

          const { InvoiceScheduler } = await import('../services/billing/index.js');
          vi.mocked(InvoiceScheduler).mockReturnValue({
            runNow: vi.fn().mockResolvedValue(undefined),
          } as any);

          vi.mocked(mockContext.prisma.invoice.findMany).mockResolvedValue(recentInvoices);

          const result = await billingResolvers.Mutation.triggerInvoiceGeneration(
            {},
            {},
            mockContext
          );

          expect(result).toEqual(recentInvoices);
          expect(result).toHaveLength(2);
        });

        it('should throw error if not authenticated', async () => {
          mockContext.userId = undefined;

          await expect(
            billingResolvers.Mutation.triggerInvoiceGeneration({}, {}, mockContext)
          ).rejects.toThrow('Authentication required');
        });
      });
    });
  });
});
