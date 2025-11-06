import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAcmeClient,
  requestSslCertificate,
  requestWildcardCertificate,
  shouldRenewCertificate
} from './sslCertificate';

// Mock acme-client
vi.mock('acme-client', () => {
  const mockCreatePrivateKey = vi.fn();
  const mockCreateCsr = vi.fn();
  const mockReadCertificateInfo = vi.fn();
  const mockGetDnsChallenge = vi.fn();

  let clientInstance: any = null;

  class MockClient {
    constructor() {
      return clientInstance;
    }
  }

  const directory = {
    letsencrypt: {
      production: 'https://acme-v02.api.letsencrypt.org/directory',
      staging: 'https://acme-staging-v02.api.letsencrypt.org/directory'
    }
  };

  const crypto = {
    createPrivateKey: mockCreatePrivateKey,
    createCsr: mockCreateCsr,
    readCertificateInfo: mockReadCertificateInfo,
    getDnsChallenge: mockGetDnsChallenge
  };

  return {
    default: {
      directory,
      crypto,
      Client: MockClient
    },
    directory,
    crypto,
    Client: MockClient,
    __mockCreatePrivateKey: mockCreatePrivateKey,
    __mockCreateCsr: mockCreateCsr,
    __mockReadCertificateInfo: mockReadCertificateInfo,
    __mockGetDnsChallenge: mockGetDnsChallenge,
    __setClientInstance: (instance: any) => { clientInstance = instance; }
  };
});

// Import after mocking
import * as acme from 'acme-client';
const mockCreatePrivateKey = (acme as any).__mockCreatePrivateKey;
const mockCreateCsr = (acme as any).__mockCreateCsr;
const mockReadCertificateInfo = (acme as any).__mockReadCertificateInfo;
const mockGetDnsChallenge = (acme as any).__mockGetDnsChallenge;
const setClientInstance = (acme as any).__setClientInstance;

describe('SSL Certificate Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createAcmeClient', () => {
    it('should create ACME client with production directory', async () => {
      const mockKey = Buffer.from('test-key');
      const mockInstance = { auto: vi.fn() };

      mockCreatePrivateKey.mockResolvedValue(mockKey as any);
      setClientInstance(mockInstance);

      const client = await createAcmeClient({ email: 'admin@example.com' });

      expect(client).toBe(mockInstance);
    });

    it('should use custom directory URL if provided', async () => {
      const mockKey = Buffer.from('test-key');
      const mockInstance = { auto: vi.fn() };
      const customUrl = 'https://custom-acme.example.com/directory';

      mockCreatePrivateKey.mockResolvedValue(mockKey as any);
      setClientInstance(mockInstance);

      const client = await createAcmeClient({
        email: 'admin@example.com',
        directoryUrl: customUrl
      });

      expect(client).toBe(mockInstance);
    });

    it('should use provided account key', async () => {
      const customKey = Buffer.from('custom-account-key');
      const mockInstance = { auto: vi.fn() };

      setClientInstance(mockInstance);

      const client = await createAcmeClient({
        email: 'admin@example.com',
        accountKey: customKey
      });

      expect(mockCreatePrivateKey).not.toHaveBeenCalled();
      expect(client).toBe(mockInstance);
    });
  });

  describe('requestSslCertificate', () => {
    it('should request SSL certificate successfully', async () => {
      const mockKey = Buffer.from('private-key');
      const mockCsr = Buffer.from('csr');
      const mockCert = Buffer.from('certificate');
      const mockAcmeClientInstance = {
        auto: vi.fn().mockResolvedValue(mockCert)
      };

      const issuedAt = new Date('2024-01-01');
      const expiresAt = new Date('2024-04-01');

      mockCreatePrivateKey.mockResolvedValue(Buffer.from('account-key') as any);
      mockCreateCsr.mockResolvedValue([mockKey, mockCsr] as any);
      setClientInstance(mockAcmeClientInstance);
      mockReadCertificateInfo.mockResolvedValue({
        serial: 'cert-12345',
        notBefore: issuedAt,
        notAfter: expiresAt
      } as any);

      const result = await requestSslCertificate('example.com', 'admin@example.com');

      expect(result).toEqual({
        certificateId: 'cert-12345',
        certificate: mockCert.toString(),
        privateKey: mockKey.toString(),
        issuedAt,
        expiresAt
      });

      expect(mockCreateCsr).toHaveBeenCalledWith({
        commonName: 'example.com'
      });

      expect(mockAcmeClientInstance.auto).toHaveBeenCalledWith({
        csr: mockCsr,
        email: 'admin@example.com',
        termsOfServiceAgreed: true,
        challengeCreateFn: expect.any(Function),
        challengeRemoveFn: expect.any(Function)
      });
    });

    it('should throw error on certificate request failure', async () => {
      mockCreatePrivateKey.mockResolvedValue(Buffer.from('key') as any);
      mockCreateCsr.mockResolvedValue([Buffer.from('key'), Buffer.from('csr')] as any);

      const mockAcmeClientInstance = {
        auto: vi.fn().mockRejectedValue(new Error('ACME error'))
      };
      setClientInstance(mockAcmeClientInstance);

      await expect(
        requestSslCertificate('example.com', 'admin@example.com')
      ).rejects.toThrow('SSL certificate request failed: ACME error');
    });
  });

  describe('requestWildcardCertificate', () => {
    it('should request wildcard certificate', async () => {
      const mockKey = Buffer.from('private-key');
      const mockCsr = Buffer.from('csr');
      const mockCert = Buffer.from('wildcard-certificate');
      const mockAcmeClientInstance = {
        auto: vi.fn().mockResolvedValue(mockCert)
      };

      const issuedAt = new Date('2024-01-01');
      const expiresAt = new Date('2024-04-01');

      mockCreatePrivateKey.mockResolvedValue(Buffer.from('account-key') as any);
      mockCreateCsr.mockResolvedValue([mockKey, mockCsr] as any);
      setClientInstance(mockAcmeClientInstance);
      mockReadCertificateInfo.mockResolvedValue({
        serial: 'wildcard-cert-123',
        notBefore: issuedAt,
        notAfter: expiresAt
      } as any);

      const result = await requestWildcardCertificate('example.com', 'admin@example.com');

      expect(result.certificateId).toBe('wildcard-cert-123');

      expect(mockCreateCsr).toHaveBeenCalledWith({
        commonName: '*.example.com',
        altNames: ['example.com', '*.example.com']
      });

      expect(mockAcmeClientInstance.auto).toHaveBeenCalledWith({
        csr: mockCsr,
        email: 'admin@example.com',
        termsOfServiceAgreed: true,
        challengePriority: ['dns-01'],
        challengeCreateFn: expect.any(Function),
        challengeRemoveFn: expect.any(Function)
      });
    });
  });

  describe('shouldRenewCertificate', () => {
    it('should return true if certificate expires in 30 days or less', () => {
      const now = new Date();
      const expiresIn25Days = new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000);

      expect(shouldRenewCertificate(expiresIn25Days)).toBe(true);
    });

    it('should return true if certificate expires today', () => {
      const now = new Date();

      expect(shouldRenewCertificate(now)).toBe(true);
    });

    it('should return false if certificate expires in more than 30 days', () => {
      const now = new Date();
      const expiresIn60Days = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

      expect(shouldRenewCertificate(expiresIn60Days)).toBe(false);
    });

    it('should return true if certificate is already expired', () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);

      expect(shouldRenewCertificate(yesterday)).toBe(true);
    });
  });
});
