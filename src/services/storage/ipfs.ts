/**
 * IPFS Storage Service (Pinata)
 *
 * Uses Pinata for IPFS pinning and storage
 */

import type { StorageService, UploadResult } from './types.js'

/**
 * IPFS Storage Service using Pinata
 */
export class IPFSStorageService implements StorageService {
  private apiKey: string
  private apiSecret: string
  private gatewayUrl: string

  constructor(apiKey?: string, apiSecret?: string) {
    this.apiKey = apiKey || process.env.PINATA_API_KEY || ''
    this.apiSecret = apiSecret || process.env.PINATA_API_SECRET || ''
    this.gatewayUrl =
      process.env.IPFS_GATEWAY_URL || 'https://gateway.pinata.cloud/ipfs'
  }

  async upload(data: Buffer | string, filename: string): Promise<UploadResult> {
    const buffer = typeof data === 'string' ? Buffer.from(data) : data

    const formData = new FormData()
    formData.append('file', new Blob([new Uint8Array(buffer)]), filename)
    formData.append(
      'pinataMetadata',
      JSON.stringify({
        name: filename,
      })
    )

    try {
      const response = await fetch(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        {
          method: 'POST',
          headers: {
            pinata_api_key: this.apiKey,
            pinata_secret_api_key: this.apiSecret,
          },
          body: formData,
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Pinata upload failed: ${error}`)
      }

      const result = (await response.json()) as {
        IpfsHash: string
        PinSize: number
      }

      return {
        cid: result.IpfsHash,
        url: `${this.gatewayUrl}/${result.IpfsHash}`,
        size: result.PinSize,
        storageType: 'IPFS',
      }
    } catch (error) {
      throw new Error(
        `IPFS upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  async uploadDirectory(dirPath: string): Promise<UploadResult> {
    // Note: Directory uploads require different handling with Pinata
    // This is a simplified implementation
    throw new Error(
      'Directory upload not implemented for Pinata. Use SelfHostedIPFSStorageService instead.'
    )
  }

  /**
   * Unpin content from Pinata
   */
  async unpin(cid: string): Promise<void> {
    try {
      const response = await fetch(
        `https://api.pinata.cloud/pinning/unpin/${cid}`,
        {
          method: 'DELETE',
          headers: {
            pinata_api_key: this.apiKey,
            pinata_secret_api_key: this.apiSecret,
          },
        }
      )

      if (!response.ok) {
        const error = await response.text()
        throw new Error(`Pinata unpin failed: ${error}`)
      }
    } catch (error) {
      throw new Error(
        `IPFS unpin failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  /**
   * Test connection to Pinata
   */
  async testConnection(): Promise<boolean> {
    try {
      const response = await fetch(
        'https://api.pinata.cloud/data/testAuthentication',
        {
          headers: {
            pinata_api_key: this.apiKey,
            pinata_secret_api_key: this.apiSecret,
          },
        }
      )
      return response.ok
    } catch {
      return false
    }
  }
}
