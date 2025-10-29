import type { StorageService } from './types.js';
import { IPFSStorageService } from './ipfs.js';
import { SelfHostedIPFSStorageService } from './ipfs-selfhosted.js';
import { ArweaveStorageService } from './arweave.js';
import { FilecoinStorageService } from './filecoin.js';

export type StorageType = 'IPFS' | 'ARWEAVE' | 'FILECOIN';

export class StorageServiceFactory {
  static create(storageType: StorageType): StorageService {
    switch (storageType) {
      case 'IPFS':
        // Always use self-hosted IPFS (no Pinata fallback)
        if (!process.env.IPFS_API_URL) {
          throw new Error('IPFS_API_URL environment variable is required for self-hosted IPFS');
        }
        return new SelfHostedIPFSStorageService();
      case 'ARWEAVE':
        return new ArweaveStorageService();
      case 'FILECOIN':
        return new FilecoinStorageService();
      default:
        throw new Error(`Unsupported storage type: ${storageType}`);
    }
  }

  /**
   * Create a self-hosted IPFS service (for direct usage)
   */
  static createSelfHostedIPFS(apiUrl?: string, gatewayUrl?: string): SelfHostedIPFSStorageService {
    return new SelfHostedIPFSStorageService(apiUrl, gatewayUrl);
  }
}
