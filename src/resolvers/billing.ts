/**
 * Billing GraphQL Resolvers
 *
 * Resolvers for billing and subscription operations
 */

import type { PrismaClient } from '@prisma/client'
import { GraphQLError } from 'graphql'
import { StripeService } from '../services/billing/stripeService.js'
import { CryptoService } from '../services/billing/cryptoService.js'
import { UsageService } from '../services/billing/usageService.js'
import { InvoiceService } from '../services/billing/invoiceService.js'
import { StorageTracker } from '../services/billing/storageTracker.js'
import { StorageSnapshotScheduler } from '../services/billing/storageSnapshotScheduler.js'
import { InvoiceScheduler } from '../services/billing/invoiceScheduler.js'
import { UsageBuffer } from '../services/billing/usageBuffer.js'
import { UsageAggregator } from '../services/billing/usageAggregator.js'
import type { Context } from './types.js'

// Service factory functions
const stripeService = (prisma: PrismaClient) => new StripeService(prisma)
const cryptoService = (prisma: PrismaClient) => new CryptoService(prisma)
const usageService = (prisma: PrismaClient) => new UsageService(prisma)
const invoiceService = (prisma: PrismaClient) => new InvoiceService(prisma)
const storageTracker = (prisma: PrismaClient) => new StorageTracker(prisma)
const storageSnapshotScheduler = (prisma: PrismaClient) =>
  new StorageSnapshotScheduler(prisma)
const invoiceSchedulerService = (prisma: PrismaClient) =>
  new InvoiceScheduler(prisma)
const usageBuffer = () => new UsageBuffer()
const usageAggregator = (prisma: PrismaClient) => new UsageAggregator(prisma)

export const billingResolvers = {
  Query: {
    /**
     * Get customer for authenticated user
     */
    customer: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      return context.prisma.customer.findUnique({
        where: { userId: context.userId },
        include: {
          user: true,
          defaultPaymentMethod: true,
          paymentMethods: true,
          subscriptions: true,
          invoices: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      })
    },

    /**
     * Get payment methods for authenticated user
     */
    paymentMethods: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const customer = await context.prisma.customer.findUnique({
        where: { userId: context.userId },
      })

      if (!customer) {
        return []
      }

      return context.prisma.paymentMethod.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
      })
    },

    /**
     * Get all subscriptions for authenticated user
     */
    subscriptions: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const customer = await context.prisma.customer.findUnique({
        where: { userId: context.userId },
      })

      if (!customer) {
        return []
      }

      return context.prisma.subscription.findMany({
        where: { customerId: customer.id },
        orderBy: { createdAt: 'desc' },
      })
    },

    /**
     * Get active subscription for authenticated user
     */
    activeSubscription: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const customer = await context.prisma.customer.findUnique({
        where: { userId: context.userId },
      })

      if (!customer) {
        return null
      }

      return context.prisma.subscription.findFirst({
        where: {
          customerId: customer.id,
          status: 'ACTIVE',
        },
        orderBy: { createdAt: 'desc' },
      })
    },

    /**
     * Get invoices for authenticated user
     */
    invoices: async (
      _: any,
      { status, limit = 50 }: { status?: string; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const customer = await context.prisma.customer.findUnique({
        where: { userId: context.userId },
      })

      if (!customer) {
        return []
      }

      return context.prisma.invoice.findMany({
        where: {
          customerId: customer.id,
          ...(status && { status: status as any }),
        },
        include: {
          lineItems: true,
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },

    /**
     * Get single invoice by ID
     */
    invoice: async (_: any, { id }: { id: string }, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const invoice = await context.prisma.invoice.findUnique({
        where: { id },
        include: {
          customer: true,
          lineItems: true,
        },
      })

      // Verify ownership
      if (invoice && invoice.customer.userId !== context.userId) {
        throw new GraphQLError('Unauthorized')
      }

      return invoice
    },

    /**
     * Get current usage for authenticated user
     */
    currentUsage: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      return usageService(context.prisma).getCurrentUsage(context.userId)
    },

    /**
     * Get billing settings (admin only)
     */
    billingSettings: async (_: any, __: any, context: Context) => {
      // TODO: Add admin check
      return context.prisma.billingSettings.findFirst()
    },

    /**
     * Get pinned content for authenticated user
     */
    pinnedContent: async (
      _: any,
      { limit = 100 }: { limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const pins = await storageTracker(context.prisma).getActivePins(
        context.userId,
        limit
      )

      // Convert BigInt to string for GraphQL
      return pins.map((pin: any) => ({
        ...pin,
        sizeBytes: pin.sizeBytes.toString(),
      }))
    },

    /**
     * Get storage snapshots for authenticated user
     */
    storageSnapshots: async (
      _: any,
      {
        startDate,
        endDate,
        limit = 30,
      }: { startDate?: Date; endDate?: Date; limit?: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Default 30 days ago
      const end = endDate || new Date()

      const snapshots = await storageTracker(context.prisma).getSnapshots(
        context.userId,
        start,
        end
      )

      // Convert BigInt to string for GraphQL and apply limit
      return snapshots.slice(0, limit).map((snapshot: any) => ({
        ...snapshot,
        totalBytes: snapshot.totalBytes.toString(),
      }))
    },

    /**
     * Get storage statistics for authenticated user
     */
    storageStats: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const currentBytes = await storageTracker(
        context.prisma
      ).getCurrentStorage(context.userId)
      const pinCount = await storageTracker(context.prisma).getPinCount(
        context.userId
      )

      // Get last snapshot
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const yesterday = new Date(today)
      yesterday.setDate(yesterday.getDate() - 1)

      const snapshots = await storageTracker(context.prisma).getSnapshots(
        context.userId,
        yesterday,
        today
      )
      const lastSnapshot =
        snapshots.length > 0 ? snapshots[snapshots.length - 1] : null

      // Format bytes for display (GB)
      const gb = Number(currentBytes) / (1024 * 1024 * 1024)
      const formatted =
        gb < 0.01 ? `${(gb * 1024).toFixed(2)} MB` : `${gb.toFixed(2)} GB`

      return {
        currentBytes: currentBytes.toString(),
        currentBytesFormatted: formatted,
        pinCount,
        lastSnapshot: lastSnapshot
          ? {
              ...lastSnapshot,
              totalBytes: lastSnapshot.totalBytes.toString(),
            }
          : null,
      }
    },

    /**
     * Get usage buffer statistics (for monitoring)
     */
    usageBufferStats: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const buffer = usageBuffer()
      const stats = await buffer.getStats()
      const healthy = await buffer.healthCheck()

      return {
        activeUsers: stats.activeUsers,
        totalBandwidth: stats.totalBandwidth,
        totalCompute: stats.totalCompute,
        totalRequests: stats.totalRequests,
        bufferHealthy: healthy,
      }
    },
  },

  Mutation: {
    /**
     * Create a new subscription
     */
    createSubscription: async (
      _: any,
      {
        input,
      }: {
        input: {
          plan: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE'
          seats?: number
        }
      },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const subscriptionId = await stripeService(
        context.prisma
      ).createSubscription(context.userId, input.plan, input.seats || 1)

      return context.prisma.subscription.findUnique({
        where: { id: subscriptionId },
      })
    },

    /**
     * Cancel a subscription
     */
    cancelSubscription: async (
      _: any,
      { id, immediately = false }: { id: string; immediately?: boolean },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Verify ownership
      const subscription = await context.prisma.subscription.findUnique({
        where: { id },
        include: { customer: true },
      })

      if (!subscription || subscription.customer.userId !== context.userId) {
        throw new GraphQLError('Unauthorized')
      }

      await stripeService(context.prisma).cancelSubscription(
        context.userId,
        id,
        immediately
      )

      return context.prisma.subscription.findUnique({
        where: { id },
      })
    },

    /**
     * Update subscription seats
     */
    updateSubscriptionSeats: async (
      _: any,
      { id, seats }: { id: string; seats: number },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Verify ownership
      const subscription = await context.prisma.subscription.findUnique({
        where: { id },
        include: { customer: true },
      })

      if (!subscription || subscription.customer.userId !== context.userId) {
        throw new GraphQLError('Unauthorized')
      }

      if (seats < 1) {
        throw new GraphQLError('Seats must be at least 1')
      }

      // Update seats
      return context.prisma.subscription.update({
        where: { id },
        data: { seats },
      })
    },

    /**
     * Add a payment method
     */
    addPaymentMethod: async (
      _: any,
      {
        input,
      }: {
        input: {
          stripePaymentMethodId?: string
          walletAddress?: string
          blockchain?: string
          setAsDefault?: boolean
        }
      },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      let paymentMethodId: string

      if (input.stripePaymentMethodId) {
        // Stripe payment method
        const result = await stripeService(context.prisma).addPaymentMethod(
          context.userId,
          input.stripePaymentMethodId,
          input.setAsDefault || false
        )
        paymentMethodId = result.id
      } else if (input.walletAddress && input.blockchain) {
        // Crypto wallet
        paymentMethodId = await cryptoService(context.prisma).addCryptoWallet(
          context.userId,
          input.walletAddress,
          input.blockchain as any
        )

        if (input.setAsDefault) {
          const customer = await context.prisma.customer.findUnique({
            where: { userId: context.userId },
          })
          if (customer) {
            await context.prisma.customer.update({
              where: { id: customer.id },
              data: { defaultPaymentMethodId: paymentMethodId },
            })
          }
        }
      } else {
        throw new GraphQLError(
          'Either stripePaymentMethodId or walletAddress is required'
        )
      }

      return context.prisma.paymentMethod.findUnique({
        where: { id: paymentMethodId },
      })
    },

    /**
     * Remove a payment method
     */
    removePaymentMethod: async (
      _: any,
      { id }: { id: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Verify ownership
      const paymentMethod = await context.prisma.paymentMethod.findUnique({
        where: { id },
        include: { customer: true },
      })

      if (!paymentMethod || paymentMethod.customer.userId !== context.userId) {
        throw new GraphQLError('Unauthorized')
      }

      if (paymentMethod.stripePaymentMethodId) {
        await stripeService(context.prisma).removePaymentMethod(
          context.userId,
          id
        )
      } else {
        // Crypto wallet - just delete the record
        await context.prisma.paymentMethod.delete({
          where: { id },
        })
      }

      return true
    },

    /**
     * Set default payment method
     */
    setDefaultPaymentMethod: async (
      _: any,
      { id }: { id: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Verify ownership
      const paymentMethod = await context.prisma.paymentMethod.findUnique({
        where: { id },
        include: { customer: true },
      })

      if (!paymentMethod || paymentMethod.customer.userId !== context.userId) {
        throw new GraphQLError('Unauthorized')
      }

      if (paymentMethod.stripePaymentMethodId) {
        await stripeService(context.prisma).setDefaultPaymentMethod(
          context.userId,
          id
        )
      }

      // Update customer default
      await context.prisma.customer.update({
        where: { id: paymentMethod.customerId },
        data: { defaultPaymentMethodId: id },
      })

      return context.prisma.paymentMethod.findUnique({
        where: { id },
      })
    },

    /**
     * Process a payment (Stripe)
     */
    processPayment: async (
      _: any,
      {
        amount,
        currency = 'usd',
        invoiceId,
      }: { amount: number; currency?: string; invoiceId?: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const result = await stripeService(context.prisma).processPayment(
        context.userId,
        amount,
        currency,
        invoiceId
      )

      return context.prisma.payment.findUnique({
        where: { id: result.paymentId },
      })
    },

    /**
     * Record a crypto payment
     */
    recordCryptoPayment: async (
      _: any,
      {
        input,
      }: {
        input: {
          txHash: string
          blockchain: string
          amount: number
          invoiceId?: string
        }
      },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const paymentId = await cryptoService(context.prisma).recordCryptoPayment(
        context.userId,
        input.txHash,
        input.blockchain,
        input.amount,
        input.invoiceId
      )

      return context.prisma.payment.findUnique({
        where: { id: paymentId },
      })
    },

    /**
     * Generate an invoice for a subscription
     */
    generateInvoice: async (
      _: any,
      { subscriptionId }: { subscriptionId: string },
      context: Context
    ) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Verify ownership
      const subscription = await context.prisma.subscription.findUnique({
        where: { id: subscriptionId },
        include: { customer: true },
      })

      if (!subscription || subscription.customer.userId !== context.userId) {
        throw new GraphQLError('Unauthorized')
      }

      const invoiceId = await invoiceService(context.prisma).generateInvoice(
        subscriptionId
      )

      return context.prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { lineItems: true },
      })
    },

    /**
     * Update billing settings (admin only)
     */
    updateBillingSettings: async (
      _: any,
      {
        input,
      }: {
        input: {
          pricePerSeatCents?: number
          usageMarkupPercent?: number
          storagePerGBCents?: number
          bandwidthPerGBCents?: number
          computePerHourCents?: number
          requestsPer1000Cents?: number
          taxRatePercent?: number
          invoiceDueDays?: number
          trialPeriodDays?: number
        }
      },
      context: Context
    ) => {
      // TODO: Add admin check
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Get or create billing settings
      let settings = await context.prisma.billingSettings.findFirst()

      if (!settings) {
        settings = await context.prisma.billingSettings.create({
          data: {},
        })
      }

      return context.prisma.billingSettings.update({
        where: { id: settings.id },
        data: input,
      })
    },

    /**
     * Trigger a storage snapshot for authenticated user
     */
    triggerStorageSnapshot: async (_: any, __: any, context: Context) => {
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const snapshotId = await storageTracker(
        context.prisma
      ).createDailySnapshot(context.userId)

      const snapshot = await context.prisma.storageSnapshot.findUnique({
        where: { id: snapshotId },
      })

      if (!snapshot) {
        throw new GraphQLError('Failed to create snapshot')
      }

      return {
        ...snapshot,
        totalBytes: snapshot.totalBytes.toString(),
      }
    },

    /**
     * Trigger invoice generation for all due subscriptions (admin only)
     */
    triggerInvoiceGeneration: async (_: any, __: any, context: Context) => {
      // TODO: Add admin check
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      // Run the invoice generation immediately
      await invoiceSchedulerService(context.prisma).runNow()

      // Return recently generated invoices (from last hour)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

      const invoices = await context.prisma.invoice.findMany({
        where: {
          createdAt: {
            gte: oneHourAgo,
          },
        },
        include: {
          lineItems: true,
        },
        orderBy: { createdAt: 'desc' },
      })

      return invoices
    },

    /**
     * Manually flush usage buffer to database (for pre-deployment safety)
     */
    flushUsageBuffer: async (_: any, __: any, context: Context) => {
      // TODO: Add admin check
      if (!context.userId) {
        throw new GraphQLError('Authentication required')
      }

      const startTime = Date.now()
      const aggregator = usageAggregator(context.prisma)

      try {
        // Trigger manual flush
        await aggregator.runNow()

        const duration = Date.now() - startTime
        const status = aggregator.getStatus()

        // Get final stats after flush
        const buffer = usageBuffer()
        const stats = await buffer.getStats()

        return {
          success: true,
          usersFlushed: 0, // Will be set by the flush operation logs
          errors: 0,
          duration,
          message: `Successfully flushed usage buffer. ${stats.activeUsers} users currently pending.`,
        }
      } catch (error) {
        const duration = Date.now() - startTime
        return {
          success: false,
          usersFlushed: 0,
          errors: 1,
          duration,
          message: `Failed to flush usage buffer: ${error instanceof Error ? error.message : 'Unknown error'}`,
        }
      }
    },
  },

  // Field resolvers
  Customer: {
    user: async (parent: any, _: any, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      })
    },
    defaultPaymentMethod: async (parent: any, _: any, context: Context) => {
      if (!parent.defaultPaymentMethodId) return null
      return context.prisma.paymentMethod.findUnique({
        where: { id: parent.defaultPaymentMethodId },
      })
    },
    paymentMethods: async (parent: any, _: any, context: Context) => {
      return context.prisma.paymentMethod.findMany({
        where: { customerId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
    },
    subscriptions: async (parent: any, _: any, context: Context) => {
      return context.prisma.subscription.findMany({
        where: { customerId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
    },
    invoices: async (parent: any, _: any, context: Context) => {
      return context.prisma.invoice.findMany({
        where: { customerId: parent.id },
        orderBy: { createdAt: 'desc' },
      })
    },
  },

  PaymentMethod: {
    customer: async (parent: any, _: any, context: Context) => {
      return context.prisma.customer.findUnique({
        where: { id: parent.customerId },
      })
    },
  },

  Subscription: {
    customer: async (parent: any, _: any, context: Context) => {
      return context.prisma.customer.findUnique({
        where: { id: parent.customerId },
      })
    },
  },

  Invoice: {
    customer: async (parent: any, _: any, context: Context) => {
      return context.prisma.customer.findUnique({
        where: { id: parent.customerId },
      })
    },
    subscription: async (parent: any, _: any, context: Context) => {
      if (!parent.subscriptionId) return null
      return context.prisma.subscription.findUnique({
        where: { id: parent.subscriptionId },
      })
    },
    lineItems: async (parent: any, _: any, context: Context) => {
      return context.prisma.invoiceLineItem.findMany({
        where: { invoiceId: parent.id },
      })
    },
  },

  Payment: {
    customer: async (parent: any, _: any, context: Context) => {
      return context.prisma.customer.findUnique({
        where: { id: parent.customerId },
      })
    },
    invoice: async (parent: any, _: any, context: Context) => {
      if (!parent.invoiceId) return null
      return context.prisma.invoice.findUnique({
        where: { id: parent.invoiceId },
      })
    },
    paymentMethod: async (parent: any, _: any, context: Context) => {
      if (!parent.paymentMethodId) return null
      return context.prisma.paymentMethod.findUnique({
        where: { id: parent.paymentMethodId },
      })
    },
  },

  UsageRecord: {
    customer: async (parent: any, _: any, context: Context) => {
      return context.prisma.customer.findUnique({
        where: { id: parent.customerId },
      })
    },
  },

  PinnedContent: {
    user: async (parent: any, _: any, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      })
    },
  },

  StorageSnapshot: {
    user: async (parent: any, _: any, context: Context) => {
      return context.prisma.user.findUnique({
        where: { id: parent.userId },
      })
    },
  },
}
