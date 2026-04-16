/**
 * Akash Deployment Orchestrator
 *
 * Uses the `akash` CLI directly (execSync) for all Akash operations.
 * Mirrors PhalaOrchestrator style: stateless CLI calls, no persistent subprocess.
 *
 * Auth: AKASH_MNEMONIC env var for wallet access.
 * Provider auth: JWT (automatic in provider-services v0.10.0+, no certs needed).
 */

import { execSync, execFileSync, spawn } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { Prisma } from '@prisma/client'
import type { PrismaClient, ServiceType } from '@prisma/client'
import type { ShellSession } from '../providers/types.js'
import { providerSelector } from './providerSelector.js'
import { getEscrowService } from '../billing/escrowService.js'
import { getAkashEnv } from '../../lib/akashEnv.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'
import { createLogger } from '../../lib/logger.js'
import { withWalletLock, isWalletTx } from './walletMutex.js'
import type { TemplateGpu } from '../../templates/index.js'

const log = createLogger('akash-orchestrator')

const AKASH_CLI_TIMEOUT_MS = 120_000
const BID_POLL_INTERVAL_MS = 5000
const BID_POLL_MAX_ATTEMPTS = 10
const SERVICE_POLL_INTERVAL_MS = 5000
const SERVICE_POLL_MAX_ATTEMPTS = 24

/** Default Akash deposit in uact (1 ACT — buffer for bid/lease process). */
export const DEFAULT_DEPOSIT_UACT = 1_000_000

// Fixed by audit 2026-03: use execFileSync to prevent shell injection (was execSync with string concat)
function runAkash(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): string {
  const env = getAkashEnv()
  log.info(`Running: akash ${args.join(' ')}`)
  return execFileSync('akash', args, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

/**
 * Non-blocking version of runAkash for use in request handlers.
 * Uses execAsync to avoid freezing the Node.js event loop.
 *
 * If args[0] === 'tx' the call is serialized on the process-wide wallet
 * mutex to keep the Cosmos account sequence number monotonic. Read-only
 * commands (query, keys show, status) run without lock contention.
 */
async function runAkashAsync(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): Promise<string> {
  const { execAsync } = await import('../queue/asyncExec.js')
  const env = getAkashEnv()
  log.info(`Running (async): akash ${args.join(' ')}`)
  const invoke = () =>
    execAsync('akash', args, { env, timeout, maxBuffer: 10 * 1024 * 1024 })
  if (isWalletTx(args)) return withWalletLock(invoke)
  return invoke()
}

/**
 * Run provider-services CLI (used for manifest sending and lease operations).
 * Falls back to akash CLI if provider-services is not available.
 */
// Fixed by audit 2026-03: use execFileSync to prevent shell injection (was execSync with string concat)
function runProviderServices(
  args: string[],
  timeout = AKASH_CLI_TIMEOUT_MS
): string {
  const env = getAkashEnv()
  log.info(`Running: provider-services ${args.join(' ')}`)
  return execFileSync('provider-services', args, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

/**
 * Non-blocking provider-services call via child_process.spawn.
 * Used for log retrieval so the event loop isn't blocked during concurrent requests.
 */
function runProviderServicesAsync(
  args: string[],
  timeout = AKASH_CLI_TIMEOUT_MS
): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = getAkashEnv()
    const child = spawn('provider-services', args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`provider-services timed out after ${timeout}ms`))
    }, timeout)

    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(
          new Error(
            `provider-services exited with code ${code}: ${stderr.slice(0, 500)}`
          )
        )
      }
    })

    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/**
 * Extract the first JSON object or array from CLI output that may contain
 * non-JSON prefix text (e.g. "Broadcasting transaction...\n{...}").
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
  }

  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx =
    objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)

  if (startIdx === -1) {
    throw new SyntaxError(
      `No JSON found in CLI output: ${trimmed.slice(0, 200)}`
    )
  }

  return JSON.parse(trimmed.slice(startIdx))
}

function hasAnyServiceUris(serviceUrls: unknown): boolean {
  if (!serviceUrls || typeof serviceUrls !== 'object') return false
  return Object.values(serviceUrls as Record<string, { uris?: string[] }>).some(
    service => Array.isArray(service?.uris) && service.uris.length > 0
  )
}

export class AkashOrchestrator {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get the Akash wallet address.
   * Uses async exec to avoid blocking the event loop in request handlers.
   */
  async getAccountAddress(): Promise<string> {
    const keyName = process.env.AKASH_KEY_NAME || 'default'
    const output = await runAkashAsync(['keys', 'show', keyName, '-a'], 15_000)
    return output.trim()
  }

  /**
   * Get wallet balances
   */
  async getBalances(
    address: string
  ): Promise<Array<{ denom: string; amount: string }>> {
    const output = runAkash(
      ['query', 'bank', 'balances', address, '-o', 'json'],
      15_000
    )
    const result = extractJson(output) as {
      balances?: Array<{ denom: string; amount: string }>
    }
    return result.balances || []
  }

  /**
   * Create a deployment on Akash
   */
  async createDeployment(
    sdlPath: string,
    deposit: number
  ): Promise<{ dseq: number; owner: string }> {
    log.info('Creating deployment...')
    const output = await runAkashAsync([
      'tx',
      'deployment',
      'create',
      sdlPath,
      '--deposit',
      `${deposit}uact`,
      '-o',
      'json',
      '-y',
    ])

    const result = extractJson(output) as Record<string, unknown>
    log.info(
      `createDeployment broadcast result: code=${result.code}, txhash=${result.txhash}, has_logs=${!!(result.logs as unknown[])?.length}`
    )

    // Tx was broadcast but rejected by the mempool (e.g. account sequence mismatch from rapid re-deploys)
    const txCode =
      typeof result.code === 'number'
        ? result.code
        : typeof result.code === 'string'
          ? parseInt(result.code, 10)
          : undefined
    if (txCode !== undefined && txCode !== 0) {
      const rawLog = (result.raw_log || result.rawLog || '') as string
      throw new Error(
        `Akash tx rejected (code ${txCode}): ${rawLog.slice(0, 300)}`
      )
    }

    // Parse dseq from transaction response (populated in block broadcast mode)
    const logs = result.logs as
      | Array<{
          events?: Array<{
            type: string
            attributes?: Array<{ key: string; value: string }>
          }>
        }>
      | undefined
    let dseq: number | undefined

    if (logs) {
      for (const log of logs) {
        for (const event of log.events || []) {
          if (
            event.type === 'akash.deployment.v1.EventDeploymentCreated' ||
            event.type === 'akash.v1beta3.EventDeploymentCreated' ||
            event.type === 'message'
          ) {
            const dseqAttr = event.attributes?.find(a => a.key === 'dseq')
            if (dseqAttr) {
              dseq = parseInt(dseqAttr.value, 10)
            }
          }
        }
      }
    }

    // Fallback: query the confirmed tx by hash (sync mode doesn't include logs)
    if (!dseq && result.txhash) {
      let txResult: Record<string, unknown> | null = null
      const delays = [8000, 6000, 6000, 8000, 8000] // ~36s total; block time ~6s + indexer lag
      for (const delay of delays) {
        await new Promise(r => setTimeout(r, delay))
        try {
          const txOutput = runAkash(
            ['query', 'tx', result.txhash as string, '-o', 'json'],
            15_000
          )
          txResult = extractJson(txOutput) as Record<string, unknown>
          break
        } catch (err) {
          log.warn(
            `tx query attempt failed, retrying: ${(err as Error).message?.slice(0, 120)}`
          )
        }
      }
      if (!txResult) {
        throw new Error(
          `Transaction ${result.txhash} not found after retries — RPC may be lagging`
        )
      }

      // Try logs first (older CLI versions)
      const txLogs = txResult.logs as
        | Array<{
            events?: Array<{
              type: string
              attributes?: Array<{ key: string; value: string }>
            }>
          }>
        | undefined
      if (txLogs) {
        for (const log of txLogs) {
          for (const event of log.events || []) {
            const dseqAttr = event.attributes?.find(a => a.key === 'dseq')
            if (dseqAttr) {
              dseq = parseInt(dseqAttr.value, 10)
              break
            }
          }
          if (dseq) break
        }
      }

      // Fallback: parse dseq from tx.body.messages (akash CLI v1.1.1+ returns empty logs)
      if (!dseq) {
        const tx = txResult.tx as
          | { body?: { messages?: Array<{ id?: { dseq?: string } }> } }
          | undefined
        const msgDseq = tx?.body?.messages?.[0]?.id?.dseq
        if (msgDseq) {
          dseq = parseInt(msgDseq, 10)
          log.info(
            `Parsed dseq from tx.body.messages: ${dseq}`
          )
        }
      }
    }

    if (!dseq || isNaN(dseq) || dseq <= 0) {
      const safeResult = JSON.stringify(result, (_k, v) =>
        typeof v === 'bigint' ? v.toString() : v
      ).slice(0, 500)
      throw new Error(
        `Failed to create deployment: could not extract dseq from response. Broadcast result: ${safeResult}`
      )
    }

    const owner = await this.getAccountAddress()
    log.info(
      `Deployment created: dseq=${dseq}, owner=${owner}`
    )
    return { dseq, owner }
  }

  /**
   * Top up an existing deployment's on-chain escrow.
   * Used after CREATE_LEASE when the actual price is known, to ensure
   * at least 1 hour of runway beyond the initial deposit.
   */
  async topUpDeploymentDeposit(dseq: number, amountUact: number): Promise<void> {
    if (amountUact <= 0) return
    log.info({ dseq, amountUact }, 'Topping up deployment escrow')
    const output = await runAkashAsync([
      'tx',
      'escrow',
      'deposit',
      'deployment',
      `${amountUact}uact`,
      '--dseq',
      String(dseq),
      '-y',
      '-o', 'json',
    ])

    // A non-zero code here means the chain accepted the tx envelope but the
    // state transition was rejected (e.g. insufficient wallet funds, unknown
    // dseq, deployment already closed). We MUST throw so callers treat this as
    // a failure — a silent return previously caused chain-escrow depletion to
    // go unnoticed until the provider closed the lease.
    let result: Record<string, unknown>
    try {
      result = extractJson(output) as Record<string, unknown>
    } catch {
      // Parse failure after a successful CLI invocation usually means the
      // broadcast went through but stdout had trailing noise. Keep as warn.
      log.warn({ dseq, amountUact }, 'Escrow top-up completed but could not parse TX response')
      return
    }

    const code =
      typeof result.code === 'number'
        ? result.code
        : typeof result.code === 'string'
          ? parseInt(result.code, 10)
          : 0
    if (code !== 0) {
      const rawLog = (result.raw_log || result.rawLog || '') as string
      const msg = `Escrow top-up TX rejected on-chain (code ${code}): ${rawLog.slice(0, 300)}`
      log.error({ dseq, amountUact, code, rawLog: rawLog.slice(0, 200) }, msg)
      throw new Error(msg)
    }
    log.info({ dseq, amountUact, txhash: result.txhash }, 'Deployment escrow topped up')
  }

  /**
   * Get bids for a deployment
   */
  async getBids(
    owner: string,
    dseq: number
  ): Promise<
    Array<{
      bidId: { provider: string; gseq: number; oseq: number }
      price: { amount: string; denom: string }
      provider?: { hostUri?: string }
    }>
  > {
    const output = runAkash(
      [
        'query',
        'market',
        'bid',
        'list',
        '--owner',
        owner,
        '--dseq',
        String(dseq),
        '-o',
        'json',
      ],
      15_000
    )

    const result = extractJson(output) as {
      bids?: Array<{
        bid?: {
          bid_id?: Record<string, unknown>
          id?: Record<string, unknown>
          price?: Record<string, unknown>
        }
        bid_id?: Record<string, unknown>
        id?: Record<string, unknown>
        price?: Record<string, unknown>
      }>
    }

    if (!result.bids || result.bids.length === 0) {
      return []
    }

    return result.bids.map(b => {
      const bid = b.bid || b
      const bidId = (bid.bid_id || bid.id || {}) as Record<string, unknown>
      const price = (bid.price || {}) as Record<string, unknown>
      return {
        bidId: {
          provider: String(bidId.provider || ''),
          gseq: Number(bidId.gseq || 1),
          oseq: Number(bidId.oseq || 1),
        },
        price: {
          amount: String(price.amount || '0'),
          denom: String(price.denom || 'uact'),
        },
      }
    })
  }

  /**
   * Create a lease with a provider
   */
  async createLease(
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string
  ): Promise<void> {
    await runAkashAsync([
      'tx',
      'market',
      'lease',
      'create',
      '--dseq',
      String(dseq),
      '--gseq',
      String(gseq),
      '--oseq',
      String(oseq),
      '--provider',
      provider,
      '-o',
      'json',
      '-y',
    ])
    // Wait for lease to be confirmed
    await new Promise(r => setTimeout(r, 6000))
  }

  /**
   * Send manifest to provider
   */
  async sendManifest(
    sdlPath: string,
    dseq: number,
    provider: string
  ): Promise<void> {
    try {
      runProviderServices([
        'send-manifest',
        sdlPath,
        '--dseq',
        String(dseq),
        '--provider',
        provider,
      ])
    } catch (err) {
      // Fallback: retry once after a short delay (provider may not have lease ready)
      log.warn(
        `Manifest send failed, retrying in 5s: ${err instanceof Error ? err.message : err}`
      )
      await new Promise(r => setTimeout(r, 5000))
      runProviderServices([
        'send-manifest',
        sdlPath,
        '--dseq',
        String(dseq),
        '--provider',
        provider,
      ])
    }
  }

  /**
   * Get service URLs from provider
   */
  async getServices(
    dseq: number,
    provider: string
  ): Promise<Record<string, { uris: string[] }>> {
    const output = await runProviderServicesAsync(
      ['lease-status', '--dseq', String(dseq), '--provider', provider],
      15_000
    )

    const result = extractJson(output) as {
      services?: Record<string, { uris?: string[] }>
      forwarded_ports?: Record<
        string,
        Array<{ host: string; externalPort: number }>
      >
    }
    const services = result.services || {}
    const forwardedPorts = result.forwarded_ports || {}
    const out: Record<string, { uris: string[] }> = {}
    for (const [k, v] of Object.entries(services)) {
      const uris = [...(v.uris || [])]
      if (forwardedPorts[k]?.length) {
        for (const fp of forwardedPorts[k]) {
          uris.push(`${fp.host}:${fp.externalPort}`)
        }
      }
      out[k] = { uris }
    }
    return out
  }

  /**
   * Get per-container health from lease-status. Returns richer data than
   * getServices, including replica counts and container state.
   */
  async getLeaseHealth(
    dseq: number,
    provider: string
  ): Promise<Array<{
    name: string
    ready: boolean
    total: number
    available: number
    readyReplicas: number
    uris: string[]
  }>> {
    const output = await runProviderServicesAsync(
      ['lease-status', '--dseq', String(dseq), '--provider', provider],
      15_000
    )

    const result = extractJson(output) as {
      services?: Record<
        string,
        {
          name?: string
          uris?: string[]
          replicas?: number
          available_replicas?: number
          ready_replicas?: number
          updated_replicas?: number
        }
      >
      forwarded_ports?: Record<
        string,
        Array<{ host: string; externalPort: number }>
      >
    }

    const services = result.services || {}
    const forwardedPorts = result.forwarded_ports || {}
    const containers: Array<{
      name: string
      ready: boolean
      total: number
      available: number
      readyReplicas: number
      uris: string[]
    }> = []

    for (const [k, v] of Object.entries(services)) {
      const uris = [...(v.uris || [])]
      if (forwardedPorts[k]?.length) {
        for (const fp of forwardedPorts[k]) {
          uris.push(`${fp.host}:${fp.externalPort}`)
        }
      }
      const total = v.replicas ?? 1
      const available = v.available_replicas ?? 0
      const readyReplicas = v.ready_replicas ?? 0
      containers.push({
        name: k,
        ready: readyReplicas >= total && total > 0,
        total,
        available,
        readyReplicas,
        uris,
      })
    }

    return containers
  }

  /**
   * Background backfill for deployments where URIs weren't available during
   * the initial polling window. Retries every 10s for up to 3 minutes.
   */
  private async backfillServiceUrls(
    deploymentId: string,
    dseq: number,
    provider: string
  ): Promise<void> {
    const BACKFILL_INTERVAL_MS = 10_000
    const BACKFILL_MAX_ATTEMPTS = 18 // 18 * 10s = 3 minutes

    let consecutiveErrors = 0

    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, BACKFILL_INTERVAL_MS))

      // Check if the deployment is still ACTIVE (might have been closed)
      const dep = await this.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
        select: { status: true, serviceUrls: true },
      })
      if (!dep || dep.status !== 'ACTIVE') {
        log.info(
          `Backfill: deployment ${deploymentId} no longer active, stopping.`
        )
        return
      }

      // If serviceUrls got populated by another path, stop
      if (hasAnyServiceUris(dep.serviceUrls)) {
        log.info(
          `Backfill: URIs already populated for ${deploymentId}, done.`
        )
        return
      }

      try {
        const services = await this.getServices(dseq, provider)
        consecutiveErrors = 0
        const hasUris = Object.values(services).some(s => s.uris?.length > 0)
        if (hasUris) {
          await this.prisma.akashDeployment.update({
            where: { id: deploymentId },
            data: { serviceUrls: services },
          })
          log.info(
            `Backfill: URIs populated for ${deploymentId} after ${(i + 1) * 10}s`
          )
          return
        }
      } catch (err) {
        consecutiveErrors++
        log.warn(
          `Backfill getServices attempt ${i + 1} failed for ${deploymentId}: ${err instanceof Error ? err.message : err}`
        )

        // If the provider consistently rejects us, the lease is likely dead
        if (consecutiveErrors >= 6) {
          log.error(
            `Backfill: ${consecutiveErrors} consecutive provider errors for ${deploymentId} — lease likely dead, marking CLOSED`
          )
          await this.prisma.akashDeployment.updateMany({
            where: { id: deploymentId, status: 'ACTIVE' },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
          return
        }
      }
    }

    log.warn(
      `Backfill: gave up waiting for URIs on ${deploymentId} after 3 minutes`
    )
  }

  /**
   * Resume DEPLOYING deployments whose in-process POLL_URLS loop was lost
   * due to server restart (local dev without QStash). Re-enqueues the
   * POLL_URLS step so the readiness check continues.
   */
  async resumeDeployingDeployments(): Promise<void> {
    try {
      const deploying = await this.prisma.akashDeployment.findMany({
        where: {
          status: 'DEPLOYING',
          provider: { not: null },
          dseq: { gt: 0 },
        },
        select: { id: true, dseq: true, provider: true },
      })

      if (deploying.length === 0) return

      log.info(`Found ${deploying.length} DEPLOYING deployment(s) — resuming POLL_URLS`)

      const { handleAkashStep } = await import('../queue/webhookHandler.js')

      for (const dep of deploying) {
        handleAkashStep({
          step: 'POLL_URLS',
          deploymentId: dep.id,
          attempt: 1,
        }).catch(err =>
          log.error({ err, deploymentId: dep.id }, 'Failed to resume POLL_URLS')
        )
      }
    } catch (err) {
      log.error({ err }, 'resumeDeployingDeployments error')
    }
  }

  /**
   * Startup scan: find all ACTIVE Akash deployments with empty serviceUrls
   * and kick off backfills for them. Call this once at server startup so
   * interrupted backfills (e.g. from pod restarts) are resumed automatically.
   */
  async resumePendingBackfills(): Promise<void> {
    try {
      const activeDeployments = await this.prisma.akashDeployment.findMany({
        where: {
          status: 'ACTIVE',
        },
        select: { id: true, dseq: true, provider: true, serviceUrls: true },
      })
      const stale = activeDeployments.filter(
        dep => !hasAnyServiceUris(dep.serviceUrls)
      )

      if (stale.length === 0) {
        log.info(
          'No ACTIVE deployments with missing URIs.'
        )
        return
      }

      log.info(
        `Found ${stale.length} ACTIVE deployment(s) with missing URIs. Starting backfills...`
      )

      for (const dep of stale) {
        const dseq = Number(dep.dseq)
        if (!dep.provider) continue
        this.backfillServiceUrls(dep.id, dseq, dep.provider).catch(err =>
          log.error(
            { err },
            `Startup backfill failed for ${dep.id}`
          )
        )
      }
    } catch (err) {
      log.error({ err }, 'resumePendingBackfills error')
    }
  }

  /**
   * Close a deployment.
   *
   * Throws if the chain rejects the tx (e.g. deployment already closed,
   * deployment not found). Callers that tolerate benign "already gone" states
   * match on the thrown message (which includes the chain's raw_log) using
   * patterns like /deployment not found|deployment closed|not active|does not exist/.
   */
  async closeDeployment(dseq: number): Promise<void> {
    const output = await runAkashAsync([
      'tx',
      'deployment',
      'close',
      '--dseq',
      String(dseq),
      '-o',
      'json',
      '-y',
    ])

    let result: Record<string, unknown>
    try {
      result = extractJson(output) as Record<string, unknown>
    } catch {
      // CLI exited 0 but output was unparseable — treat as provisional success
      // rather than block close paths. Downstream liveness reconciliation will
      // catch any stuck-open deployment.
      log.warn({ dseq }, 'Close TX completed but response could not be parsed')
      return
    }

    const code =
      typeof result.code === 'number'
        ? result.code
        : typeof result.code === 'string'
          ? parseInt(result.code, 10)
          : 0
    if (code !== 0) {
      const rawLog = (result.raw_log || result.rawLog || '') as string
      const msg = `Close TX rejected on-chain (code ${code}): ${rawLog.slice(0, 300)}`
      log.error({ dseq, code, rawLog: rawLog.slice(0, 200) }, msg)
      throw new Error(msg)
    }
    log.info({ dseq, txhash: result.txhash }, 'Deployment close TX accepted')
  }

  /**
   * Get deployment logs via async CLI spawn (non-blocking).
   * Falls back to mTLS REST if the CLI binary is unavailable.
   */
  async getLogs(
    dseq: number,
    provider: string,
    service?: string,
    tail?: number,
    _gseq = 1,
    _oseq = 1
  ): Promise<string> {
    const args = ['lease-logs', '--dseq', String(dseq), '--provider', provider]
    if (service) args.push('--service', service)
    if (tail) args.push('--tail', String(tail))

    try {
      return await runProviderServicesAsync(args, 45_000)
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 300) ?? 'unknown error'
      log.warn(`getLogs failed for dseq=${dseq}: ${msg}`)
      throw new Error(`Failed to fetch logs for dseq=${dseq}: ${msg}`)
    }
  }

  /**
   * Spawn an interactive shell session via `provider-services lease-shell`.
   * Uses node-pty to allocate a pseudo-terminal so `--tty` works
   * (provider-services requires its stdin to be a real TTY).
   */
  async getShell(
    dseq: number,
    provider: string,
    service: string,
    command = '/bin/bash'
  ): Promise<ShellSession> {
    const env = getAkashEnv()
    const args = [
      'lease-shell',
      service,
      command,
      '--dseq', String(dseq),
      '--provider', provider,
      '--stdin',
      '--tty',
    ]

    log.info(`Spawning shell: provider-services ${args.join(' ')}`)

    // node-pty is optional — fall back to spawn without --tty if unavailable
    let pty: any
    try {
      const { createRequire } = await import('module')
      const require = createRequire(import.meta.url)
      pty = require('node-pty')
    } catch {
      log.warn('node-pty not available, falling back to spawn without --tty')
      return this.getShellFallback(env, args.filter(a => a !== '--tty'))
    }

    // Resolve full path — node-pty's posix_spawnp may not search PATH correctly
    let binPath = 'provider-services'
    try {
      binPath = execFileSync('which', ['provider-services'], { encoding: 'utf-8' }).trim()
    } catch { /* fall through with bare name */ }

    const ptyProcess = pty.spawn(binPath, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env,
    })

    let killed = false

    const session: ShellSession = {
      write(data: Buffer | string) {
        if (!killed) {
          ptyProcess.write(typeof data === 'string' ? data : data.toString())
        }
      },
      onData(callback: (data: Buffer) => void) {
        ptyProcess.onData((data: string) => {
          callback(Buffer.from(data))
        })
      },
      onExit(callback: (code: number | null) => void) {
        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          killed = true
          callback(exitCode)
        })
      },
      resize(cols: number, rows: number) {
        if (!killed) {
          ptyProcess.resize(cols, rows)
        }
      },
      kill() {
        if (!killed) {
          killed = true
          ptyProcess.kill()
        }
      },
    }

    return session
  }

  private getShellFallback(env: Record<string, string>, args: string[]): ShellSession {
    const child = spawn('provider-services', args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let killed = false

    return {
      write(data: Buffer | string) {
        if (!killed && child.stdin.writable) {
          child.stdin.write(data)
        }
      },
      onData(callback: (data: Buffer) => void) {
        child.stdout.on('data', callback)
        child.stderr.on('data', callback)
      },
      onExit(callback: (code: number | null) => void) {
        child.on('close', (code) => {
          killed = true
          callback(code)
        })
      },
      kill() {
        if (!killed) {
          killed = true
          child.kill('SIGTERM')
        }
      },
    }
  }

  // ========================================
  // High-level deployment operations
  // ========================================

  /**
   * Deploy any service to Akash (full flow).
   *
   * When QStash is available (production), this method creates the DB record
   * and enqueues the first step, returning immediately. The deployment then
   * proceeds through the step pipeline in the background with automatic
   * retry (up to 3 times) on failure.
   *
   * When QStash is not available (local dev), the steps execute in-process
   * sequentially via the same step handlers, preserving the same code path.
   */
  async deployService(
    serviceId: string,
    options: {
      deposit?: number
      sdlContent?: string
      skipEnvInjection?: boolean
      resourceOverrides?: {
        cpu?: number
        memory?: string
        storage?: string
        gpu?: { units: number; vendor: string; model?: string } | null
      }
      baseImage?: string
    } = {}
  ): Promise<string> {
    const deposit = options.deposit || DEFAULT_DEPOSIT_UACT

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: {
        site: true,
        afFunction: true,
      },
    })

    if (!service) {
      throw new Error(`Service not found: ${serviceId}`)
    }

    // Close any existing ACTIVE deployments for this service
    const existingDeployments = await this.prisma.akashDeployment.findMany({
      where: {
        serviceId: service.id,
        status: 'ACTIVE',
      },
    })

    const { isQStashEnabled, publishJob } =
      await import('../queue/qstashClient.js')

    if (existingDeployments.length > 0) {
      log.info(
        `Closing ${existingDeployments.length} existing deployment(s) for service ${service.name}...`
      )

      for (const existing of existingDeployments) {
        try {
          const existingDseq = Number(existing.dseq)
          log.info(`Closing previous deployment dseq=${existingDseq} on-chain...`)
          await this.closeDeployment(existingDseq)

          await this.prisma.akashDeployment.update({
            where: { id: existing.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
          log.info(
            `Closed deployment dseq=${existingDseq}`
          )
        } catch (err: any) {
          log.warn(
            `Failed to close deployment dseq=${existing.dseq}: ${err.message} — keeping as ACTIVE, may need manual close`
          )
        }
      }
    }

    // Prepare SDL content
    let sdlContent =
      options.sdlContent || (await this.generateSDLForService(service, options.resourceOverrides, options.baseImage))
    if (!options.skipEnvInjection) {
      sdlContent = await this.injectPersistedEnvVars(
        service.id,
        service.projectId,
        sdlContent
      )
    }

    // Create DB record with CREATING status.
    // Use negative timestamp as temporary dseq — the real dseq is assigned in SUBMIT_TX.
    // This avoids the @@unique([owner, dseq]) constraint since real dseqs are always positive.
    const owner = await this.getAccountAddress()
    const tempDseq = BigInt(-Date.now())
    const deployment = await this.prisma.akashDeployment.create({
      data: {
        owner,
        dseq: tempDseq,
        sdlContent,
        serviceId: service.id,
        afFunctionId:
          service.type === 'FUNCTION' ? service.afFunction?.id : null,
        siteId: service.type === 'SITE' ? service.site?.id : null,
        depositUakt: BigInt(deposit),
        status: 'CREATING',
        retryCount: 0,
      },
    })

    log.info(
      `Created deployment record ${deployment.id}, enqueuing SUBMIT_TX step...`
    )

    // Enqueue the first step — QStash or in-process depending on environment
    const { handleAkashStep } = await import('../queue/webhookHandler.js')

    if (isQStashEnabled()) {
      await publishJob('/queue/akash/step', {
        step: 'SUBMIT_TX',
        deploymentId: deployment.id,
      })
    } else {
      // Local dev: run step pipeline in-process (non-blocking — fire and forget)
      handleAkashStep({ step: 'SUBMIT_TX', deploymentId: deployment.id }).catch(
        err => {
          log.error(
            { err },
            'In-process step pipeline failed'
          )
        }
      )
    }

    return deployment.id
  }

  /**
   * Deploy a function to Akash (convenience method)
   */
  async deployFunction(
    functionId: string,
    sourceCode: string,
    functionName: string,
    deposit = DEFAULT_DEPOSIT_UACT
  ): Promise<string> {
    const func = await this.prisma.aFFunction.findUnique({
      where: { id: functionId },
      select: { serviceId: true },
    })

    if (!func?.serviceId) {
      throw new Error('Function has no associated service in the registry')
    }

    return this.deployService(func.serviceId, { deposit })
  }

  /**
   * Generate SDL based on service type.
   */
  private async generateSDLForService(service: {
    id: string
    type: ServiceType
    name: string
    slug: string
    templateId?: string | null
    containerPort?: number | null
    dockerImage?: string | null
    site?: { id: string } | null
    afFunction?: { id: string; sourceCode: string | null } | null
  }, resourceOverrides?: {
    cpu?: number
    memory?: string
    storage?: string
    gpu?: { units: number; vendor: string; model?: string } | null
  }, baseImage?: string): Promise<string> {
    if (service.type === 'FUNCTION') {
      if (!service.afFunction?.sourceCode) {
        throw new Error('Function has no source code')
      }
      return this.generateFunctionSDL(
        service.slug,
        service.afFunction.sourceCode
      )
    }

    const { getTemplateById, generateSDLFromTemplate } =
      await import('../../templates/index.js')

    // Priority 1: Use the service's own templateId (set when deployed from a template).
    // This ensures redeployments use the same template config (ports, env, resources)
    // that was used for the initial deployment.
    if (service.templateId) {
      const template = getTemplateById(service.templateId)
      if (template) {
        // Composite templates (with components) produce multi-service SDLs that
        // cannot be regenerated from generateSDLFromTemplate (which is single-service).
        // Reuse the SDL from the most recent deployment for this service instead.
        if (template.components?.length) {
          const lastDeployment = await this.prisma.akashDeployment.findFirst({
            where: {
              serviceId: service.id,
              sdlContent: { not: '' },
            },
            orderBy: { createdAt: 'desc' },
            select: { sdlContent: true, savedSdl: true },
          })
          const previousSdl = lastDeployment?.savedSdl ?? lastDeployment?.sdlContent
          if (previousSdl) {
            log.info(
              `Reusing composite SDL from previous deployment for service '${service.slug}' (template '${service.templateId}')`
            )
            return previousSdl
          }
          log.warn(
            `Composite template '${service.templateId}' but no previous SDL found for service '${service.slug}'. Cannot regenerate composite SDL from sidebar deploy — use the template deploy flow instead.`
          )
          throw new Error(
            `This service was deployed from the composite template '${template.name}'. Please redeploy from the template catalog to include all components (database, assets, etc).`
          )
        }

        log.info(
          { templateId: service.templateId, hasResourceOverrides: !!resourceOverrides },
          `Generating SDL from template '${service.templateId}' for service '${service.slug}'`
        )
        return generateSDLFromTemplate(template, {
          serviceName: service.slug,
          resourceOverrides: resourceOverrides
            ? {
                cpu: resourceOverrides.cpu,
                memory: resourceOverrides.memory,
                storage: resourceOverrides.storage,
                gpu: resourceOverrides.gpu === null
                  ? null
                  : resourceOverrides.gpu
                    ? { units: resourceOverrides.gpu.units, vendor: resourceOverrides.gpu.vendor as TemplateGpu['vendor'], model: resourceOverrides.gpu.model }
                    : undefined,
              }
            : undefined,
        })
      }
      log.warn(
        `Service '${service.slug}' has templateId '${service.templateId}' but template not found. Falling back.`
      )
    }

    // Priority 2: Custom Docker image or user-selected base image
    const effectiveImage = service.dockerImage || baseImage
    if (effectiveImage) {
      const port = service.containerPort || 80
      log.info(
        `Generating SDL for Docker image '${effectiveImage}' (port ${port}) for service '${service.slug}'`
      )
      return this.generateCustomDockerSDL(
        service.slug,
        effectiveImage,
        port,
        resourceOverrides
      )
    }

    // Priority 3: Default type-to-template mapping (for services created without a template)
    const typeToTemplate: Record<string, string> = {
      SITE: 'nginx-site',
      VM: 'node-ws-gameserver',
      DATABASE: 'postgres',
    }

    const fallbackTemplateId = typeToTemplate[service.type]
    if (fallbackTemplateId) {
      const template = getTemplateById(fallbackTemplateId)
      if (template) {
        return generateSDLFromTemplate(template, { serviceName: service.slug })
      }
    }

    // Priority 4: Hardcoded fallback SDLs
    switch (service.type) {
      case 'SITE':
        return this.generateSiteSDL(service.slug)
      case 'VM':
        return this.generateVMSDL(service.slug)
      case 'DATABASE':
        return this.generateDatabaseSDL(service.slug)
      default:
        throw new Error(
          `SDL generation not supported for service type: ${service.type}`
        )
    }
  }

  /**
   * Fetch persisted env vars for a service, resolve `{{services.*}}`
   * interpolations using sibling services, then inject them into the SDL.
   * If the SDL already has env vars, the persisted ones are merged (persisted wins).
   */
  private async injectPersistedEnvVars(
    serviceId: string,
    projectId: string,
    sdlContent: string
  ): Promise<string> {
    const { buildServiceMap, resolveEnvVars } =
      await import('../../utils/envInterpolation.js')

    const persistedVars = await this.prisma.serviceEnvVar.findMany({
      where: { serviceId },
    })
    if (persistedVars.length === 0) return sdlContent

    // Fetch sibling services for interpolation
    const siblings = await this.prisma.service.findMany({
      where: { projectId },
      include: {
        envVars: true,
        ports: true,
      },
    })
    const serviceMap = buildServiceMap(
      siblings.map((s: any) => ({
        slug: s.slug,
        internalHostname: s.internalHostname,
        envVars: s.envVars.map((e: any) => ({ key: e.key, value: e.value })),
        ports: s.ports.map((p: any) => ({
          containerPort: p.containerPort,
          publicPort: p.publicPort,
        })),
      }))
    )

    const resolved = resolveEnvVars(
      persistedVars.map((v: any) => ({ key: v.key, value: v.value })),
      serviceMap
    )

    // Merge into SDL: find the `env:` block or inject one
    const envLines = resolved
      .map(({ key, value }) => `      - ${key}=${value}`)
      .join('\n')

    // If the SDL already has an env block, append to it
    const envBlockRegex = /(    env:\n)((?:      - .+\n)*)/
    if (envBlockRegex.test(sdlContent)) {
      return sdlContent.replace(
        envBlockRegex,
        (match, header, existingLines) => {
          // Parse existing keys to avoid duplicates (persisted wins)
          const existingKeys = new Set(
            existingLines
              .split('\n')
              .filter((l: string) => l.trim().startsWith('- '))
              .map((l: string) => l.trim().replace(/^- /, '').split('=')[0])
          )
          const newLines = resolved
            .filter(({ key }) => !existingKeys.has(key))
            .map(({ key, value }) => `      - ${key}=${value}\n`)
            .join('')
          // Override existing keys with persisted values
          let updatedExisting = existingLines
          for (const { key, value } of resolved) {
            if (existingKeys.has(key)) {
              const keyRegex = new RegExp(`(      - ${key})=.*\n`)
              updatedExisting = updatedExisting.replace(
                keyRegex,
                `$1=${value}\n`
              )
            }
          }
          return header + updatedExisting + newLines
        }
      )
    }

    // No env block — inject before `expose:`
    const exposeIdx = sdlContent.indexOf('    expose:')
    if (exposeIdx !== -1) {
      return (
        sdlContent.slice(0, exposeIdx) +
        `    env:\n${envLines}\n` +
        sdlContent.slice(exposeIdx)
      )
    }

    return sdlContent
  }

  /**
   * Generate SDL for a custom Docker image with a specific container port.
   */
  private generateCustomDockerSDL(
    name: string,
    image: string,
    containerPort: number,
    resourceOverrides?: {
      cpu?: number
      memory?: string
      storage?: string
      gpu?: { units: number; vendor: string; model?: string } | null
    }
  ): string {
    const needsKeepAlive = /^(ubuntu|debian|alpine|centos|fedora|busybox|amazonlinux|rockylinux|almalinux)(:|$)/i.test(image)

    const argsBlock = needsKeepAlive
      ? `    args:
      - sh
      - -c
      - "echo 'Container ready on port ${containerPort}'; tail -f /dev/null"
`
      : ''

    const cpu = resourceOverrides?.cpu ?? 0.5
    const memory = resourceOverrides?.memory ?? '512Mi'
    const storage = resourceOverrides?.storage ?? '1Gi'
    const gpu = resourceOverrides?.gpu

    let gpuBlock = ''
    if (gpu && gpu.units > 0) {
      const hasSpecificModel = gpu.model && gpu.model !== '*'
      const modelLine = hasSpecificModel
        ? `
                - model: ${gpu.model}`
        : ''
      gpuBlock = `
        gpu:
          units: ${gpu.units}
          attributes:
            vendor:
              ${gpu.vendor}:${modelLine}`
    }

    return `---
version: "2.0"

services:
  ${name}:
    image: ${image}
${argsBlock}    expose:
      - port: ${containerPort}
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: ${cpu}
        memory:
          size: ${memory}
        storage:
          size: ${storage}${gpuBlock}

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        ${name}:
          denom: uact
          amount: ${gpu && gpu.units > 0 ? 10000 : 1000}

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  /**
   * Generate SDL for a Bun/Hono function
   */
  private generateFunctionSDL(name: string, sourceCode: string): string {
    const base64Code = Buffer.from(sourceCode, 'utf-8').toString('base64')

    const imports = sourceCode.match(/from ['"]([^'"./][^'"]*)['"]/g) || []
    const packages = [
      ...new Set(
        imports
          .map(i => {
            const match = i.match(/from ['"]([^'"./][^'"]*)['"]/)?.[1]
            return (
              match
                ?.split('/')
                .slice(0, match.startsWith('@') ? 2 : 1)
                .join('/') || ''
            )
          })
          .filter(Boolean)
      ),
    ]

    const installCmd =
      packages.length > 0
        ? `bun add ${packages.join(' ')}`
        : 'echo "No dependencies to install"'

    const script = [
      'set -e',
      "echo 'Deploying function...'",
      'mkdir -p /app',
      'cd /app',
      'bun init -y',
      `echo '${base64Code}' | base64 -d > /app/index.ts`,
      `echo 'Installing dependencies: ${packages.join(', ') || 'none'}'`,
      `${installCmd} || { echo 'ERROR: bun add failed'; exit 1; }`,
      "echo 'Starting function on port 3000...'",
      'exec bun run index.ts',
    ].join(' && ')

    return `---
version: "2.0"

services:
  ${name}:
    image: oven/bun:1.1-alpine
    env:
      - PORT=3000
    args:
      - sh
      - -c
      - "${script}"
    expose:
      - port: 3000
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 1Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 1000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  private generateSiteSDL(name: string): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: nginx:alpine
    env:
      - NGINX_PORT=80
    expose:
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.25
        memory:
          size: 256Mi
        storage:
          size: 1Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  // Fixed by audit 2026-03: generate random password per deployment (was hardcoded 'akash')
  private generateVMSDL(name: string): string {
    const password = randomBytes(16).toString('hex')
    return `---
version: "2.0"

services:
  ${name}:
    image: ubuntu:22.04
    args:
      - sh
      - -c
      - |
        apt-get update && apt-get install -y openssh-server
        mkdir /run/sshd
        echo 'root:${password}' | chpasswd
        sed -i 's/#PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
        /usr/sbin/sshd -D
    expose:
      - port: 22
        as: 22
        to:
          - global: true
      - port: 80
        as: 80
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 1
        memory:
          size: 1Gi
        storage:
          size: 10Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 2000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  // Fixed by audit 2026-03: generate random password per deployment (was hardcoded 'akash_secure_password')
  private generateDatabaseSDL(name: string): string {
    const dbPassword = randomBytes(20).toString('hex')
    return `---
version: "2.0"

services:
  ${name}:
    image: postgres:15-alpine
    env:
      - POSTGRES_DB=akashdb
      - POSTGRES_USER=akash
      - POSTGRES_PASSWORD=${dbPassword}
    expose:
      - port: 5432
        as: 5432
        to:
          - global: true

profiles:
  compute:
    ${name}:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 1Gi
        storage:
          size: 10Gi

  placement:
    dcloud:
      pricing:
        ${name}:
          denom: uact
          amount: 1500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }
}

// Singleton instance
let orchestratorInstance: AkashOrchestrator | null = null

export function getAkashOrchestrator(prisma: PrismaClient): AkashOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AkashOrchestrator(prisma)
  }
  return orchestratorInstance
}
