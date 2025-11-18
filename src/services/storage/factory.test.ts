import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StorageServiceFactory } from './factory.js'
import { IPFSStorageService } from './ipfs.js'
import { SelfHostedIPFSStorageService } from './ipfs-selfhosted.js'
import { ArweaveStorageService } from './arweave.js'
import { FilecoinStorageService } from './filecoin.js'

describe('StorageServiceFactory', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    // Save original environment
    originalEnv = {
      PINATA_API_KEY: process.env.PINATA_API_KEY,
      PINATA_API_SECRET: process.env.PINATA_API_SECRET,
      IPFS_API_URL: process.env.IPFS_API_URL,
      IPFS_GATEWAY_URL: process.env.IPFS_GATEWAY_URL,
      LIGHTHOUSE_API_KEY: process.env.LIGHTHOUSE_API_KEY,
    }

    // Set test credentials
    process.env.PINATA_API_KEY = 'test-pinata-key'
    process.env.PINATA_API_SECRET = 'test-pinata-secret'
    process.env.LIGHTHOUSE_API_KEY = 'test-lighthouse-key'

    // Clear IPFS env vars by default (test Pinata mode)
    delete process.env.IPFS_API_URL
    delete process.env.IPFS_GATEWAY_URL
  })

  afterEach(() => {
    // Restore original environment
    process.env.PINATA_API_KEY = originalEnv.PINATA_API_KEY
    process.env.PINATA_API_SECRET = originalEnv.PINATA_API_SECRET
    process.env.IPFS_API_URL = originalEnv.IPFS_API_URL
    process.env.IPFS_GATEWAY_URL = originalEnv.IPFS_GATEWAY_URL
    process.env.LIGHTHOUSE_API_KEY = originalEnv.LIGHTHOUSE_API_KEY
  })

  describe('IPFS self-hosted only (no Pinata fallback)', () => {
    it('should throw error when IPFS_API_URL is not set', () => {
      // IPFS_API_URL is already deleted in beforeEach
      expect(() => {
        StorageServiceFactory.create('IPFS')
      }).toThrow(
        'IPFS_API_URL environment variable is required for self-hosted IPFS'
      )
    })

    it('should create self-hosted IPFS service when IPFS_API_URL is set', () => {
      process.env.IPFS_API_URL = 'http://localhost:5001'
      const service = StorageServiceFactory.create('IPFS')
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService)
    })

    it('should create self-hosted IPFS service when IPFS_API_URL and IPFS_GATEWAY_URL are set', () => {
      process.env.IPFS_API_URL = 'http://ipfs:5001'
      process.env.IPFS_GATEWAY_URL = 'https://ipfs.alternatefutures.ai'
      const service = StorageServiceFactory.create('IPFS')
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService)
    })
  })

  describe('createSelfHostedIPFS factory method', () => {
    it('should create self-hosted IPFS service with default URLs', () => {
      const service = StorageServiceFactory.createSelfHostedIPFS()
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService)
    })

    it('should create self-hosted IPFS service with custom URLs', () => {
      const service = StorageServiceFactory.createSelfHostedIPFS(
        'http://custom:5001',
        'https://custom.gateway.io'
      )
      expect(service).toBeInstanceOf(SelfHostedIPFSStorageService)
    })
  })

  it('should create Arweave storage service', () => {
    const service = StorageServiceFactory.create('ARWEAVE')
    expect(service).toBeInstanceOf(ArweaveStorageService)
  })

  it('should create Filecoin storage service', () => {
    const service = StorageServiceFactory.create('FILECOIN')
    expect(service).toBeInstanceOf(FilecoinStorageService)
  })

  it('should throw error for unsupported storage type', () => {
    expect(() => {
      StorageServiceFactory.create('UNKNOWN' as any)
    }).toThrow('Unsupported storage type')
  })
})
