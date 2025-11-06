import { GraphQLError } from 'graphql';
import { Context } from './types';
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
  updateIpnsRecord
} from '../services/dns';

export const domainQueries = {
  /**
   * Get a single domain by ID
   */
  domain: async (_: unknown, { id }: { id: string }, { prisma, userId }: Context) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    // Check ownership
    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to access this domain');
    }

    return domain;
  },

  /**
   * List domains for a site
   */
  domains: async (_: unknown, { siteId }: { siteId?: string }, { prisma, userId }: Context) => {
    if (!userId) throw new GraphQLError('Authentication required');

    if (siteId) {
      // Check site ownership
      const site = await prisma.site.findUnique({
        where: { id: siteId },
        include: { project: true }
      });

      if (!site) {
        throw new GraphQLError('Site not found');
      }

      if (site.project.userId !== userId) {
        throw new GraphQLError('Not authorized to access this site');
      }

      return await listDomainsForSite(siteId);
    }

    // Return all domains for user
    return await prisma.domain.findMany({
      where: {
        site: {
          project: {
            userId
          }
        }
      },
      orderBy: { createdAt: 'desc' }
    });
  },

  /**
   * Get domain by hostname
   */
  domainByHostname: async (_: unknown, { hostname }: { hostname: string }, { prisma, userId }: Context) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { hostname },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      return null;
    }

    // Check ownership
    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to access this domain');
    }

    return domain;
  },

  /**
   * Get verification instructions for a domain
   */
  domainVerificationInstructions: async (_: unknown, { domainId }: { domainId: string }, { prisma, userId }: Context) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    // Check ownership
    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to access this domain');
    }

    return await getVerificationInstructions(domainId);
  }
};

export const domainMutations = {
  /**
   * Create a new custom domain
   */
  createDomain: async (
    _: unknown,
    { input }: { input: { hostname: string; siteId: string; domainType?: string; verificationMethod?: 'TXT' | 'CNAME' | 'A' } },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    // Verify user owns the site
    const site = await prisma.site.findUnique({
      where: { id: input.siteId },
      include: { project: true }
    });

    if (!site) {
      throw new GraphQLError('Site not found');
    }

    if (site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this site');
    }

    return await createCustomDomain({
      hostname: input.hostname,
      siteId: input.siteId,
      domainType: input.domainType as any,
      verificationMethod: input.verificationMethod
    });
  },

  /**
   * Verify domain ownership
   */
  verifyDomain: async (_: unknown, { domainId }: { domainId: string }, { prisma, userId }: Context) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    return await verifyDomainOwnership(domainId);
  },

  /**
   * Provision SSL certificate for verified domain
   */
  provisionSsl: async (
    _: unknown,
    { domainId, email }: { domainId: string; email: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    await provisionSslCertificate(domainId, email);

    // Return updated domain
    return await prisma.domain.findUnique({
      where: { id: domainId }
    });
  },

  /**
   * Set primary domain for a site
   */
  setPrimaryDomain: async (
    _: unknown,
    { siteId, domainId }: { siteId: string; domainId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const site = await prisma.site.findUnique({
      where: { id: siteId },
      include: { project: true }
    });

    if (!site) {
      throw new GraphQLError('Site not found');
    }

    if (site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this site');
    }

    await setPrimary(siteId, domainId);
    return true;
  },

  /**
   * Delete a custom domain
   */
  deleteDomain: async (_: unknown, { id }: { id: string }, { prisma, userId }: Context) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to delete this domain');
    }

    await removeCustomDomain(id);
    return true;
  },

  /**
   * Register ArNS name for Arweave domain
   */
  registerArns: async (
    _: unknown,
    { domainId, arnsName, contentId }: { domainId: string; arnsName: string; contentId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    await registerArnsName(domainId, arnsName, contentId, {});

    return await prisma.domain.findUnique({ where: { id: domainId } });
  },

  /**
   * Update ArNS content
   */
  updateArnsContent: async (
    _: unknown,
    { domainId, contentId }: { domainId: string; contentId: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    await updateArnsRecord(domainId, contentId, {});

    return await prisma.domain.findUnique({ where: { id: domainId } });
  },

  /**
   * Set ENS content hash
   */
  setEnsContentHash: async (
    _: unknown,
    { domainId, ensName, contentHash }: { domainId: string; ensName: string; contentHash: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    await setEnsContentHash(domainId, ensName, contentHash, {});

    return await prisma.domain.findUnique({ where: { id: domainId } });
  },

  /**
   * Publish IPNS record
   */
  publishIpns: async (
    _: unknown,
    { domainId, cid }: { domainId: string; cid: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    await publishIpnsRecord(domainId, cid, {});

    return await prisma.domain.findUnique({ where: { id: domainId } });
  },

  /**
   * Update IPNS record
   */
  updateIpns: async (
    _: unknown,
    { domainId, cid }: { domainId: string; cid: string },
    { prisma, userId }: Context
  ) => {
    if (!userId) throw new GraphQLError('Authentication required');

    const domain = await prisma.domain.findUnique({
      where: { id: domainId },
      include: { site: { include: { project: true } } }
    });

    if (!domain) {
      throw new GraphQLError('Domain not found');
    }

    if (domain.site.project.userId !== userId) {
      throw new GraphQLError('Not authorized to modify this domain');
    }

    await updateIpnsRecord(domainId, cid, {});

    return await prisma.domain.findUnique({ where: { id: domainId } });
  }
};
