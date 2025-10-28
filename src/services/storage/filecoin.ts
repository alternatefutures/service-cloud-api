import lighthouse from '@lighthouse-web3/sdk';
import type { StorageService, UploadResult } from './types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export class FilecoinStorageService implements StorageService {
  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.LIGHTHOUSE_API_KEY || '';

    if (!this.apiKey) {
      throw new Error('Lighthouse API key not configured');
    }
  }

  async upload(data: Buffer | string, filename: string): Promise<UploadResult> {
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : data;

      // Lighthouse SDK requires a file path, so create a temp file
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lighthouse-'));
      const tempFilePath = path.join(tempDir, filename);

      try {
        fs.writeFileSync(tempFilePath, buffer);

        const uploadResponse = await lighthouse.upload(tempFilePath, this.apiKey);

        return {
          cid: uploadResponse.data.Hash,
          url: `https://gateway.lighthouse.storage/ipfs/${uploadResponse.data.Hash}`,
          size: parseInt(uploadResponse.data.Size) || undefined,
          storageType: 'FILECOIN',
        };
      } finally {
        // Clean up temp file
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      throw new Error(`Filecoin upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async uploadDirectory(dirPath: string): Promise<UploadResult> {
    try {
      // Verify directory exists
      if (!fs.existsSync(dirPath)) {
        throw new Error(`Directory not found: ${dirPath}`);
      }

      const uploadResponse = await lighthouse.upload(dirPath, this.apiKey);

      return {
        cid: uploadResponse.data.Hash,
        url: `https://gateway.lighthouse.storage/ipfs/${uploadResponse.data.Hash}`,
        size: parseInt(uploadResponse.data.Size) || undefined,
        storageType: 'FILECOIN',
      };
    } catch (error) {
      throw new Error(`Filecoin directory upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async getUploadStatus(cid: string): Promise<any> {
    try {
      const status = await lighthouse.getUploads(this.apiKey);
      return status.data.fileList.find((file: any) => file.cid === cid);
    } catch (error) {
      throw new Error(`Failed to get upload status: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
