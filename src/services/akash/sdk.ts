/**
 * Akash JS SDK initialization.
 *
 * Replaces the CLI binary approach (akash + provider-services) with
 * pure JS/TS using @akashnetwork/chain-sdk + @cosmjs.
 *
 * Requires these packages in service-cloud-api/package.json:
 *   @akashnetwork/chain-sdk  ^1.0.0-alpha.18
 *   @cosmjs/proto-signing    ^0.33.1
 *   @cosmjs/stargate          ^0.33.1
 *
 * Install:
 *   cd service-cloud-api && pnpm add @akashnetwork/chain-sdk @cosmjs/proto-signing @cosmjs/stargate
 */

import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing'
// Sub-path imports for @akashnetwork/chain-sdk 1.0.0-alpha.0+
// @ts-ignore — sub-path exports resolve at runtime via Node ESM but tsc with moduleResolution:node can't see them
import { createChainNodeSDK } from '@akashnetwork/chain-sdk/chain'
// @ts-ignore
import { SDL } from '@akashnetwork/chain-sdk/sdl'
// @ts-ignore
import { CertificateManager, type CertificatePem } from '@akashnetwork/chain-sdk/provider'
import https from 'https'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Re-export types used by orchestrator-sdk
export type ChainNodeSDK = ReturnType<typeof createChainNodeSDK>
export { SDL, type CertificatePem }

export interface AkashSDKContext {
  wallet: DirectSecp256k1HdWallet
  chainSDK: ChainNodeSDK
  certificate: CertificatePem
  ownerAddress: string
}

// Singleton context (initialized once, reused)
let sdkContext: AkashSDKContext | null = null

function pemToUint8Array(pem: string): Uint8Array {
  return new TextEncoder().encode(pem)
}

function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function getCertDir(): string {
  return path.join(os.tmpdir(), 'akash-certs')
}

/**
 * Initialize the Akash SDK context: wallet, signing client, chain SDK, and mTLS certificate.
 * Cached as a singleton — subsequent calls return the same context.
 */
export async function getAkashSDKContext(): Promise<AkashSDKContext> {
  if (sdkContext) return sdkContext

  const mnemonic = (process.env.AKASH_MNEMONIC || '').trim()
  if (!mnemonic) {
    throw new Error('AKASH_MNEMONIC is not set')
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'akash',
  })

  const accounts = await wallet.getAccounts()
  if (!accounts.length) throw new Error('No accounts found in wallet')
  const ownerAddress = accounts[0].address

  const rpcEndpoint = process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443'
  const grpcEndpoint = process.env.GRPC_ENDPOINT || 'https://akash-grpc.publicnode.com:443'

  // In chain-sdk 1.0.0-alpha.0+, the stargate client is created internally by createChainNodeSDK
  const chainSDK = createChainNodeSDK({
    query: { baseUrl: grpcEndpoint },
    tx: {
      baseUrl: rpcEndpoint,
      signer: wallet,
      defaultFeeAmount: '25000',
    },
  })

  const certificate = await loadOrCreateCertificate(ownerAddress, chainSDK)

  sdkContext = { wallet, chainSDK, certificate, ownerAddress }
  console.log(`[AkashSDK] Initialized for ${ownerAddress}`)
  return sdkContext
}

/**
 * Load certificate from env (AKASH_CERT_JSON), disk, or generate a new one.
 */
async function loadOrCreateCertificate(
  address: string,
  chainSDK: ChainNodeSDK,
): Promise<CertificatePem> {
  const certDir = getCertDir()
  if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true })
  const certPath = path.join(certDir, `${address}.json`)

  // Priority 1: AKASH_CERT_JSON env var (for containers with ephemeral storage)
  const certEnv = process.env.AKASH_CERT_JSON
  if (certEnv) {
    try {
      const decoded = Buffer.from(certEnv, 'base64').toString('utf-8')
      const cert = JSON.parse(decoded) as CertificatePem
      const normalized = {
        cert: normalizePem(cert.cert),
        publicKey: normalizePem(cert.publicKey),
        privateKey: normalizePem(cert.privateKey),
      }
      fs.writeFileSync(certPath, JSON.stringify(normalized))
      console.log('[AkashSDK] Loaded certificate from AKASH_CERT_JSON')
      return normalized
    } catch (e: any) {
      console.warn(`[AkashSDK] Failed to parse AKASH_CERT_JSON: ${e.message}`)
    }
  }

  // Priority 2: Disk
  if (fs.existsSync(certPath)) {
    const cert = JSON.parse(fs.readFileSync(certPath, 'utf8')) as CertificatePem
    return {
      cert: normalizePem(cert.cert),
      publicKey: normalizePem(cert.publicKey),
      privateKey: normalizePem(cert.privateKey),
    }
  }

  // Priority 3: Generate + publish on-chain
  const certManager = new CertificateManager()
  const certificate = await certManager.generatePEM(address)

  try {
    await chainSDK.akash.cert.v1.createCertificate({
      owner: address,
      cert: pemToUint8Array(certificate.cert),
      pubkey: pemToUint8Array(certificate.publicKey),
    })
    fs.writeFileSync(certPath, JSON.stringify(certificate))
    console.log('[AkashSDK] Generated and published new certificate')
    return certificate
  } catch (err: any) {
    if (err.message?.includes('certificate already exists')) {
      console.warn('[AkashSDK] Certificate exists on-chain but no local file. Regenerating...')
      return await regenerateCertificate(address, chainSDK, certPath)
    }
    throw new Error(`Could not create certificate: ${err.message}`)
  }
}

async function regenerateCertificate(
  address: string,
  chainSDK: ChainNodeSDK,
  savePath: string,
): Promise<CertificatePem> {
  // Revoke existing certs
  try {
    const certsResponse = await chainSDK.akash.cert.v1.getCertificates({
      filter: { owner: address, serial: '', state: 'valid' },
      pagination: undefined,
    })
    for (const cert of certsResponse.certificates || []) {
      const serial = cert.serial
      if (!serial) continue
      try {
        await chainSDK.akash.cert.v1.revokeCertificate({ id: { owner: address, serial } })
      } catch (e: any) {
        console.warn(`[AkashSDK] Failed to revoke cert ${serial}: ${e.message}`)
      }
    }
  } catch (e: any) {
    console.warn(`[AkashSDK] Failed to query certs for revocation: ${e.message}`)
  }

  // Generate + publish fresh cert
  const certManager = new CertificateManager()
  const newCert = await certManager.generatePEM(address)

  await chainSDK.akash.cert.v1.createCertificate({
    owner: address,
    cert: pemToUint8Array(newCert.cert),
    pubkey: pemToUint8Array(newCert.publicKey),
  })

  fs.writeFileSync(savePath, JSON.stringify(newCert))
  console.log('[AkashSDK] Regenerated certificate successfully')
  return newCert
}

// ─── Provider HTTP helpers (mTLS) ────────────────────────────────

/**
 * Send manifest to an Akash provider via mTLS HTTPS PUT.
 * Replaces `provider-services send-manifest` CLI call.
 */
export async function sendManifestHTTPS(
  sdlContent: string,
  dseq: number,
  provider: string,
  certificate: CertificatePem,
  chainSDK: ChainNodeSDK,
): Promise<void> {
  const sdl = SDL.fromString(sdlContent, 'beta3')
  const manifest = sdl.manifestSortedJSON()

  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider })
  if (!providerRes.provider) throw new Error(`Provider not found: ${provider}`)

  const uri = new URL(providerRes.provider.hostUri)
  const port = uri.port ? parseInt(uri.port, 10) : 8443

  const agent = new https.Agent({
    cert: certificate.cert,
    key: certificate.privateKey,
    rejectUnauthorized: false,
    servername: 'localhost', // triggers mTLS mode
  })

  return new Promise<void>((resolve, reject) => {
    const req = https.request(
      {
        hostname: uri.hostname,
        port,
        path: `/deployment/${dseq}/manifest`,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(manifest),
        },
        agent,
      },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk.toString() })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Manifest send failed: HTTP ${res.statusCode} — ${body}`))
          } else {
            resolve()
          }
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.write(manifest)
    req.end()
  })
}

/**
 * Query lease status from an Akash provider via mTLS HTTPS GET.
 * Replaces `provider-services lease-status` CLI call.
 */
export async function queryLeaseStatusHTTPS(
  dseq: number,
  gseq: number,
  oseq: number,
  provider: string,
  certificate: CertificatePem,
  chainSDK: ChainNodeSDK,
): Promise<{ services?: Record<string, { uris?: string[] }> }> {
  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider })
  if (!providerRes.provider) throw new Error(`Provider not found: ${provider}`)

  const uri = new URL(providerRes.provider.hostUri)
  const port = uri.port ? parseInt(uri.port, 10) : 8443

  const agent = new https.Agent({
    cert: certificate.cert,
    key: certificate.privateKey,
    rejectUnauthorized: false,
    servername: 'localhost',
  })

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: uri.hostname,
        port,
        path: `/lease/${dseq}/${gseq}/${oseq}/status`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        agent,
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Lease status query failed: HTTP ${res.statusCode}`))
          } else {
            try {
              resolve(JSON.parse(data))
            } catch {
              reject(new Error(`Invalid JSON from lease status: ${data.slice(0, 200)}`))
            }
          }
        })
        res.on('error', reject)
      },
    )
    req.on('error', reject)
    req.end()
  })
}
