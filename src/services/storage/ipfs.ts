import PinataClient from '@pinata/sdk';
import type { StorageService, UploadResult } from './types.js';
import { Readable } from 'stream';
import * as fs from 'fs';

export class IPFSStorageService implements StorageService {
  private pinata: PinataClient;

  constructor(apiKey?: string, apiSecret?: string) {
    const key = apiKey || process.env.PINATA_API_KEY;
    const secret = apiSecret || process.env.PINATA_API_SECRET;

    if (!key || !secret) {
      throw new Error('Pinata API credentials not configured');
    }

    this.pinata = new PinataClient(key, secret);
  }

  async upload(data: Buffer | string, filename: string): Promise<UploadResult> {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : data;
      const stream = Readable.from(buffer);

      const result = await this.pinata.pinFileToIPFS(stream, {
        pinataMetadata: {
          name: filename,
        },
      });

      return {
        cid: result.IpfsHash,
        url: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
        size: result.PinSize,
        storageType: 'IPFS',
      };
    } catch (error) {
      throw new Error(`IPFS upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async uploadDirectory(path: string): Promise<UploadResult> {
    try {
      // Verify directory exists
      if (!fs.existsSync(path)) {
        throw new Error(`Directory not found: ${path}`);
      }

      const result = await this.pinata.pinFromFS(path);

      return {
        cid: result.IpfsHash,
        url: `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`,
        size: result.PinSize,
        storageType: 'IPFS',
      };
    } catch (error) {
      throw new Error(`IPFS directory upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.pinata.testAuthentication();
      return true;
    } catch {
      return false;
    }
  }
}
