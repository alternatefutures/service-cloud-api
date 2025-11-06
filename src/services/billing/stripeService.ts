/**
 * Stripe Payment Service
 *
 * Handles all Stripe-related operations:
 * - Customer management
 * - Payment method management
 * - Subscription creation and management
 * - Payment processing
 */

import Stripe from 'stripe';
import type { PrismaClient } from '@prisma/client';

// Lazy-load Stripe client only if API key is available
let stripe: Stripe | null = null;

function getStripeClient(): Stripe {
  if (!stripe) {
    const apiKey = process.env.STRIPE_SECRET_KEY;
    if (!apiKey) {
      throw new Error(
        'STRIPE_SECRET_KEY environment variable is required for billing operations'
      );
    }
    stripe = new Stripe(apiKey, {
      apiVersion: '2024-12-18.acacia',
    });
  }
  return stripe;
}

export class StripeService {
  constructor(private prisma: PrismaClient) {}

  private get stripe(): Stripe {
    return getStripeClient();
  }

  /**
   * Create or get Stripe customer for a user
   */
  async getOrCreateCustomer(userId: string): Promise<{ customerId: string; stripeCustomerId: string }> {
    // Check if customer already exists
    let customer = await this.prisma.customer.findUnique({
      where: { userId },
    });

    if (customer && customer.stripeCustomerId) {
      return { customerId: customer.id, stripeCustomerId: customer.stripeCustomerId };
    }

    // Get user details
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Create Stripe customer
    const stripeCustomer = await this.stripe.customers.create({
      email: user.email || undefined,
      name: user.username || undefined,
      metadata: {
        userId,
      },
    });

    // Create or update Customer record
    if (customer) {
      customer = await this.prisma.customer.update({
        where: { id: customer.id },
        data: { stripeCustomerId: stripeCustomer.id },
      });
    } else {
      customer = await this.prisma.customer.create({
        data: {
          userId,
          stripeCustomerId: stripeCustomer.id,
          email: user.email,
          name: user.username,
        },
      });
    }

    return { customerId: customer.id, stripeCustomerId: stripeCustomer.id };
  }

  /**
   * Add payment method
   */
  async addPaymentMethod(
    userId: string,
    paymentMethodId: string,
    setAsDefault = false
  ): Promise<{ id: string; last4: string; brand: string }> {
    const { customerId, stripeCustomerId } = await this.getOrCreateCustomer(userId);

    // Attach payment method to Stripe customer
    const paymentMethod = await this.stripe.paymentMethods.attach(paymentMethodId, {
      customer: stripeCustomerId,
    });

    // Create payment method record
    const pm = await this.prisma.paymentMethod.create({
      data: {
        customerId,
        type: 'CARD',
        stripePaymentMethodId: paymentMethod.id,
        cardBrand: paymentMethod.card?.brand,
        cardLast4: paymentMethod.card?.last4,
        cardExpMonth: paymentMethod.card?.exp_month,
        cardExpYear: paymentMethod.card?.exp_year,
        isDefault: setAsDefault,
      },
    });

    // Update default payment method if requested
    if (setAsDefault) {
      await this.stripe.customers.update(stripeCustomerId, {
        invoice_settings: {
          default_payment_method: paymentMethod.id,
        },
      });

      await this.prisma.customer.update({
        where: { id: customerId },
        data: { defaultPaymentMethodId: pm.id },
      });

      // Unset other payment methods as default
      await this.prisma.paymentMethod.updateMany({
        where: {
          customerId,
          id: { not: pm.id },
        },
        data: { isDefault: false },
      });
    }

    return {
      id: pm.id,
      last4: pm.cardLast4 || '',
      brand: pm.cardBrand || '',
    };
  }

  /**
   * Remove payment method
   */
  async removePaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    const pm = await this.prisma.paymentMethod.findUnique({
      where: { id: paymentMethodId },
    });

    if (!pm || pm.customerId !== customer.id) {
      throw new Error('Payment method not found');
    }

    // Detach from Stripe
    if (pm.stripePaymentMethodId) {
      await this.stripe.paymentMethods.detach(pm.stripePaymentMethodId);
    }

    // Delete from database
    await this.prisma.paymentMethod.delete({
      where: { id: paymentMethodId },
    });

    // If this was the default payment method, clear the default
    if (customer.defaultPaymentMethodId === paymentMethodId) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: { defaultPaymentMethodId: null },
      });
    }
  }

  /**
   * Set default payment method
   */
  async setDefaultPaymentMethod(userId: string, paymentMethodId: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    });

    if (!customer || !customer.stripeCustomerId) {
      throw new Error('Customer not found');
    }

    const pm = await this.prisma.paymentMethod.findUnique({
      where: { id: paymentMethodId },
    });

    if (!pm || pm.customerId !== customer.id) {
      throw new Error('Payment method not found');
    }

    // Update in Stripe
    await this.stripe.customers.update(customer.stripeCustomerId, {
      invoice_settings: {
        default_payment_method: pm.stripePaymentMethodId || undefined,
      },
    });

    // Update in database
    await this.prisma.customer.update({
      where: { id: customer.id },
      data: { defaultPaymentMethodId: paymentMethodId },
    });

    // Unset other payment methods as default
    await this.prisma.paymentMethod.updateMany({
      where: {
        customerId: customer.id,
        id: { not: paymentMethodId },
      },
      data: { isDefault: false },
    });

    // Set this payment method as default
    await this.prisma.paymentMethod.update({
      where: { id: paymentMethodId },
      data: { isDefault: true },
    });
  }

  /**
   * Create subscription
   */
  async createSubscription(
    userId: string,
    plan: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE',
    seats = 1
  ): Promise<string> {
    const { customerId, stripeCustomerId } = await this.getOrCreateCustomer(userId);

    // Get billing settings for pricing
    const settings = await this.prisma.billingSettings.findFirst();
    const basePricePerSeat = settings?.pricePerSeatCents || 0;
    const usageMarkup = settings?.usageMarkupPercent || 0;

    // Calculate period
    const now = new Date();
    const periodEnd = new Date(now);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    // For non-free plans, create Stripe subscription
    let stripeSubscriptionId: string | undefined;

    if (plan !== 'FREE' && basePricePerSeat > 0) {
      // Create or get price in Stripe
      // In production, you'd have pre-created prices in Stripe dashboard
      const subscription = await this.stripe.subscriptions.create({
        customer: stripeCustomerId,
        items: [
          {
            price_data: {
              currency: 'usd',
              product_data: {
                name: `${plan} Plan`,
                metadata: { plan },
              },
              recurring: {
                interval: 'month',
              },
              unit_amount: basePricePerSeat,
            },
            quantity: seats,
          },
        ],
        metadata: {
          userId,
          plan,
        },
      });

      stripeSubscriptionId = subscription.id;
    }

    // Create subscription record
    const sub = await this.prisma.subscription.create({
      data: {
        customerId,
        stripeSubscriptionId,
        status: 'ACTIVE',
        plan,
        basePricePerSeat,
        usageMarkup,
        seats,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
      },
    });

    return sub.id;
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(userId: string, subscriptionId: string, immediately = false): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
    });

    if (!subscription || subscription.customerId !== customer.id) {
      throw new Error('Subscription not found');
    }

    // Cancel in Stripe
    if (subscription.stripeSubscriptionId) {
      if (immediately) {
        await this.stripe.subscriptions.cancel(subscription.stripeSubscriptionId);
      } else {
        await this.stripe.subscriptions.update(subscription.stripeSubscriptionId, {
          cancel_at_period_end: true,
        });
      }
    }

    // Update subscription record
    const now = new Date();
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: immediately ? 'CANCELED' : subscription.status,
        cancelAt: immediately ? now : subscription.currentPeriodEnd,
        canceledAt: now,
      },
    });
  }

  /**
   * Process payment
   */
  async processPayment(
    userId: string,
    amount: number,
    currency = 'usd',
    invoiceId?: string
  ): Promise<{ paymentId: string; status: string }> {
    const { customerId, stripeCustomerId } = await this.getOrCreateCustomer(userId);

    // Get default payment method
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { defaultPaymentMethod: true },
    });

    if (!customer?.defaultPaymentMethod?.stripePaymentMethodId) {
      throw new Error('No default payment method');
    }

    // Create payment intent
    const paymentIntent = await this.stripe.paymentIntents.create({
      amount,
      currency,
      customer: stripeCustomerId,
      payment_method: customer.defaultPaymentMethod.stripePaymentMethodId,
      confirm: true,
      return_url: `${process.env.APP_URL}/billing/payment/return`,
      metadata: {
        userId,
        invoiceId: invoiceId || '',
      },
    });

    // Create payment record
    const payment = await this.prisma.payment.create({
      data: {
        customerId,
        invoiceId,
        paymentMethodId: customer.defaultPaymentMethod.id,
        stripePaymentIntentId: paymentIntent.id,
        amount,
        currency,
        status: paymentIntent.status === 'succeeded' ? 'SUCCEEDED' : 'PROCESSING',
      },
    });

    return {
      paymentId: payment.id,
      status: payment.status,
    };
  }

  /**
   * Get customer portal URL
   */
  async createPortalSession(userId: string): Promise<string> {
    const { stripeCustomerId } = await this.getOrCreateCustomer(userId);

    const session = await this.stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${process.env.APP_URL}/billing`,
    });

    return session.url;
  }

  /**
   * Handle webhook events
   */
  async handleWebhookEvent(event: Stripe.Event): Promise<void> {
    switch (event.type) {
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await this.handleSubscriptionEvent(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_succeeded':
      case 'invoice.payment_failed':
        await this.handleInvoicePaymentEvent(event.data.object as Stripe.Invoice);
        break;

      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed':
        await this.handlePaymentIntentEvent(event.data.object as Stripe.PaymentIntent);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  }

  /**
   * Handle subscription webhook events
   */
  private async handleSubscriptionEvent(subscription: Stripe.Subscription): Promise<void> {
    const sub = await this.prisma.subscription.findUnique({
      where: { stripeSubscriptionId: subscription.id },
    });

    if (!sub) {
      console.error('Subscription not found:', subscription.id);
      return;
    }

    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        status: this.mapStripeStatus(subscription.status),
        currentPeriodStart: new Date(subscription.current_period_start * 1000),
        currentPeriodEnd: new Date(subscription.current_period_end * 1000),
        cancelAt: subscription.cancel_at ? new Date(subscription.cancel_at * 1000) : null,
      },
    });
  }

  /**
   * Handle invoice payment webhook events
   */
  private async handleInvoicePaymentEvent(invoice: Stripe.Invoice): Promise<void> {
    const inv = await this.prisma.invoice.findUnique({
      where: { stripeInvoiceId: invoice.id },
    });

    if (!inv) {
      console.error('Invoice not found:', invoice.id);
      return;
    }

    await this.prisma.invoice.update({
      where: { id: inv.id },
      data: {
        status: invoice.status === 'paid' ? 'PAID' : invoice.status === 'open' ? 'OPEN' : 'VOID',
        amountPaid: invoice.amount_paid,
        paidAt: invoice.status === 'paid' ? new Date() : null,
      },
    });
  }

  /**
   * Handle payment intent webhook events
   */
  private async handlePaymentIntentEvent(paymentIntent: Stripe.PaymentIntent): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { stripePaymentIntentId: paymentIntent.id },
    });

    if (!payment) {
      console.error('Payment not found:', paymentIntent.id);
      return;
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: {
        status: paymentIntent.status === 'succeeded' ? 'SUCCEEDED' : 'FAILED',
        failureCode: paymentIntent.last_payment_error?.code || null,
        failureMessage: paymentIntent.last_payment_error?.message || null,
      },
    });
  }

  /**
   * Map Stripe subscription status to our enum
   */
  private mapStripeStatus(status: string): 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'TRIALING' | 'PAUSED' {
    switch (status) {
      case 'active':
        return 'ACTIVE';
      case 'past_due':
        return 'PAST_DUE';
      case 'canceled':
        return 'CANCELED';
      case 'trialing':
        return 'TRIALING';
      case 'paused':
        return 'PAUSED';
      default:
        return 'ACTIVE';
    }
  }
}
