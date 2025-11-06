/**
 * IPFS Storage Service with Billing Tracking
 *
 * Wraps the IPFS storage service and adds billing tracking for pin/unpin operations
 */

import { IPFSStorageService } from './ipfs.js';
import { StorageTracker } from '../billing/storageTracker.js';
import type { PrismaClient } from '@prisma/client';
import type { UploadResult } from './types.js';

export class IPFSWithTracking extends IPFSStorageService {
  private storageTracker: StorageTracker;

  constructor(
    private prismaClient: PrismaClient,
    apiKey?: string,
    apiSecret?: string
  ) {
    super(apiKey, apiSecret);
    this.storageTracker = new StorageTracker(prismaClient);
  }

  /**
   * Upload file to IPFS and track for billing
   */
  async uploadWithTracking(
    data: Buffer | string,
    filename: string,
    userId: string,
    mimeType?: string
  ): Promise<UploadResult> {
    // Upload to IPFS
    const result = await this.upload(data, filename);

    // Track for billing
    await this.storageTracker.trackPinEvent(
      userId,
      result.cid,
      result.size || 0,
      filename,
      mimeType
    );

    return result;
  }

  /**
   * Upload directory to IPFS and track for billing
   */
  async uploadDirectoryWithTracking(
    path: string,
    userId: string
  ): Promise<UploadResult> {
    // Upload to IPFS
    const result = await this.uploadDirectory(path);

    // Track for billing (using path as filename)
    await this.storageTracker.trackPinEvent(
      userId,
      result.cid,
      result.size || 0,
      path
    );

    return result;
  }

  /**
   * Unpin content from IPFS and update billing
   * Note: This requires Pinata's unpin API
   */
  async unpinWithTracking(cid: string, userId: string): Promise<boolean> {
    try {
      // Unpin from IPFS (if you have access to unpin method)
      // await this.pinata.unpin(cid);

      // Track for billing
      await this.storageTracker.trackUnpinEvent(userId, cid);

      return true;
    } catch (error) {
      throw new Error(
        `IPFS unpin failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Get current storage usage for user
   */
  async getCurrentStorage(userId: string): Promise<bigint> {
    return this.storageTracker.getCurrentStorage(userId);
  }

  /**
   * Get list of pinned content for user
   */
  async getActivePins(userId: string, limit?: number) {
    return this.storageTracker.getActivePins(userId, limit);
  }
}
