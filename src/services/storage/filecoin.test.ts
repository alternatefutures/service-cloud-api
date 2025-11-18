import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FilecoinStorageService } from './filecoin.js'

// Mock fs module
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(true),
    mkdtempSync: vi.fn().mockReturnValue('/tmp/temp-dir'),
    writeFileSync: vi.fn(),
    rmSync: vi.fn(),
  },
  existsSync: vi.fn().mockReturnValue(true),
  mkdtempSync: vi.fn().mockReturnValue('/tmp/temp-dir'),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}))

// Mock the @lighthouse-web3/sdk module
vi.mock('@lighthouse-web3/sdk', () => {
  return {
    default: {
      upload: vi.fn().mockResolvedValue({
        data: {
          Hash: 'QmLighthouse123',
          Size: '1024',
        },
      }),
      getUploads: vi.fn().mockResolvedValue({
        data: {
          fileList: [
            { cid: 'QmLighthouse123', status: 'uploaded' },
            { cid: 'QmLighthouse456', status: 'uploaded' },
          ],
        },
      }),
    },
  }
})

describe('FilecoinStorageService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.LIGHTHOUSE_API_KEY = 'test-lighthouse-key'
  })

  describe('Constructor', () => {
    it('should create instance with environment variable', () => {
      const service = new FilecoinStorageService()
      expect(service).toBeInstanceOf(FilecoinStorageService)
    })

    it('should create instance with provided API key', () => {
      const service = new FilecoinStorageService('custom-key')
      expect(service).toBeInstanceOf(FilecoinStorageService)
    })

    it('should throw error when API key is missing', () => {
      delete process.env.LIGHTHOUSE_API_KEY

      expect(() => new FilecoinStorageService()).toThrow(
        'Lighthouse API key not configured'
      )
    })
  })

  describe('upload', () => {
    it('should upload buffer data', async () => {
      const service = new FilecoinStorageService()
      const buffer = Buffer.from('test data')

      const result = await service.upload(buffer, 'test.txt')

      expect(result).toEqual({
        cid: 'QmLighthouse123',
        url: 'https://gateway.lighthouse.storage/ipfs/QmLighthouse123',
        size: 1024,
        storageType: 'FILECOIN',
      })
    })

    it('should upload string data', async () => {
      const service = new FilecoinStorageService()

      const result = await service.upload('test string data', 'test.txt')

      expect(result).toEqual({
        cid: 'QmLighthouse123',
        url: 'https://gateway.lighthouse.storage/ipfs/QmLighthouse123',
        size: 1024,
        storageType: 'FILECOIN',
      })
    })

    it('should handle upload errors', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockRejectedValueOnce(
        new Error('Upload failed')
      )

      const service = new FilecoinStorageService()

      await expect(
        service.upload(Buffer.from('test'), 'test.txt')
      ).rejects.toThrow('Filecoin upload failed: Upload failed')
    })

    it('should handle unknown errors', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockRejectedValueOnce('Unknown error')

      const service = new FilecoinStorageService()

      await expect(
        service.upload(Buffer.from('test'), 'test.txt')
      ).rejects.toThrow('Filecoin upload failed: Unknown error')
    })

    it('should handle size as undefined when NaN', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockResolvedValueOnce({
        data: {
          Hash: 'QmTest',
          Size: 'invalid-size',
        },
      } as any)

      const service = new FilecoinStorageService()

      const result = await service.upload(Buffer.from('test'), 'test.txt')

      expect(result.size).toBeUndefined()
    })
  })

  describe('uploadDirectory', () => {
    it('should upload directory', async () => {
      const service = new FilecoinStorageService()

      const result = await service.uploadDirectory('/tmp/test-dir')

      expect(result).toEqual({
        cid: 'QmLighthouse123',
        url: 'https://gateway.lighthouse.storage/ipfs/QmLighthouse123',
        size: 1024,
        storageType: 'FILECOIN',
      })
    })

    it('should throw error when directory does not exist', async () => {
      const { existsSync } = await import('fs')
      vi.mocked(existsSync).mockReturnValueOnce(false)

      const service = new FilecoinStorageService()

      await expect(
        service.uploadDirectory('/non-existent-dir')
      ).rejects.toThrow('Directory not found: /non-existent-dir')
    })

    it('should handle missing directory', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockImplementationOnce(() => {
        throw new Error('Directory not found: /non-existent')
      })

      const service = new FilecoinStorageService()

      await expect(service.uploadDirectory('/non-existent')).rejects.toThrow(
        'Filecoin directory upload failed'
      )
    })

    it('should handle directory upload errors', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockRejectedValueOnce(
        new Error('Directory upload failed')
      )

      const service = new FilecoinStorageService()

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow(
        'Filecoin directory upload failed: Directory upload failed'
      )
    })

    it('should handle unknown directory upload errors', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockRejectedValueOnce('Unknown error')

      const service = new FilecoinStorageService()

      await expect(service.uploadDirectory('/tmp/test-dir')).rejects.toThrow(
        'Filecoin directory upload failed: Unknown error'
      )
    })

    it('should handle size as undefined when NaN in directory upload', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.upload).mockResolvedValueOnce({
        data: {
          Hash: 'QmTestDir',
          Size: 'not-a-number',
        },
      } as any)

      const service = new FilecoinStorageService()

      const result = await service.uploadDirectory('/tmp/test-dir')

      expect(result.size).toBeUndefined()
    })
  })

  describe('getUploadStatus', () => {
    it('should get upload status for a CID', async () => {
      const service = new FilecoinStorageService()

      const status = await service.getUploadStatus('QmLighthouse123')

      expect(status).toEqual({ cid: 'QmLighthouse123', status: 'uploaded' })
    })

    it('should return undefined for non-existent CID', async () => {
      const service = new FilecoinStorageService()

      const status = await service.getUploadStatus('QmNonExistent')

      expect(status).toBeUndefined()
    })

    it('should handle getUploadStatus errors', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.getUploads).mockRejectedValueOnce(
        new Error('Failed to get status')
      )

      const service = new FilecoinStorageService()

      await expect(service.getUploadStatus('QmTest')).rejects.toThrow(
        'Failed to get upload status: Failed to get status'
      )
    })

    it('should handle unknown getUploadStatus errors', async () => {
      const lighthouse = (await import('@lighthouse-web3/sdk')).default
      vi.mocked(lighthouse.getUploads).mockRejectedValueOnce('Unknown error')

      const service = new FilecoinStorageService()

      await expect(service.getUploadStatus('QmTest')).rejects.toThrow(
        'Failed to get upload status: Unknown error'
      )
    })
  })
})
