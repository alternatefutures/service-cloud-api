import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GraphQLError } from 'graphql';
import { domainQueries, domainMutations } from './domain';
import type { Context } from './types';
import * as domainService from '../services/dns/domainService';
import * as arnsIntegration from '../services/dns/arnsIntegration';
import * as ensIntegration from '../services/dns/ensIntegration';
import * as ipnsIntegration from '../services/dns/ipnsIntegration';

// Mock domain service and Web3 integrations
vi.mock('../services/dns/domainService');
vi.mock('../services/dns/arnsIntegration');
vi.mock('../services/dns/ensIntegration');
vi.mock('../services/dns/ipnsIntegration');

const mockContext: Context = {
  userId: 'user-123',
  projectId: 'project-123',
  prisma: {
    domain: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn()
    },
    site: {
      findUnique: vi.fn()
    },
    customer: {
      findUnique: vi.fn()
    },
    $transaction: vi.fn(async (callback) => {
      // Execute the callback with the mock prisma as the transaction
      const result = await callback(mockContext.prisma);
      return result;
    })
  } as any
};

describe('Domain Resolvers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Queries', () => {
    describe('domain', () => {
      it('should return domain for authorized user', async () => {
        const mockDomain = {
          id: 'domain-123',
          hostname: 'example.com',
          site: {
            project: {
              userId: 'user-123'
            }
          }
        };

        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue(mockDomain);

        const result = await domainQueries.domain({}, { id: 'domain-123' }, mockContext);

        expect(result).toEqual(mockDomain);
      });

      it('should throw error if user not authenticated', async () => {
        const unauthContext = { ...mockContext, userId: null };

        await expect(
          domainQueries.domain({}, { id: 'domain-123' }, unauthContext)
        ).rejects.toThrow('Authentication required');
      });

      it('should throw error if user not authorized', async () => {
        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue({
          id: 'domain-123',
          site: {
            project: {
              userId: 'other-user'
            }
          }
        });

        await expect(
          domainQueries.domain({}, { id: 'domain-123' }, mockContext)
        ).rejects.toThrow('Not authorized');
      });

      it('should throw error if domain not found', async () => {
        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue(null);

        await expect(
          domainQueries.domain({}, { id: 'nonexistent' }, mockContext)
        ).rejects.toThrow('not found');
      });
    });

    describe('domains', () => {
      it('should list domains for site', async () => {
        const mockSite = {
          id: 'site-123',
          project: {
            userId: 'user-123'
          }
        };

        const mockDomains = [
          { id: 'domain-1', hostname: 'example.com' },
          { id: 'domain-2', hostname: 'www.example.com' }
        ];

        mockContext.prisma.site.findUnique = vi.fn().mockResolvedValue(mockSite);
        vi.mocked(domainService.listDomainsForSite).mockResolvedValue(mockDomains as any);

        const result = await domainQueries.domains({}, { siteId: 'site-123' }, mockContext);

        expect(result).toHaveLength(2);
      });

      it('should list all domains for user if no siteId', async () => {
        const mockDomains = [
          { id: 'domain-1', hostname: 'example.com' },
          { id: 'domain-2', hostname: 'test.com' }
        ];

        mockContext.prisma.domain.findMany = vi.fn().mockResolvedValue(mockDomains);

        const result = await domainQueries.domains({}, {}, mockContext);

        expect(result).toHaveLength(2);
      });
    });

    describe('domainVerificationInstructions', () => {
      it('should return verification instructions for authorized user', async () => {
        const mockDomain = {
          id: 'domain-123',
          site: {
            project: {
              userId: 'user-123'
            }
          }
        };

        const mockInstructions = {
          method: 'TXT',
          recordType: 'TXT',
          hostname: 'example.com',
          value: 'af-site-verification=abc123',
          instructions: 'Add TXT record...'
        };

        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue(mockDomain);
        vi.mocked(domainService.getVerificationInstructions).mockResolvedValue(mockInstructions);

        const result = await domainQueries.domainVerificationInstructions(
          {},
          { domainId: 'domain-123' },
          mockContext
        );

        expect(result.method).toBe('TXT');
        expect(result.value).toBe('af-site-verification=abc123');
      });
    });
  });

  describe('Mutations', () => {
    describe('createDomain', () => {
      it('should create domain for authorized user', async () => {
        const mockSite = {
          id: 'site-123',
          project: {
            userId: 'user-123'
          }
        };

        const mockDomain = {
          id: 'domain-123',
          hostname: 'example.com',
          siteId: 'site-123'
        };

        mockContext.prisma.site.findUnique = vi.fn().mockResolvedValue(mockSite);
        vi.mocked(domainService.createCustomDomain).mockResolvedValue(mockDomain as any);

        const result = await domainMutations.createDomain(
          {},
          {
            input: {
              hostname: 'example.com',
              siteId: 'site-123',
              domainType: 'WEB2',
              verificationMethod: 'TXT'
            }
          },
          mockContext
        );

        expect(result.hostname).toBe('example.com');
      });

      it('should throw error if site not found', async () => {
        mockContext.prisma.site.findUnique = vi.fn().mockResolvedValue(null);

        await expect(
          domainMutations.createDomain(
            {},
            {
              input: {
                hostname: 'example.com',
                siteId: 'nonexistent'
              }
            },
            mockContext
          )
        ).rejects.toThrow('Site not found');
      });

      it('should throw error if user not authorized for site', async () => {
        mockContext.prisma.site.findUnique = vi.fn().mockResolvedValue({
          id: 'site-123',
          project: {
            userId: 'other-user'
          }
        });

        await expect(
          domainMutations.createDomain(
            {},
            {
              input: {
                hostname: 'example.com',
                siteId: 'site-123'
              }
            },
            mockContext
          )
        ).rejects.toThrow('Not authorized');
      });
    });

    describe('verifyDomain', () => {
      it('should verify domain for authorized user', async () => {
        const mockDomain = {
          id: 'domain-123',
          site: {
            project: {
              userId: 'user-123'
            }
          }
        };

        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue(mockDomain);
        vi.mocked(domainService.verifyDomainOwnership).mockResolvedValue(true);

        const result = await domainMutations.verifyDomain({}, { domainId: 'domain-123' }, mockContext);

        expect(result).toBe(true);
      });

      it('should return false if verification fails', async () => {
        const mockDomain = {
          id: 'domain-123',
          site: {
            project: {
              userId: 'user-123'
            }
          }
        };

        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue(mockDomain);
        vi.mocked(domainService.verifyDomainOwnership).mockResolvedValue(false);

        const result = await domainMutations.verifyDomain({}, { domainId: 'domain-123' }, mockContext);

        expect(result).toBe(false);
      });
    });

    describe('provisionSsl', () => {
      it('should provision SSL for authorized user', async () => {
        const mockDomain = {
          id: 'domain-123',
          hostname: 'example.com',
          site: {
            project: {
              userId: 'user-123'
            }
          }
        };

        const updatedDomain = {
          ...mockDomain,
          sslStatus: 'ACTIVE'
        };

        mockContext.prisma.domain.findUnique = vi.fn()
          .mockResolvedValueOnce(mockDomain)
          .mockResolvedValueOnce(updatedDomain);

        vi.mocked(domainService.provisionSslCertificate).mockResolvedValue();

        const result = await domainMutations.provisionSsl(
          {},
          { domainId: 'domain-123', email: 'admin@example.com' },
          mockContext
        );

        expect(result.sslStatus).toBe('ACTIVE');
      });
    });

    describe('setPrimaryDomain', () => {
      it('should set primary domain for authorized user', async () => {
        const mockSite = {
          id: 'site-123',
          project: {
            userId: 'user-123'
          }
        };

        mockContext.prisma.site.findUnique = vi.fn().mockResolvedValue(mockSite);
        vi.mocked(domainService.setPrimaryDomain).mockResolvedValue();

        const result = await domainMutations.setPrimaryDomain(
          {},
          { siteId: 'site-123', domainId: 'domain-123' },
          mockContext
        );

        expect(result).toBe(true);
      });
    });

    describe('deleteDomain', () => {
      it('should delete domain for authorized user', async () => {
        const mockDomain = {
          id: 'domain-123',
          site: {
            project: {
              userId: 'user-123'
            }
          }
        };

        mockContext.prisma.domain.findUnique = vi.fn().mockResolvedValue(mockDomain);
        vi.mocked(domainService.removeCustomDomain).mockResolvedValue();

        const result = await domainMutations.deleteDomain({}, { id: 'domain-123' }, mockContext);

        expect(result).toBe(true);
      });
    });

    describe('Web3 Domains', () => {
      describe('registerArns', () => {
        it('should register ArNS for authorized user', async () => {
          const mockDomain = {
            id: 'domain-123',
            site: {
              project: {
                userId: 'user-123'
              }
            }
          };

          const updatedDomain = {
            ...mockDomain,
            arnsName: 'my-site',
            domainType: 'ARNS'
          };

          mockContext.prisma.domain.findUnique = vi.fn()
            .mockResolvedValueOnce(mockDomain)
            .mockResolvedValueOnce(updatedDomain);

          vi.mocked(arnsIntegration.registerArnsName).mockResolvedValue({
            name: 'my-site',
            transactionId: 'tx-123',
            contentId: 'ar-content-123'
          });

          const result = await domainMutations.registerArns(
            {},
            { domainId: 'domain-123', arnsName: 'my-site', contentId: 'tx-123' },
            mockContext
          );

          expect(result.arnsName).toBe('my-site');
        });
      });

      describe('setEnsContentHash', () => {
        it('should set ENS content hash for authorized user', async () => {
          const mockDomain = {
            id: 'domain-123',
            site: {
              project: {
                userId: 'user-123'
              }
            }
          };

          const updatedDomain = {
            ...mockDomain,
            ensName: 'mysite.eth',
            ensContentHash: 'ipfs://Qm...',
            domainType: 'ENS'
          };

          mockContext.prisma.domain.findUnique = vi.fn()
            .mockResolvedValueOnce(mockDomain)
            .mockResolvedValueOnce(updatedDomain);

          vi.mocked(ensIntegration.setEnsContentHash).mockResolvedValue({
            ensName: 'mysite.eth',
            contentHash: 'ipfs://Qm...',
            owner: '0x123',
            resolver: '0x456'
          });

          const result = await domainMutations.setEnsContentHash(
            {},
            { domainId: 'domain-123', ensName: 'mysite.eth', contentHash: 'ipfs://Qm...' },
            mockContext
          );

          expect(result.ensName).toBe('mysite.eth');
        });
      });

      describe('publishIpns', () => {
        it('should publish IPNS record for authorized user', async () => {
          const mockDomain = {
            id: 'domain-123',
            site: {
              project: {
                userId: 'user-123'
              }
            }
          };

          const updatedDomain = {
            ...mockDomain,
            ipnsHash: 'k51...',
            domainType: 'IPNS'
          };

          mockContext.prisma.domain.findUnique = vi.fn()
            .mockResolvedValueOnce(mockDomain)
            .mockResolvedValueOnce(updatedDomain);

          vi.mocked(ipnsIntegration.publishIpnsRecord).mockResolvedValue({
            ipnsHash: 'k51...',
            currentCid: 'QmABC123',
            lifetime: '24h',
            ttl: '1h'
          });

          const result = await domainMutations.publishIpns(
            {},
            { domainId: 'domain-123', cid: 'QmABC123' },
            mockContext
          );

          expect(result.ipnsHash).toBeDefined();
        });
      });
    });
  });
});
