import { create, IPFSHTTPClient } from 'ipfs-http-client';
import type { StorageService, UploadResult } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import { globSource } from 'ipfs-http-client';

/**
 * Self-Hosted IPFS Storage Service
 * Connects to your own IPFS node instead of centralized services like Pinata
 * Use this with IPFS node deployed on Akash Network
 */
export class SelfHostedIPFSStorageService implements StorageService {
  private client: IPFSHTTPClient;
  private gatewayUrl: string;

  constructor(apiUrl?: string, gatewayUrl?: string) {
    const api = apiUrl || process.env.IPFS_API_URL || 'http://localhost:5001';
    this.gatewayUrl = gatewayUrl || process.env.IPFS_GATEWAY_URL || 'https://ipfs.alternatefutures.ai';

    this.client = create({ url: api });
  }

  async upload(data: Buffer | string, filename: string): Promise<UploadResult> {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : data;

      const result = await this.client.add(
        {
          path: filename,
          content: buffer,
        },
        {
          wrapWithDirectory: false,
          pin: true, // Pin to ensure persistence
        }
      );

      return {
        cid: result.cid.toString(),
        url: `${this.gatewayUrl}/ipfs/${result.cid.toString()}`,
        size: result.size,
        storageType: 'IPFS',
      };
    } catch (error) {
      throw new Error(`IPFS upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async uploadDirectory(dirPath: string): Promise<UploadResult> {
    try {
      // Verify directory exists
      if (!fs.existsSync(dirPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }

      // Upload directory with all contents
      let lastResult: { cid: any; size: number } | undefined;

      for await (const file of this.client.addAll(
        globSource(dirPath, { recursive: true }),
        {
          wrapWithDirectory: true,
          pin: true,
        }
      )) {
        lastResult = file;
      }

      if (!lastResult) {
        throw new Error('No files uploaded');
      }

      // The last result is the directory itself
      return {
        cid: lastResult.cid.toString(),
        url: `${this.gatewayUrl}/ipfs/${lastResult.cid.toString()}`,
        size: lastResult.size,
        storageType: 'IPFS',
      };
    } catch (error) {
      throw new Error(`IPFS directory upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Pin existing CID to ensure persistence
   */
  async pin(cid: string): Promise<void> {
    try {
      await this.client.pin.add(cid);
    } catch (error) {
      throw new Error(`IPFS pin failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Unpin CID to free up space
   */
  async unpin(cid: string): Promise<void> {
    try {
      await this.client.pin.rm(cid);
    } catch (error) {
      throw new Error(`IPFS unpin failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get file from IPFS
   */
  async get(cid: string): Promise<Buffer> {
    try {
      const chunks: Uint8Array[] = [];

      for await (const chunk of this.client.cat(cid)) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      throw new Error(`IPFS get failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Test connection to IPFS node
   */
  async testConnection(): Promise<boolean> {
    try {
      const id = await this.client.id();
      console.log(`Connected to IPFS node: ${id.id}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get IPFS node information
   */
  async getNodeInfo(): Promise<{
    id: string;
    agentVersion: string;
    protocolVersion: string;
    addresses: string[];
  }> {
    const info = await this.client.id();
    return {
      id: info.id.toString(),
      agentVersion: info.agentVersion,
      protocolVersion: info.protocolVersion,
      addresses: info.addresses.map((addr) => addr.toString()),
    };
  }

  /**
   * Get repository statistics
   */
  async getStats(): Promise<{
    numObjects: bigint;
    repoSize: bigint;
    storageMax: bigint;
    version: string;
  }> {
    const stats = await this.client.repo.stat();
    return {
      numObjects: stats.numObjects,
      repoSize: stats.repoSize,
      storageMax: stats.storageMax,
      version: stats.version,
    };
  }
}
