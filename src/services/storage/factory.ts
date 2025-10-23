import type { StorageService } from './types.js';
import { IPFSStorageService } from './ipfs.js';
import { ArweaveStorageService } from './arweave.js';
import { FilecoinStorageService } from './filecoin.js';

export type StorageType = 'IPFS' | 'ARWEAVE' | 'FILECOIN';

export class StorageServiceFactory {
  static create(storageType: StorageType): StorageService {
    switch (storageType) {
      case 'IPFS':
        return new IPFSStorageService();
      case 'ARWEAVE':
        return new ArweaveStorageService();
      case 'FILECOIN':
        return new FilecoinStorageService();
      default:
        throw new Error(`Unsupported storage type: ${storageType}`);
    }
  }
}
