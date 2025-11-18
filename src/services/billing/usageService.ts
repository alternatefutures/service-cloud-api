/**
 * Usage Metering Service
 *
 * Tracks and meters usage for billing purposes
 */

import type { PrismaClient } from '@prisma/client'

export class UsageService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Record usage
   */
  async recordUsage(
    userId: string,
    type: 'STORAGE' | 'BANDWIDTH' | 'COMPUTE' | 'REQUESTS' | 'SEATS',
    quantity: number,
    unit: string,
    resourceType: string,
    resourceId?: string,
    metadata?: any
  ): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    })

    if (!customer) {
      throw new Error('Customer not found')
    }

    // Get current billing period
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        customerId: customer.id,
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
    })

    const periodStart = subscription?.currentPeriodStart || new Date()
    const periodEnd =
      subscription?.currentPeriodEnd ||
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)

    // Get pricing from billing settings
    const settings = await this.prisma.billingSettings.findFirst()
    let unitPrice: number | undefined

    switch (type) {
      case 'STORAGE':
        unitPrice = settings?.storagePerGBCents
        break
      case 'BANDWIDTH':
        unitPrice = settings?.bandwidthPerGBCents
        break
      case 'COMPUTE':
        unitPrice = settings?.computePerHourCents
        break
      case 'REQUESTS':
        unitPrice = settings?.requestsPer1000Cents
        break
    }

    const amount = unitPrice ? Math.ceil(quantity * unitPrice) : undefined

    // Create usage record
    const usage = await this.prisma.usageRecord.create({
      data: {
        customerId: customer.id,
        type,
        resourceType,
        resourceId,
        quantity,
        unit,
        periodStart,
        periodEnd,
        unitPrice,
        amount,
        metadata,
      },
    })

    return usage.id
  }

  /**
   * Get usage for billing period
   */
  async getUsageForPeriod(
    userId: string,
    periodStart: Date,
    periodEnd: Date
  ): Promise<{
    storage: { quantity: number; amount: number }
    bandwidth: { quantity: number; amount: number }
    compute: { quantity: number; amount: number }
    requests: { quantity: number; amount: number }
    total: number
  }> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    })

    if (!customer) {
      throw new Error('Customer not found')
    }

    // Aggregate usage by type
    const usage = await this.prisma.usageRecord.groupBy({
      by: ['type'],
      where: {
        customerId: customer.id,
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
      },
      _sum: {
        quantity: true,
        amount: true,
      },
    })

    const result = {
      storage: { quantity: 0, amount: 0 },
      bandwidth: { quantity: 0, amount: 0 },
      compute: { quantity: 0, amount: 0 },
      requests: { quantity: 0, amount: 0 },
      total: 0,
    }

    for (const item of usage) {
      const key = item.type.toLowerCase() as keyof typeof result
      if (key !== 'total') {
        result[key] = {
          quantity: Number(item._sum.quantity || 0),
          amount: item._sum.amount || 0,
        }
        result.total += item._sum.amount || 0
      }
    }

    return result
  }

  /**
   * Get current usage
   */
  async getCurrentUsage(userId: string): Promise<any> {
    const customer = await this.prisma.customer.findUnique({
      where: { userId },
    })

    if (!customer) {
      throw new Error('Customer not found')
    }

    // Get active subscription to determine billing period
    const subscription = await this.prisma.subscription.findFirst({
      where: {
        customerId: customer.id,
        status: 'ACTIVE',
      },
      orderBy: { createdAt: 'desc' },
    })

    if (!subscription) {
      return {
        storage: { quantity: 0, amount: 0 },
        bandwidth: { quantity: 0, amount: 0 },
        compute: { quantity: 0, amount: 0 },
        requests: { quantity: 0, amount: 0 },
        total: 0,
      }
    }

    return this.getUsageForPeriod(
      userId,
      subscription.currentPeriodStart,
      subscription.currentPeriodEnd
    )
  }
}
