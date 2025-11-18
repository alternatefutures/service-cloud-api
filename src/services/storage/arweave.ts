import { TurboFactory } from '@ardrive/turbo-sdk'
import type { StorageService, UploadResult } from './types.js'
import * as fs from 'fs'
import * as path from 'path'

export class ArweaveStorageService implements StorageService {
  private turbo!: Awaited<ReturnType<typeof TurboFactory.authenticated>>
  private initialized = false

  constructor(private privateKey?: string) {
    this.privateKey = privateKey || process.env.ARWEAVE_PRIVATE_KEY
  }

  private async initialize() {
    if (this.initialized) return

    if (!this.privateKey) {
      throw new Error('Arweave private key not configured')
    }

    try {
      // Parse the JWK if it's a JSON string
      const jwk =
        typeof this.privateKey === 'string'
          ? JSON.parse(this.privateKey)
          : this.privateKey

      this.turbo = await TurboFactory.authenticated({
        privateKey: jwk,
      })

      this.initialized = true
    } catch (error) {
      throw new Error(
        `Failed to initialize Arweave client: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  async upload(data: Buffer | string, filename: string): Promise<UploadResult> {
    await this.initialize()

    try {
      const buffer = typeof data === 'string' ? Buffer.from(data) : data

      const uploadResult = await this.turbo.uploadFile({
        fileStreamFactory: () => buffer,
        fileSizeFactory: () => buffer.length,
        dataItemOpts: {
          tags: [
            { name: 'Content-Type', value: 'application/octet-stream' },
            { name: 'File-Name', value: filename },
          ],
        },
      })

      return {
        cid: uploadResult.id,
        url: `https://arweave.net/${uploadResult.id}`,
        size: buffer.length,
        storageType: 'ARWEAVE',
      }
    } catch (error) {
      throw new Error(
        `Arweave upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  async uploadDirectory(dirPath: string): Promise<UploadResult> {
    await this.initialize()

    try {
      // Verify directory exists
      if (!fs.existsSync(dirPath)) {
        throw new Error(`Directory not found: ${dirPath}`)
      }

      // Recursively read all files in directory
      const files = this.getAllFiles(dirPath)

      if (files.length === 0) {
        throw new Error('No files found in directory')
      }

      // Create a manifest of all files
      const manifest: Record<string, any> = {
        manifest: 'arweave/paths',
        version: '0.1.0',
        index: {
          path: 'index.html',
        },
        paths: {},
      }

      // Upload each file and build manifest
      for (const filePath of files) {
        const relativePath = path.relative(dirPath, filePath)
        const fileBuffer = fs.readFileSync(filePath)

        const uploadResult = await this.turbo.uploadFile({
          fileStreamFactory: () => fileBuffer,
          fileSizeFactory: () => fileBuffer.length,
          dataItemOpts: {
            tags: [
              { name: 'Content-Type', value: this.getContentType(filePath) },
            ],
          },
        })

        manifest.paths[relativePath] = {
          id: uploadResult.id,
        }
      }

      // Upload the manifest itself
      const manifestBuffer = Buffer.from(JSON.stringify(manifest))
      const manifestUpload = await this.turbo.uploadFile({
        fileStreamFactory: () => manifestBuffer,
        fileSizeFactory: () => manifestBuffer.length,
        dataItemOpts: {
          tags: [
            {
              name: 'Content-Type',
              value: 'application/x.arweave-manifest+json',
            },
          ],
        },
      })

      return {
        cid: manifestUpload.id,
        url: `https://arweave.net/${manifestUpload.id}`,
        storageType: 'ARWEAVE',
      }
    } catch (error) {
      throw new Error(
        `Arweave directory upload failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }
  }

  private getAllFiles(dirPath: string, files: string[] = []): string[] {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        this.getAllFiles(fullPath, files)
      } else {
        files.push(fullPath)
      }
    }

    return files
  }

  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    const contentTypes: Record<string, string> = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.svg': 'image/svg+xml',
      '.txt': 'text/plain',
    }

    return contentTypes[ext] || 'application/octet-stream'
  }
}
