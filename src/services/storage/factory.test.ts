import { describe, it, expect } from 'vitest';
import { StorageServiceFactory } from './factory.js';
import { IPFSStorageService } from './ipfs.js';
import { ArweaveStorageService } from './arweave.js';
import { FilecoinStorageService } from './filecoin.js';

describe('StorageServiceFactory', () => {
  it('should create IPFS storage service', () => {
    // Skip if no credentials
    if (!process.env.PINATA_API_KEY) {
      return;
    }

    const service = StorageServiceFactory.create('IPFS');
    expect(service).toBeInstanceOf(IPFSStorageService);
  });

  it('should create Arweave storage service', () => {
    const service = StorageServiceFactory.create('ARWEAVE');
    expect(service).toBeInstanceOf(ArweaveStorageService);
  });

  it('should create Filecoin storage service', () => {
    // Skip if no credentials
    if (!process.env.LIGHTHOUSE_API_KEY) {
      return;
    }

    const service = StorageServiceFactory.create('FILECOIN');
    expect(service).toBeInstanceOf(FilecoinStorageService);
  });

  it('should throw error for unsupported storage type', () => {
    expect(() => {
      StorageServiceFactory.create('UNKNOWN' as any);
    }).toThrow('Unsupported storage type');
  });
});
