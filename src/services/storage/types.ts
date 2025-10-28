export interface UploadResult {
  cid: string;
  url: string;
  size?: number;
  storageType: 'IPFS' | 'ARWEAVE' | 'FILECOIN';
}

export interface StorageService {
  upload(data: Buffer | string, filename: string): Promise<UploadResult>;
  uploadDirectory(path: string): Promise<UploadResult>;
}

export interface BuildResult {
  success: boolean;
  buildPath: string;
  logs: string[];
  error?: string;
}
