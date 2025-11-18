/**
 * Domain Usage Tracker
 *
 * Tracks domain-related usage for billing:
 * - Custom domain count
 * - SSL certificate provisioning/renewal
 * - Domain verification attempts
 * - DNS query volume
 */

import type { PrismaClient } from '@prisma/client'

export class DomainUsageTracker {
  constructor(private prisma: PrismaClient) {}

  /**
   * Track custom domain creation
   */
  async trackDomainCreation({
    customerId,
    domainId,
    hostname,
    periodStart,
    periodEnd,
  }: {
    customerId: string
    domainId: string
    hostname: string
    periodStart: Date
    periodEnd: Date
  }) {
    // Track as a request (domain registration)
    await this.prisma.usageRecord.create({
      data: {
        customerId,
        type: 'REQUESTS',
        resourceType: 'custom_domain',
        resourceId: domainId,
        quantity: 1,
        unit: 'domain',
        timestamp: new Date(),
        periodStart,
        periodEnd,
        metadata: {
          hostname,
          action: 'domain_creation',
        },
      },
    })
  }

  /**
   * Track SSL certificate provisioning
   */
  async trackSslProvisioning({
    customerId,
    domainId,
    hostname,
    periodStart,
    periodEnd,
    isRenewal = false,
  }: {
    customerId: string
    domainId: string
    hostname: string
    periodStart: Date
    periodEnd: Date
    isRenewal?: boolean
  }) {
    // SSL certificates are typically free via Let's Encrypt,
    // but we track them for monitoring and potential premium SSL in future
    await this.prisma.usageRecord.create({
      data: {
        customerId,
        type: 'REQUESTS',
        resourceType: 'ssl_certificate',
        resourceId: domainId,
        quantity: 1,
        unit: 'certificate',
        timestamp: new Date(),
        periodStart,
        periodEnd,
        unitPrice: 0, // Free for now (Let's Encrypt)
        amount: 0,
        metadata: {
          hostname,
          action: isRenewal ? 'ssl_renewal' : 'ssl_provisioning',
          provider: 'letsencrypt',
        },
      },
    })
  }

  /**
   * Track domain verification attempt
   */
  async trackDomainVerification({
    customerId,
    domainId,
    hostname,
    verificationMethod,
    success,
    periodStart,
    periodEnd,
  }: {
    customerId: string
    domainId: string
    hostname: string
    verificationMethod: 'TXT' | 'CNAME' | 'A'
    success: boolean
    periodStart: Date
    periodEnd: Date
  }) {
    await this.prisma.usageRecord.create({
      data: {
        customerId,
        type: 'REQUESTS',
        resourceType: 'domain_verification',
        resourceId: domainId,
        quantity: 1,
        unit: 'verification',
        timestamp: new Date(),
        periodStart,
        periodEnd,
        metadata: {
          hostname,
          verificationMethod,
          success,
          action: 'domain_verification',
        },
      },
    })
  }

  /**
   * Get domain usage summary for a customer
   */
  async getDomainUsageSummary({
    customerId,
    periodStart,
    periodEnd,
  }: {
    customerId: string
    periodStart: Date
    periodEnd: Date
  }) {
    const usageRecords = await this.prisma.usageRecord.findMany({
      where: {
        customerId,
        timestamp: {
          gte: periodStart,
          lte: periodEnd,
        },
        resourceType: {
          in: ['custom_domain', 'ssl_certificate', 'domain_verification'],
        },
      },
    })

    const summary = {
      customDomainsCreated: 0,
      sslCertificatesProvisioned: 0,
      sslCertificatesRenewed: 0,
      verificationAttempts: 0,
      successfulVerifications: 0,
      totalDomainOperations: usageRecords.length,
    }

    for (const record of usageRecords) {
      const metadata = record.metadata as any

      if (record.resourceType === 'custom_domain') {
        summary.customDomainsCreated++
      } else if (record.resourceType === 'ssl_certificate') {
        if (metadata?.action === 'ssl_renewal') {
          summary.sslCertificatesRenewed++
        } else {
          summary.sslCertificatesProvisioned++
        }
      } else if (record.resourceType === 'domain_verification') {
        summary.verificationAttempts++
        if (metadata?.success) {
          summary.successfulVerifications++
        }
      }
    }

    return summary
  }

  /**
   * Get active custom domains count for a customer
   */
  async getActiveDomainsCount(customerId: string): Promise<number> {
    // Get customer's user
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: { user: true },
    })

    if (!customer) {
      return 0
    }

    // Count all domains for user's projects
    const domainsCount = await this.prisma.domain.count({
      where: {
        site: {
          project: {
            userId: customer.userId,
          },
        },
        verified: true, // Only count verified domains
      },
    })

    return domainsCount
  }

  /**
   * Calculate domain-related costs for billing period
   * In the future, this could include:
   * - Premium SSL certificates
   * - Custom domain fees above free tier
   * - DNS query costs
   */
  async calculateDomainCosts({
    customerId,
    periodStart,
    periodEnd,
  }: {
    customerId: string
    periodStart: Date
    periodEnd: Date
  }) {
    const activeDomainsCount = await this.getActiveDomainsCount(customerId)

    // Example pricing structure (can be configured):
    // - First 3 custom domains: Free
    // - Additional domains: $1/month per domain
    const freeDomainTier = 3
    const pricePerDomain = 100 // $1.00 in cents

    const billableDomains = Math.max(0, activeDomainsCount - freeDomainTier)
    const domainCost = billableDomains * pricePerDomain

    return {
      activeDomainsCount,
      billableDomains,
      domainCost, // in cents
      breakdown: {
        freeTier: Math.min(activeDomainsCount, freeDomainTier),
        billable: billableDomains,
        pricePerDomain,
      },
    }
  }
}
