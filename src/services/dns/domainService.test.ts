import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as dnsVerification from './dnsVerification';
import * as sslCertificate from './sslCertificate';

// Mock dependencies
vi.mock('./dnsVerification');
vi.mock('./sslCertificate');

// Mock PrismaClient globally
vi.mock('@prisma/client', () => {
  // Create mocks inside the factory function
  const mockDomain = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn()
  };

  const mockSite = {
    findUnique: vi.fn(),
    update: vi.fn()
  };

  return {
    PrismaClient: class MockPrismaClient {
      domain = mockDomain;
      site = mockSite;
    },
    __mockDomain: mockDomain,
    __mockSite: mockSite
  };
});

// Import after mocking to get the mocks
import { PrismaClient } from '@prisma/client';
const mockDomain = (PrismaClient as any).__mockDomain;
const mockSite = (PrismaClient as any).__mockSite;

// Import domainService after mocking PrismaClient
import {
  createCustomDomain,
  getVerificationInstructions,
  verifyDomainOwnership,
  provisionSslCertificate,
  setPrimaryDomain,
  removeCustomDomain,
  listDomainsForSite
} from './domainService';

describe('Domain Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createCustomDomain', () => {
    it('should create domain with TXT verification', async () => {
      const input = {
        hostname: 'example.com',
        siteId: 'site-123',
        domainType: 'WEB2' as const,
        verificationMethod: 'TXT' as const
      };

      mockDomain.findUnique.mockResolvedValue(null);
      mockDomain.create.mockResolvedValue({
        id: 'domain-123',
        ...input,
        txtVerificationToken: 'af-site-verification=abc123'
      } as any);

      vi.mocked(dnsVerification.generateVerificationToken).mockReturnValue('af-site-verification=abc123');

      const result = await createCustomDomain(input);

      expect(result.hostname).toBe('example.com');
      expect(result.txtVerificationToken).toBeDefined();
      expect(mockDomain.create).toHaveBeenCalled();
    });

    it('should throw error if domain already exists', async () => {
      const input = {
        hostname: 'example.com',
        siteId: 'site-123'
      };

      mockDomain.findUnique = vi.fn().mockResolvedValue({ id: 'existing-domain' });

      await expect(createCustomDomain(input)).rejects.toThrow('already registered');
    });

    it('should create domain with CNAME verification', async () => {
      const input = {
        hostname: 'www.example.com',
        siteId: 'site-123',
        verificationMethod: 'CNAME' as const
      };

      mockDomain.findUnique = vi.fn().mockResolvedValue(null);
      mockDomain.create = vi.fn().mockResolvedValue({
        id: 'domain-123',
        ...input,
        expectedCname: 'cname.alternatefutures.ai'
      });

      vi.mocked(dnsVerification.getPlatformCnameTarget).mockReturnValue('cname.alternatefutures.ai');

      const result = await createCustomDomain(input);

      expect(result.expectedCname).toBe('cname.alternatefutures.ai');
    });

    it('should create domain with A record verification', async () => {
      const input = {
        hostname: 'example.com',
        siteId: 'site-123',
        verificationMethod: 'A' as const
      };

      mockDomain.findUnique = vi.fn().mockResolvedValue(null);
      mockDomain.create = vi.fn().mockResolvedValue({
        id: 'domain-123',
        ...input,
        expectedARecord: '192.0.2.1'
      });

      vi.mocked(dnsVerification.getPlatformIpAddress).mockReturnValue('192.0.2.1');

      const result = await createCustomDomain(input);

      expect(result.expectedARecord).toBe('192.0.2.1');
    });
  });

  describe('getVerificationInstructions', () => {
    it('should return TXT record instructions', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        txtVerificationToken: 'af-site-verification=abc123'
      });

      const instructions = await getVerificationInstructions('domain-123');

      expect(instructions.method).toBe('TXT');
      expect(instructions.value).toBe('af-site-verification=abc123');
      expect(instructions.instructions).toContain('TXT record');
    });

    it('should return CNAME instructions', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'www.example.com',
        expectedCname: 'cname.alternatefutures.ai'
      });

      const instructions = await getVerificationInstructions('domain-123');

      expect(instructions.method).toBe('CNAME');
      expect(instructions.value).toBe('cname.alternatefutures.ai');
    });

    it('should return A record instructions', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        expectedARecord: '192.0.2.1'
      });

      const instructions = await getVerificationInstructions('domain-123');

      expect(instructions.method).toBe('A');
      expect(instructions.value).toBe('192.0.2.1');
    });

    it('should throw error if domain not found', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue(null);

      await expect(getVerificationInstructions('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('verifyDomainOwnership', () => {
    it('should verify domain via TXT record', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        txtVerificationToken: 'af-site-verification=abc123'
      });

      mockDomain.update = vi.fn().mockResolvedValue({});

      vi.mocked(dnsVerification.verifyTxtRecord).mockResolvedValue({
        verified: true,
        record: 'af-site-verification=abc123'
      });

      const result = await verifyDomainOwnership('domain-123');

      expect(result).toBe(true);
      expect(mockDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verified: true,
            txtVerificationStatus: 'VERIFIED'
          })
        })
      );
    });

    it('should fail verification if TXT record not found', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        txtVerificationToken: 'af-site-verification=abc123'
      });

      mockDomain.update = vi.fn().mockResolvedValue({});

      vi.mocked(dnsVerification.verifyTxtRecord).mockResolvedValue({
        verified: false,
        error: 'Record not found'
      });

      const result = await verifyDomainOwnership('domain-123');

      expect(result).toBe(false);
      expect(mockDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            txtVerificationStatus: 'FAILED'
          })
        })
      );
    });

    it('should increment DNS check attempts', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        txtVerificationToken: 'af-site-verification=abc123',
        dnsCheckAttempts: 3
      });

      mockDomain.update = vi.fn().mockResolvedValue({});

      vi.mocked(dnsVerification.verifyTxtRecord).mockResolvedValue({
        verified: false
      });

      await verifyDomainOwnership('domain-123');

      expect(mockDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            dnsCheckAttempts: { increment: 1 }
          })
        })
      );
    });
  });

  describe('provisionSslCertificate', () => {
    it('should provision SSL for verified domain', async () => {
      mockDomain.findUnique = vi.fn()
        .mockResolvedValueOnce({
          id: 'domain-123',
          hostname: 'example.com',
          verified: true
        })
        .mockResolvedValueOnce({
          id: 'domain-123',
          sslStatus: 'ACTIVE'
        });

      mockDomain.update = vi.fn().mockResolvedValue({});

      vi.mocked(sslCertificate.requestSslCertificate).mockResolvedValue({
        certificateId: 'cert-123',
        certificate: 'cert-data',
        privateKey: 'key-data',
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      });

      await provisionSslCertificate('domain-123', 'admin@example.com');

      expect(mockDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sslStatus: 'ACTIVE'
          })
        })
      );
    });

    it('should throw error if domain not verified', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        verified: false
      });

      await expect(provisionSslCertificate('domain-123', 'admin@example.com')).rejects.toThrow('must be verified');
    });

    it('should update status to FAILED on error', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        hostname: 'example.com',
        verified: true
      });

      mockDomain.update = vi.fn().mockResolvedValue({});

      vi.mocked(sslCertificate.requestSslCertificate).mockRejectedValue(new Error('ACME error'));

      await expect(provisionSslCertificate('domain-123', 'admin@example.com')).rejects.toThrow();

      expect(mockDomain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { sslStatus: 'FAILED' }
        })
      );
    });
  });

  describe('setPrimaryDomain', () => {
    it('should set verified domain as primary', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        siteId: 'site-123',
        verified: true
      });

      mockSite.update = vi.fn().mockResolvedValue({});

      await setPrimaryDomain('site-123', 'domain-123');

      expect(mockSite.update).toHaveBeenCalledWith({
        where: { id: 'site-123' },
        data: { primaryDomainId: 'domain-123' }
      });
    });

    it('should throw error if domain not verified', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        siteId: 'site-123',
        verified: false
      });

      await expect(setPrimaryDomain('site-123', 'domain-123')).rejects.toThrow('verified domains');
    });

    it('should throw error if domain belongs to different site', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        siteId: 'site-456',
        verified: true
      });

      await expect(setPrimaryDomain('site-123', 'domain-123')).rejects.toThrow('does not belong');
    });
  });

  describe('removeCustomDomain', () => {
    it('should remove non-primary domain', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        primarySite: []
      });

      mockDomain.delete = vi.fn().mockResolvedValue({});

      await removeCustomDomain('domain-123');

      expect(mockDomain.delete).toHaveBeenCalledWith({
        where: { id: 'domain-123' }
      });
    });

    it('should throw error if removing primary domain', async () => {
      mockDomain.findUnique = vi.fn().mockResolvedValue({
        id: 'domain-123',
        primarySite: [{ id: 'site-123' }]
      });

      await expect(removeCustomDomain('domain-123')).rejects.toThrow('Cannot remove primary domain');
    });
  });

  describe('listDomainsForSite', () => {
    it('should list all domains for site', async () => {
      const domains = [
        { id: 'domain-1', hostname: 'example.com' },
        { id: 'domain-2', hostname: 'www.example.com' }
      ];

      mockDomain.findMany = vi.fn().mockResolvedValue(domains);

      const result = await listDomainsForSite('site-123');

      expect(result).toHaveLength(2);
      expect(mockDomain.findMany).toHaveBeenCalledWith({
        where: { siteId: 'site-123' },
        orderBy: { createdAt: 'desc' }
      });
    });
  });
});
