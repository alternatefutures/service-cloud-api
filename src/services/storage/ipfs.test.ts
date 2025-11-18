import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPFSStorageService } from './ipfs.js'

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
  },
  existsSync: vi.fn().mockReturnValue(true),
}))

// Create mock functions we can control - using vi.hoisted to ensure they're available in the mock
const {
  mockPinFileToIPFS,
  mockPinFromFS,
  mockTestAuthentication,
  MockPinataClient,
} = vi.hoisted(() => {
  const mockPinFileToIPFS = vi.fn()
  const mockPinFromFS = vi.fn()
  const mockTestAuthentication = vi.fn()

  class MockPinataClient {
    pinFileToIPFS = mockPinFileToIPFS
    pinFromFS = mockPinFromFS
    testAuthentication = mockTestAuthentication

    constructor(apiKey?: any, apiSecret?: any) {
      // Mock constructor
    }
  }

  return {
    mockPinFileToIPFS,
    mockPinFromFS,
    mockTestAuthentication,
    MockPinataClient,
  }
})

vi.mock('@pinata/sdk', () => {
  return {
    default: MockPinataClient,
  }
})

describe('IPFSStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.PINATA_API_KEY = 'test-api-key'
    process.env.PINATA_API_SECRET = 'test-api-secret'

    // Reset default mock implementations
    mockPinFileToIPFS.mockResolvedValue({
      IpfsHash: 'QmTest123',
      PinSize: 1024,
    })
    mockPinFromFS.mockResolvedValue({
      IpfsHash: 'QmTestDir456',
      PinSize: 2048,
    })
    mockTestAuthentication.mockResolvedValue({ authenticated: true })
  })

  describe('Constructor', () => {
    it('should create instance with environment variables', () => {
      const service = new IPFSStorageService()
      expect(service).toBeInstanceOf(IPFSStorageService)
    })

    it('should create instance with provided credentials', () => {
      const service = new IPFSStorageService('custom-key', 'custom-secret')
      expect(service).toBeInstanceOf(IPFSStorageService)
    })

    it('should throw error when credentials are missing', () => {
      delete process.env.PINATA_API_KEY
      delete process.env.PINATA_API_SECRET

      expect(() => new IPFSStorageService()).toThrow(
        'Pinata API credentials not configured'
      )
    })

    it('should throw error when API key is missing', () => {
      delete process.env.PINATA_API_KEY
      process.env.PINATA_API_SECRET = 'secret'

      expect(() => new IPFSStorageService()).toThrow(
        'Pinata API credentials not configured'
      )
    })

    it('should throw error when API secret is missing', () => {
      process.env.PINATA_API_KEY = 'key'
      delete process.env.PINATA_API_SECRET

      expect(() => new IPFSStorageService()).toThrow(
        'Pinata API credentials not configured'
      )
    })
  })

  describe('upload', () => {
    it('should upload buffer data', async () => {
      const service = new IPFSStorageService()
      const buffer = Buffer.from('test data')

      const result = await service.upload(buffer, 'test.txt')

      expect(result).toEqual({
        cid: 'QmTest123',
        url: 'https://gateway.pinata.cloud/ipfs/QmTest123',
        size: 1024,
        storageType: 'IPFS',
      })
    })

    it('should upload string data', async () => {
      const service = new IPFSStorageService()

      const result = await service.upload('test string data', 'test.txt')

      expect(result).toEqual({
        cid: 'QmTest123',
        url: 'https://gateway.pinata.cloud/ipfs/QmTest123',
        size: 1024,
        storageType: 'IPFS',
      })
    })

    it('should handle upload errors', async () => {
      mockPinFileToIPFS.mockRejectedValueOnce(new Error('Upload failed'))

      const service = new IPFSStorageService()

      await expect(
        service.upload(Buffer.from('test'), 'test.txt')
      ).rejects.toThrow('IPFS upload failed: Upload failed')
    })

    it('should handle unknown errors', async () => {
      mockPinFileToIPFS.mockRejectedValueOnce('Unknown error')

      const service = new IPFSStorageService()

      await expect(
        service.upload(Buffer.from('test'), 'test.txt')
      ).rejects.toThrow('IPFS upload failed: Unknown error')
    })
  })

  describe('uploadDirectory', () => {
    it('should upload directory', async () => {
      const service = new IPFSStorageService()

      const result = await service.uploadDirectory('/tmp/test-dir')

      expect(result).toEqual({
        cid: 'QmTestDir456',
        url: 'https://gateway.pinata.cloud/ipfs/QmTestDir456',
        size: 2048,
        storageType: 'IPFS',
      })
    })

    it('should throw error when directory does not exist', async () => {
      const { existsSync } = await import('fs')
      vi.mocked(existsSync).mockReturnValueOnce(false)

      const service = new IPFSStorageService()

      await expect(
        service.uploadDirectory('/non-existent-dir')
      ).rejects.toThrow('Directory not found: /non-existent-dir')
    })

    it('should handle directory upload errors', async () => {
      mockPinFromFS.mockRejectedValueOnce(new Error('Directory upload failed'))

      const service = new IPFSStorageService()

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow(
        'IPFS directory upload failed: Directory upload failed'
      )
    })

    it('should handle unknown directory upload errors', async () => {
      mockPinFromFS.mockRejectedValueOnce('Unknown error')

      const service = new IPFSStorageService()

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow(
        'IPFS directory upload failed: Unknown error'
      )
    })
  })

  describe('testConnection', () => {
    it('should return true when authentication succeeds', async () => {
      const service = new IPFSStorageService()

      const result = await service.testConnection()

      expect(result).toBe(true)
    })

    it('should return false when authentication fails', async () => {
      mockTestAuthentication.mockRejectedValueOnce(new Error('Auth failed'))

      const service = new IPFSStorageService()

      const result = await service.testConnection()

      expect(result).toBe(false)
    })
  })
})
