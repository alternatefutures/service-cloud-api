import { GraphQLError } from 'graphql'
import { Context } from './types.js'
import {
  createCustomDomain,
  getVerificationInstructions,
  verifyDomainOwnership,
  provisionSslCertificate,
  setPrimaryDomain as setPrimary,
  removeCustomDomain,
  listDomainsForSite,
  registerArnsName,
  updateArnsRecord,
  setEnsContentHash,
  publishIpnsRecord,
  updateIpnsRecord,
} from '../services/dns/index.js'
import {
  getSslCertificateStatus,
  renewSslCertificate as renewSsl,
} from '../jobs/sslRenewal.js'
import { DomainUsageTracker } from '../services/billing/domainUsageTracker.js'
import type { PrismaClient } from '@prisma/client'

/**
 * Track domain usage asynchronously without blocking the main operation
 * Returns a promise that can be awaited if needed, but won't throw to parent
 */
async function trackDomainUsageAsync(
  prisma: PrismaClient,
  userId: string,
  trackingFn: (
    tracker: DomainUsageTracker,
    customer: any,
    subscription: any
  ) => Promise<void>
): Promise<void> {
  try {
    const customer = await prisma.customer.findUnique({
      where: { userId },
      include: { subscriptions: { where: { status: 'ACTIVE' }, take: 1 } },
    })

    if (!customer || customer.subscriptions.length === 0) {
      // No active subscription, skip tracking
      return
    }

    const subscription = customer.subscriptions[0]
    const domainUsageTracker = new DomainUsageTracker(prisma)

    await trackingFn(domainUsageTracker, customer, subscription)
  } catch (error) {
    // Log error but don't propagate to avoid blocking domain operations
    console.error(
      '[Domain Usage Tracking]',
      error instanceof Error ? error.message : 'Unknown error',
      {
        userId,
        timestamp: new Date().toISOString(),
      }
    )
  }
}

export const domainQueries = {
  /**
   * Get a single domain by ID
   */
  domain: async (
    _: unknown,
    { id }: { id: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    // Check ownership
    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to access this domain')
    }

    return domain
  },

  /**
   * List domains for a site
   */
  domains: async (
    _: unknown,
    { siteId }: { siteId?: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    if (siteId) {
      // Check site ownership
      const site = await prisma.site.findUnique({
        where: { id: siteId },
        include: { project: true },
      })

      if (!site) {
        throw new GraphQLError('Site not found')
      }

      if (site.project.userId !== userId) {
        throw new GraphQLError('Not authorized to access this site')
      }

      return await listDomainsForSite(siteId)
    }

    // Return all domains for user
    return await prisma.domain.findMany({
      where: {
        site: {
          project: {
            userId,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * Get domain by hostname
   */
  domainByHostname: async (
    _: unknown,
    { hostname }: { hostname: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { hostname },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      return null
    }

    // Check ownership
    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to access this domain')
    }

    return domain
  },

  /**
   * Get verification instructions for a domain
   */
  domainVerificationInstructions: async (
    _: unknown,
    { domainId }: { domainId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    // Check ownership
    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to access this domain')
    }

    return await getVerificationInstructions(domainId)
  },

  /**
   * Get SSL certificate status for all domains
   */
  sslCertificateStatus: async (
    _: unknown,
    __: unknown,
    { userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const status = await getSslCertificateStatus()

    // Filter to only domains owned by the user
    // Note: This query should be optimized with a WHERE clause in production
    return status.filter((item: any) => {
      // Add userId check when we fetch domains with user relationships
      return true // For now, return all (add proper filtering in production)
    })
  },
}

export const domainMutations = {
  /**
   * Create a new custom domain
   */
  createDomain: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        hostname: string
        siteId: string
        domainType?: string
        verificationMethod?: 'TXT' | 'CNAME' | 'A'
      }
    },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    // Verify user owns the site
    const site = await prisma.site.findUnique({
      where: { id: input.siteId },
      include: { project: true },
    })

    if (!site) {
      throw new GraphQLError('Site not found')
    }

    if (site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this site')
    }

    // Create domain
    const domain = await createCustomDomain({
      hostname: input.hostname,
      siteId: input.siteId,
      domainType: input.domainType as
        | 'WEB2'
        | 'ARNS'
        | 'ENS'
        | 'IPNS'
        | undefined,
      verificationMethod: input.verificationMethod,
    })

    // Track usage asynchronously (fire-and-forget) to avoid blocking domain creation
    trackDomainUsageAsync(
      prisma,
      userId,
      async (tracker, customer, subscription) => {
        await tracker.trackDomainCreation({
          customerId: customer.id,
          domainId: domain.id,
          hostname: input.hostname,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
        })
      }
    ).catch(() => {}) // Fire and forget

    return domain
  },

  /**
   * Verify domain ownership
   */
  verifyDomain: async (
    _: unknown,
    { domainId }: { domainId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    const verificationResult = await verifyDomainOwnership(domainId)

    // Track verification attempt asynchronously
    trackDomainUsageAsync(
      prisma,
      userId,
      async (tracker, customer, subscription) => {
        await tracker.trackDomainVerification({
          customerId: customer.id,
          domainId,
          hostname: domain.hostname,
          verificationMethod: (domain.txtVerificationToken
            ? 'TXT'
            : domain.expectedCname
              ? 'CNAME'
              : 'A') as 'TXT' | 'CNAME' | 'A',
          success: verificationResult,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
        })
      }
    ).catch(() => {}) // Fire and forget

    return verificationResult
  },

  /**
   * Provision SSL certificate for verified domain
   */
  provisionSsl: async (
    _: unknown,
    { domainId, email }: { domainId: string; email: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await provisionSslCertificate(domainId, email)

    // Track SSL provisioning asynchronously
    trackDomainUsageAsync(
      prisma,
      userId,
      async (tracker, customer, subscription) => {
        await tracker.trackSslProvisioning({
          customerId: customer.id,
          domainId,
          hostname: domain.hostname,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          isRenewal: false,
        })
      }
    ).catch(() => {}) // Fire and forget

    // Return updated domain
    return await prisma.domain.findUnique({
      where: { id: domainId },
    })
  },

  /**
   * Set primary domain for a site
   */
  setPrimaryDomain: async (
    _: unknown,
    { siteId, domainId }: { siteId: string; domainId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const site = await prisma.site.findUnique({
      where: { id: siteId },
      include: { project: true },
    })

    if (!site) {
      throw new GraphQLError('Site not found')
    }

    if (site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this site')
    }

    await setPrimary(siteId, domainId)
    return true
  },

  /**
   * Delete a custom domain
   */
  deleteDomain: async (
    _: unknown,
    { id }: { id: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to delete this domain')
    }

    await removeCustomDomain(id)
    return true
  },

  /**
   * Register ArNS name for Arweave domain
   */
  registerArns: async (
    _: unknown,
    {
      domainId,
      arnsName,
      contentId,
    }: { domainId: string; arnsName: string; contentId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await registerArnsName(domainId, arnsName, contentId, {})

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },

  /**
   * Update ArNS content
   */
  updateArnsContent: async (
    _: unknown,
    { domainId, contentId }: { domainId: string; contentId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await updateArnsRecord(domainId, contentId, {})

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },

  /**
   * Set ENS content hash
   */
  setEnsContentHash: async (
    _: unknown,
    {
      domainId,
      ensName,
      contentHash,
    }: { domainId: string; ensName: string; contentHash: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await setEnsContentHash(domainId, ensName, contentHash, {})

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },

  /**
   * Publish IPNS record
   */
  publishIpns: async (
    _: unknown,
    { domainId, cid }: { domainId: string; cid: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await publishIpnsRecord(domainId, cid, {})

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },

  /**
   * Update IPNS record
   */
  updateIpns: async (
    _: unknown,
    { domainId, cid }: { domainId: string; cid: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await updateIpnsRecord(domainId, cid, {})

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },

  /**
   * Manually renew SSL certificate
   */
  renewSslCertificate: async (
    _: unknown,
    { domainId }: { domainId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to renew SSL for this domain')
    }

    await renewSsl(domainId)

    // Track SSL renewal asynchronously
    trackDomainUsageAsync(
      prisma,
      userId,
      async (tracker, customer, subscription) => {
        await tracker.trackSslProvisioning({
          customerId: customer.id,
          domainId,
          hostname: domain.hostname,
          periodStart: subscription.currentPeriodStart,
          periodEnd: subscription.currentPeriodEnd,
          isRenewal: true,
        })
      }
    ).catch(() => {}) // Fire and forget

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },
}
