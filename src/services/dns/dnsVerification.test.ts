import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  generateVerificationToken,
  verifyTxtRecord,
  verifyCnameRecord,
  verifyARecord,
  checkDnsPropagation,
  getPlatformCnameTarget,
  getPlatformIpAddress,
} from './dnsVerification'

// Mock dns/promises module with methods defined inside
vi.mock('dns/promises', () => {
  const mockResolveTxt = vi.fn()
  const mockResolveCname = vi.fn()
  const mockResolve4 = vi.fn()

  return {
    Resolver: class MockResolver {
      resolveTxt
      resolveCname
      resolve4

      constructor() {
        this.resolveTxt = mockResolveTxt
        this.resolveCname = mockResolveCname
        this.resolve4 = mockResolve4
      }
    },
    // Export mock functions so tests can access them
    __mockResolveTxt: mockResolveTxt,
    __mockResolveCname: mockResolveCname,
    __mockResolve4: mockResolve4,
  }
})

// Import the mocks after vi.mock
import * as dns from 'dns/promises'
const mockResolveTxt = (dns as any).__mockResolveTxt
const mockResolveCname = (dns as any).__mockResolveCname
const mockResolve4 = (dns as any).__mockResolve4

describe('DNS Verification Service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('generateVerificationToken', () => {
    it('should generate verification token with correct format', () => {
      const hostname = 'example.com'
      const token = generateVerificationToken(hostname)

      expect(token).toMatch(/^af-site-verification=/)
      expect(token.length).toBeGreaterThan(20)
    })

    it('should generate unique tokens for same hostname', () => {
      const hostname = 'example.com'
      const token1 = generateVerificationToken(hostname)
      const token2 = generateVerificationToken(hostname)

      expect(token1).not.toBe(token2)
    })
  })

  describe('verifyTxtRecord', () => {
    it('should verify matching TXT record', async () => {
      const hostname = 'example.com'
      const token = 'af-site-verification=abc123'

      mockResolveTxt.mockResolvedValue([[token]])

      const result = await verifyTxtRecord(hostname, token)

      expect(result.verified).toBe(true)
      expect(result.record).toBe(token)
      expect(mockResolveTxt).toHaveBeenCalledWith(hostname)
    })

    it('should reject non-matching TXT record', async () => {
      const hostname = 'example.com'
      const token = 'af-site-verification=abc123'

      mockResolveTxt.mockResolvedValue([['some-other-record']])

      const result = await verifyTxtRecord(hostname, token)

      expect(result.verified).toBe(false)
      expect(result.error).toContain('not found')
    })

    it('should handle DNS lookup failure', async () => {
      const hostname = 'invalid.example.com'
      const token = 'af-site-verification=abc123'

      mockResolveTxt.mockRejectedValue(new Error('NXDOMAIN'))

      const result = await verifyTxtRecord(hostname, token)

      expect(result.verified).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('should handle multiple TXT records', async () => {
      const hostname = 'example.com'
      const token = 'af-site-verification=abc123'

      mockResolveTxt.mockResolvedValue([
        ['unrelated-record'],
        [token],
        ['another-record'],
      ])

      const result = await verifyTxtRecord(hostname, token)

      expect(result.verified).toBe(true)
    })
  })

  describe('verifyCnameRecord', () => {
    it('should verify matching CNAME record', async () => {
      const hostname = 'www.example.com'
      const target = 'cname.alternatefutures.ai'

      mockResolveCname.mockResolvedValue([target])

      const result = await verifyCnameRecord(hostname, target)

      expect(result.verified).toBe(true)
      expect(result.record).toBe(target)
    })

    it('should verify CNAME with trailing dot', async () => {
      const hostname = 'www.example.com'
      const target = 'cname.alternatefutures.ai'

      mockResolveCname.mockResolvedValue(['cname.alternatefutures.ai.'])

      const result = await verifyCnameRecord(hostname, target)

      expect(result.verified).toBe(true)
    })

    it('should reject non-matching CNAME', async () => {
      const hostname = 'www.example.com'
      const target = 'cname.alternatefutures.ai'

      mockResolveCname.mockResolvedValue(['wrong.target.com'])

      const result = await verifyCnameRecord(hostname, target)

      expect(result.verified).toBe(false)
      expect(result.error).toContain('does not point to')
    })

    it('should be case insensitive', async () => {
      const hostname = 'www.example.com'
      const target = 'CNAME.ALTERNATEFUTURES.AI'

      mockResolveCname.mockResolvedValue(['cname.alternatefutures.ai'])

      const result = await verifyCnameRecord(hostname, target)

      expect(result.verified).toBe(true)
    })
  })

  describe('verifyARecord', () => {
    it('should verify matching A record', async () => {
      const hostname = 'example.com'
      const ip = '192.0.2.1'

      mockResolve4.mockResolvedValue([ip])

      const result = await verifyARecord(hostname, ip)

      expect(result.verified).toBe(true)
      expect(result.record).toBe(ip)
    })

    it('should reject non-matching A record', async () => {
      const hostname = 'example.com'
      const ip = '192.0.2.1'

      mockResolve4.mockResolvedValue(['192.0.2.2'])

      const result = await verifyARecord(hostname, ip)

      expect(result.verified).toBe(false)
      expect(result.error).toContain('does not point to')
    })

    it('should handle multiple A records', async () => {
      const hostname = 'example.com'
      const ip = '192.0.2.1'

      mockResolve4.mockResolvedValue(['192.0.2.2', ip, '192.0.2.3'])

      const result = await verifyARecord(hostname, ip)

      expect(result.verified).toBe(true)
    })

    it('should handle DNS lookup failure', async () => {
      const hostname = 'invalid.example.com'
      const ip = '192.0.2.1'

      mockResolve4.mockRejectedValue(new Error('NXDOMAIN'))

      const result = await verifyARecord(hostname, ip)

      expect(result.verified).toBe(false)
      expect(result.error).toBeDefined()
    })
  })

  describe('checkDnsPropagation', () => {
    it('should check TXT record propagation', async () => {
      const hostname = 'example.com'
      const value = 'af-site-verification=abc123'

      mockResolveTxt.mockResolvedValue([[value]])

      const result = await checkDnsPropagation(hostname, 'TXT', value)

      expect(result).toBe(true)
    })

    it('should check CNAME record propagation', async () => {
      const hostname = 'www.example.com'
      const value = 'cname.alternatefutures.ai'

      mockResolveCname.mockResolvedValue([value])

      const result = await checkDnsPropagation(hostname, 'CNAME', value)

      expect(result).toBe(true)
    })

    it('should check A record propagation', async () => {
      const hostname = 'example.com'
      const value = '192.0.2.1'

      mockResolve4.mockResolvedValue([value])

      const result = await checkDnsPropagation(hostname, 'A', value)

      expect(result).toBe(true)
    })

    it('should return false on propagation failure', async () => {
      const hostname = 'example.com'
      const value = 'af-site-verification=abc123'

      mockResolveTxt.mockRejectedValue(new Error('NXDOMAIN'))

      const result = await checkDnsPropagation(hostname, 'TXT', value)

      expect(result).toBe(false)
    })
  })

  describe('getPlatformCnameTarget', () => {
    it('should return configured CNAME target', () => {
      process.env.PLATFORM_CNAME_TARGET = 'custom.cname.com'

      const target = getPlatformCnameTarget()

      expect(target).toBe('custom.cname.com')

      delete process.env.PLATFORM_CNAME_TARGET
    })

    it('should return default CNAME target', () => {
      const target = getPlatformCnameTarget()

      expect(target).toBe('cname.alternatefutures.ai')
    })
  })

  describe('getPlatformIpAddress', () => {
    it('should return configured IP address', () => {
      process.env.PLATFORM_IP_ADDRESS = '192.0.2.1'

      const ip = getPlatformIpAddress()

      expect(ip).toBe('192.0.2.1')

      delete process.env.PLATFORM_IP_ADDRESS
    })

    it('should return default IP address', () => {
      const ip = getPlatformIpAddress()

      expect(ip).toBe('0.0.0.0')
    })
  })
})
