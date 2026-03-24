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
import { createLogger } from '../lib/logger.js'

const log = createLogger('resolver-domain')

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
    log.error(
      { userId, err: error instanceof Error ? error : undefined },
      `Usage tracking failed: ${error instanceof Error ? error.message : 'Unknown error'}`
    )
  }
}

/**
 * Check if a user is authorized to access a domain.
 * Supports both org-level domains (via organizationId) and site-level domains (via site.project.userId).
 */
async function isAuthorizedForDomain(
  domain: any,
  userId: string,
  organizationId: string | undefined,
  prisma: any
): Promise<boolean> {
  if (domain.organizationId) {
    if (organizationId === domain.organizationId) return true
    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: domain.organizationId,
          userId,
        },
      },
    })
    return !!membership
  }
  if (domain.site?.project) {
    return domain.site.project.userId === userId
  }
  return false
}

export const domainQueries = {
  /**
   * Get a single domain by ID
   */
  domain: async (
    _: unknown,
    { id }: { id: string },
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to access this domain')
    }

    return domain
  },

  /**
   * List domains (SDK compatibility wrapper)
   */
  domains: async (
    _: unknown,
    __: unknown,
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const where = organizationId
      ? {
          OR: [
            { organizationId },
            { site: { project: { organizationId } } },
            { site: { project: { userId, organizationId: null } } },
          ],
        }
      : { site: { project: { userId } } }

    const data = await prisma.domain.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    })

    return { data }
  },

  /**
   * Get domain by hostname
   */
  domainByHostname: async (
    _: unknown,
    { hostname }: { hostname: string },
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { hostname },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      return null
    }

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to access this domain')
    }

    return domain
  },

  /**
   * List all domains belonging to an organization
   */
  orgDomains: async (
    _: unknown,
    { orgId }: { orgId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId: orgId, userId },
      },
    })

    if (!membership) {
      throw new GraphQLError('Not a member of this organization')
    }

    return await prisma.domain.findMany({
      where: {
        OR: [
          { organizationId: orgId },
          { site: { project: { organizationId: orgId } } },
        ],
      },
      include: { site: true },
      orderBy: { createdAt: 'desc' },
    })
  },

  /**
   * Get verification instructions for a domain
   */
  domainVerificationInstructions: async (
    _: unknown,
    { domainId }: { domainId: string },
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to access this domain')
    }

    return await getVerificationInstructions(domainId)
  },

  /**
   * Get SSL certificate status for domains the caller owns
   */
  sslCertificateStatus: async (
    _: unknown,
    __: unknown,
    { userId, organizationId, prisma }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    // Build the set of hostnames the caller is authorized to see
    const where = organizationId
      ? {
          OR: [
            { organizationId },
            { site: { project: { organizationId } } },
            { site: { project: { userId, organizationId: null } } },
          ],
        }
      : { site: { project: { userId } } }

    const ownedDomains = await prisma.domain.findMany({
      where,
      select: { hostname: true },
    })
    const ownedHostnames = new Set(ownedDomains.map((d: any) => d.hostname))

    const status = await getSslCertificateStatus()

    return status.filter((item: any) => {
      return item.hostname && ownedHostnames.has(item.hostname)
    })
  },
}

export const domainMutations = {
  /**
   * Create a new custom domain (site-level, legacy)
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
    ).catch(() => {})

    return domain
  },

  /**
   * Create a domain at the organization level (no site required)
   */
  createOrgDomain: async (
    _: unknown,
    {
      input,
    }: {
      input: {
        hostname: string
        orgId: string
        domainType?: string
      }
    },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const membership = await prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: input.orgId,
          userId,
        },
      },
    })

    if (!membership) {
      throw new GraphQLError('Not a member of this organization')
    }

    const existing = await prisma.domain.findUnique({
      where: { hostname: input.hostname },
    })

    if (existing) {
      throw new GraphQLError('Domain hostname already registered')
    }

    const domain = await prisma.domain.create({
      data: {
        hostname: input.hostname,
        organizationId: input.orgId,
        domainType: (input.domainType as any) || 'WEB2',
        verified: false,
        txtVerificationStatus: 'PENDING',
        sslStatus: 'NONE',
      },
    })

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
    ).catch(() => {})

    return domain
  },

  /**
   * Assign an org-level domain to a site
   */
  assignDomainToSite: async (
    _: unknown,
    { domainId, siteId }: { domainId: string; siteId: string },
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    const site = await prisma.site.findUnique({
      where: { id: siteId },
      include: { project: true },
    })

    if (!site) throw new GraphQLError('Site not found')

    return await prisma.domain.update({
      where: { id: domainId },
      data: { siteId },
    })
  },

  /**
   * Verify domain ownership
   */
  verifyDomain: async (
    _: unknown,
    { domainId }: { domainId: string },
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    const verificationResult = await verifyDomainOwnership(domainId)

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
    ).catch(() => {})

    return verificationResult
  },

  /**
   * Provision SSL certificate for verified domain
   */
  provisionSsl: async (
    _: unknown,
    { domainId, email }: { domainId: string; email: string },
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to modify this domain')
    }

    await provisionSslCertificate(domainId, email)

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
    ).catch(() => {})

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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { site: { include: { project: true } } },
    })

    if (!domain) {
      throw new GraphQLError('Domain not found')
    }

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to delete this domain')
    }

    if (domain.siteId) {
      await removeCustomDomain(id)
    } else {
      await prisma.domain.delete({ where: { id } })
    }
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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
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
    { prisma, userId, organizationId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required')

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } },
    })

    if (!domain) throw new GraphQLError('Domain not found')

    if (!(await isAuthorizedForDomain(domain, userId, organizationId, prisma))) {
      throw new GraphQLError('Not authorized to renew SSL for this domain')
    }

    await renewSsl(domainId)

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
    ).catch(() => {})

    return await prisma.domain.findUnique({ where: { id: domainId } })
  },
}
