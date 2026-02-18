/**
 * Akash Deployment Orchestrator
 *
 * Uses the `akash` CLI directly (execSync) for all Akash operations.
 * Mirrors PhalaOrchestrator style: stateless CLI calls, no persistent subprocess.
 *
 * Auth: AKASH_MNEMONIC env var for wallet access.
 * Cert: AKASH_CERT_JSON env var for mTLS with providers.
 */

import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Prisma } from '@prisma/client'
import type { PrismaClient, ServiceType } from '@prisma/client'
import { providerSelector } from './providerSelector.js'
import { getEscrowService } from '../billing/escrowService.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'

const AKASH_CLI_TIMEOUT_MS = 120_000
const BID_POLL_INTERVAL_MS = 5000
const BID_POLL_MAX_ATTEMPTS = 10
const SERVICE_POLL_INTERVAL_MS = 5000
const SERVICE_POLL_MAX_ATTEMPTS = 24

function getAkashEnv(): Record<string, string> {
  if (!process.env.AKASH_MNEMONIC) {
    throw new Error('AKASH_MNEMONIC is not set')
  }
  const keyName = process.env.AKASH_KEY_NAME || 'default'
  return {
    ...(process.env as Record<string, string>),
    AKASH_KEY_NAME: keyName,
    AKASH_FROM: keyName,
    AKASH_KEYRING_BACKEND: 'test',
    AKASH_NODE: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
    AKASH_CHAIN_ID: process.env.AKASH_CHAIN_ID || 'akashnet-2',
    AKASH_GAS: 'auto',
    AKASH_GAS_ADJUSTMENT: '1.5',
    AKASH_GAS_PRICES: '0.025uakt',
    AKASH_BROADCAST_MODE: 'sync',
    AKASH_YES: 'true',
    HOME: process.env.HOME || '/home/nodejs',
  }
}

function runAkash(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): string {
  const env = getAkashEnv()
  const cmd = `akash ${args.join(' ')}`
  console.log(`[AkashOrchestrator] Running: ${cmd}`)
  return execSync(cmd, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

/**
 * Run provider-services CLI (used for manifest sending and lease operations).
 * Falls back to akash CLI if provider-services is not available.
 */
function runProviderServices(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): string {
  const env = getAkashEnv()
  const cmd = `provider-services ${args.join(' ')}`
  console.log(`[AkashOrchestrator] Running: ${cmd}`)
  return execSync(cmd, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
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
  const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)

  if (startIdx === -1) {
    throw new SyntaxError(`No JSON found in CLI output: ${trimmed.slice(0, 200)}`)
  }

  return JSON.parse(trimmed.slice(startIdx))
}

export class AkashOrchestrator {
  constructor(private prisma: PrismaClient) {}

  /**
   * Get the Akash wallet address
   */
  async getAccountAddress(): Promise<string> {
    const output = runAkash(['keys', 'show', 'default', '-a'], 15_000)
    return output.trim()
  }

  /**
   * Get wallet balances
   */
  async getBalances(address: string): Promise<Array<{ denom: string; amount: string }>> {
    const output = runAkash(['query', 'bank', 'balances', address, '-o', 'json'], 15_000)
    const result = extractJson(output) as { balances?: Array<{ denom: string; amount: string }> }
    return result.balances || []
  }

  /**
   * Create a deployment on Akash
   */
  async createDeployment(sdlPath: string, deposit: number): Promise<{ dseq: number; owner: string }> {
    console.log('[AkashOrchestrator] Creating deployment...')
    const output = runAkash([
      'tx', 'deployment', 'create', sdlPath,
      '--deposit', `${deposit}uakt`,
      '-o', 'json',
      '-y',
    ])

    const result = extractJson(output) as Record<string, unknown>

    // Parse dseq from transaction response
    const logs = result.logs as Array<{ events?: Array<{ type: string; attributes?: Array<{ key: string; value: string }> }> }> | undefined
    let dseq: number | undefined

    if (logs) {
      for (const log of logs) {
        for (const event of log.events || []) {
          if (event.type === 'akash.v1beta3.EventDeploymentCreated' || event.type === 'message') {
            const dseqAttr = event.attributes?.find(a => a.key === 'dseq')
            if (dseqAttr) {
              dseq = parseInt(dseqAttr.value, 10)
            }
          }
        }
      }
    }

    // Fallback: check raw_log or txhash and query
    if (!dseq && result.txhash) {
      // Wait for tx to be included in a block
      await new Promise(r => setTimeout(r, 6000))
      const txOutput = runAkash(['query', 'tx', result.txhash as string, '-o', 'json'], 15_000)
      const txResult = extractJson(txOutput) as Record<string, unknown>

      // Try logs first (older CLI versions)
      const txLogs = txResult.logs as Array<{ events?: Array<{ type: string; attributes?: Array<{ key: string; value: string }> }> }> | undefined
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
        const tx = txResult.tx as { body?: { messages?: Array<{ id?: { dseq?: string } }> } } | undefined
        const msgDseq = tx?.body?.messages?.[0]?.id?.dseq
        if (msgDseq) {
          dseq = parseInt(msgDseq, 10)
          console.log(`[AkashOrchestrator] Parsed dseq from tx.body.messages: ${dseq}`)
        }
      }
    }

    if (!dseq || isNaN(dseq) || dseq <= 0) {
      throw new Error(`Failed to create deployment: could not extract dseq from response`)
    }

    const owner = await this.getAccountAddress()
    console.log(`[AkashOrchestrator] Deployment created: dseq=${dseq}, owner=${owner}`)
    return { dseq, owner }
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
    const output = runAkash([
      'query', 'market', 'bid', 'list',
      '--owner', owner,
      '--dseq', String(dseq),
      '-o', 'json',
    ], 15_000)

    const result = extractJson(output) as { bids?: Array<{ bid?: { bid_id?: Record<string, unknown>; id?: Record<string, unknown>; price?: Record<string, unknown> }; bid_id?: Record<string, unknown>; id?: Record<string, unknown>; price?: Record<string, unknown> }> }

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
          denom: String(price.denom || 'uakt'),
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
    runAkash([
      'tx', 'market', 'lease', 'create',
      '--dseq', String(dseq),
      '--gseq', String(gseq),
      '--oseq', String(oseq),
      '--provider', provider,
      '-o', 'json',
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
        'send-manifest', sdlPath,
        '--dseq', String(dseq),
        '--provider', provider,
      ])
    } catch (err) {
      // Fallback: retry once after a short delay (provider may not have lease ready)
      console.warn('[AkashOrchestrator] Manifest send failed, retrying in 5s...', err instanceof Error ? err.message : err)
      await new Promise(r => setTimeout(r, 5000))
      runProviderServices([
        'send-manifest', sdlPath,
        '--dseq', String(dseq),
        '--provider', provider,
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
    const output = runProviderServices([
      'lease-status',
      '--dseq', String(dseq),
      '--provider', provider,
    ], 15_000)

    const result = extractJson(output) as { services?: Record<string, { uris?: string[] }> }
    const services = result.services || {}
    const out: Record<string, { uris: string[] }> = {}
    for (const [k, v] of Object.entries(services)) {
      out[k] = { uris: v.uris || [] }
    }
    return out
  }

  /**
   * Background backfill for deployments where URIs weren't available during
   * the initial polling window. Retries every 10s for up to 3 minutes.
   */
  private async backfillServiceUrls(
    deploymentId: string,
    dseq: number,
    provider: string,
  ): Promise<void> {
    const BACKFILL_INTERVAL_MS = 10_000
    const BACKFILL_MAX_ATTEMPTS = 18 // 18 * 10s = 3 minutes

    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS; i++) {
      await new Promise(r => setTimeout(r, BACKFILL_INTERVAL_MS))

      // Check if the deployment is still ACTIVE (might have been closed)
      const dep = await this.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
        select: { status: true, serviceUrls: true },
      })
      if (!dep || dep.status !== 'ACTIVE') {
        console.log(`[AkashOrchestrator] Backfill: deployment ${deploymentId} no longer active, stopping.`)
        return
      }

      // If serviceUrls got populated by another path, stop
      const existing = dep.serviceUrls as Record<string, { uris?: string[] }> | null
      if (existing && Object.values(existing).some(s => s.uris && s.uris.length > 0)) {
        console.log(`[AkashOrchestrator] Backfill: URIs already populated for ${deploymentId}, done.`)
        return
      }

      try {
        const services = await this.getServices(dseq, provider)
        const hasUris = Object.values(services).some(s => s.uris?.length > 0)
        if (hasUris) {
          await this.prisma.akashDeployment.update({
            where: { id: deploymentId },
            data: { serviceUrls: services },
          })
          console.log(`[AkashOrchestrator] Backfill: URIs populated for ${deploymentId} after ${(i + 1) * 10}s`)
          return
        }
      } catch (err) {
        console.warn(`[AkashOrchestrator] Backfill getServices attempt ${i + 1} failed for ${deploymentId}:`, err instanceof Error ? err.message : err)
      }
    }

    console.warn(`[AkashOrchestrator] Backfill: gave up waiting for URIs on ${deploymentId} after 3 minutes`)
  }

  /**
   * Startup scan: find all ACTIVE Akash deployments with empty serviceUrls
   * and kick off backfills for them. Call this once at server startup so
   * interrupted backfills (e.g. from pod restarts) are resumed automatically.
   */
  async resumePendingBackfills(): Promise<void> {
    try {
      const stale = await this.prisma.akashDeployment.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { serviceUrls: { equals: {} } },
            { serviceUrls: { equals: Prisma.AnyNull } },
          ],
        },
        select: { id: true, dseq: true, provider: true },
      })

      if (stale.length === 0) {
        console.log('[AkashOrchestrator] No ACTIVE deployments with missing URIs.')
        return
      }

      console.log(`[AkashOrchestrator] Found ${stale.length} ACTIVE deployment(s) with missing URIs. Starting backfills...`)

      for (const dep of stale) {
        const dseq = Number(dep.dseq)
        if (!dep.provider) continue
        this.backfillServiceUrls(dep.id, dseq, dep.provider).catch(err =>
          console.error(`[AkashOrchestrator] Startup backfill failed for ${dep.id}:`, err instanceof Error ? err.message : err)
        )
      }
    } catch (err) {
      console.error('[AkashOrchestrator] resumePendingBackfills error:', err)
    }
  }

  /**
   * Close a deployment
   */
  async closeDeployment(dseq: number): Promise<void> {
    runAkash([
      'tx', 'deployment', 'close',
      '--dseq', String(dseq),
      '-o', 'json',
      '-y',
    ])
  }

  /**
   * Get deployment logs
   */
  async getLogs(
    dseq: number,
    provider: string,
    service?: string,
    tail?: number
  ): Promise<string> {
    const args = [
      'lease-logs',
      '--dseq', String(dseq),
      '--provider', provider,
    ]
    if (service) args.push('--service', service)
    if (tail) args.push('--tail', String(tail))

    try {
      return runProviderServices(args, 15_000)
    } catch {
      return ''
    }
  }

  // ========================================
  // High-level deployment operations
  // ========================================

  /**
   * Deploy any service to Akash (full flow)
   * This is the primary method that handles all service types via the Service Registry.
   */
  async deployService(
    serviceId: string,
    options: {
      deposit?: number
      sdlContent?: string
    } = {}
  ): Promise<string> {
    const deposit = options.deposit || 5000000 // 5 AKT default

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

    if (existingDeployments.length > 0) {
      console.log(`[AkashOrchestrator] Closing ${existingDeployments.length} existing deployment(s) for service ${service.name}...`)

      for (const existing of existingDeployments) {
        try {
          const existingDseq = Number(existing.dseq)
          console.log(`[AkashOrchestrator] Closing previous deployment dseq=${existingDseq}...`)
          await this.closeDeployment(existingDseq)

          await this.prisma.akashDeployment.update({
            where: { id: existing.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
          console.log(`[AkashOrchestrator] Closed deployment dseq=${existingDseq}`)
        } catch (err: any) {
          console.warn(`[AkashOrchestrator] Failed to close deployment dseq=${existing.dseq}: ${err.message}`)
          await this.prisma.akashDeployment.update({
            where: { id: existing.id },
            data: { status: 'CLOSED', closedAt: new Date() },
          })
        }
      }
    }

    // Write SDL to temp file
    const sdlContent = options.sdlContent || await this.generateSDLForService(service)
    const workDir = mkdtempSync(join(tmpdir(), 'akash-deploy-'))
    const sdlPath = join(workDir, 'deploy.yaml')
    writeFileSync(sdlPath, sdlContent)

    const owner = await this.getAccountAddress()
    let deployment: Awaited<ReturnType<typeof this.prisma.akashDeployment.create>> | null = null

    try {
      // Create deployment on chain
      console.log(`[AkashOrchestrator] Creating deployment for ${service.type}:${service.name}...`)
      const { dseq } = await this.createDeployment(sdlPath, deposit)
      console.log(`[AkashOrchestrator] Deployment created with dseq: ${dseq}`)

      deployment = await this.prisma.akashDeployment.create({
        data: {
          owner,
          dseq: BigInt(dseq),
          sdlContent,
          serviceId: service.id,
          afFunctionId: service.type === 'FUNCTION' ? service.afFunction?.id : null,
          siteId: service.type === 'SITE' ? service.site?.id : null,
          depositUakt: BigInt(deposit),
          status: 'WAITING_BIDS',
        },
      })

      // Wait for bids (poll with backoff)
      console.log('[AkashOrchestrator] Waiting for bids...')
      let bids: Awaited<ReturnType<typeof this.getBids>> = []
      for (let i = 0; i < BID_POLL_MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, BID_POLL_INTERVAL_MS * (i + 1)))
        bids = await this.getBids(owner, dseq)
        if (bids.length > 0) break
      }

      if (bids.length === 0) {
        throw new Error('No bids received within timeout')
      }

      console.log(`[AkashOrchestrator] Received ${bids.length} bids`)

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'SELECTING_BID' },
      })

      // Filter bids and select cheapest safe provider
      const filteredBids = providerSelector.filterBids(bids as any, 'standalone')
      const safeBids = filteredBids.filter(b => b.isSafe)

      if (safeBids.length === 0) {
        const blockedProviders = filteredBids.filter(b => !b.isSafe)
        console.log('[AkashOrchestrator] All bids were from blocked providers:',
          blockedProviders.map(b => `${b.bidId.provider}: ${b.unsafeReason}`).join(', '))
        throw new Error('No safe bids available - all providers are blocked')
      }

      console.log(`[AkashOrchestrator] ${safeBids.length}/${bids.length} bids from safe providers`)

      const selectedBid = safeBids.sort((a, b) => {
        const priceA = parseFloat(a.price.amount) || 0
        const priceB = parseFloat(b.price.amount) || 0
        return priceA - priceB
      })[0]

      const provider = selectedBid.bidId.provider
      const gseq = selectedBid.bidId.gseq
      const oseq = selectedBid.bidId.oseq

      // Create lease
      console.log('[AkashOrchestrator] Creating lease with provider:', provider)
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: {
          provider,
          gseq,
          oseq,
          pricePerBlock: selectedBid.price.amount,
          status: 'CREATING_LEASE',
        },
      })

      await this.createLease(owner, dseq, gseq, oseq, provider)

      // Send manifest
      console.log('[AkashOrchestrator] Sending manifest...')
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'SENDING_MANIFEST' },
      })

      await this.sendManifest(sdlPath, dseq, provider)

      // Wait for services to be ready
      console.log('[AkashOrchestrator] Waiting for services...')
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'DEPLOYING' },
      })

      let akashServices: Record<string, { uris: string[] }> = {}
      let hasUris = false
      for (let i = 0; i < SERVICE_POLL_MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, SERVICE_POLL_INTERVAL_MS))
        try {
          akashServices = await this.getServices(dseq, provider)
          hasUris = Object.values(akashServices).some(s => s.uris?.length > 0)
          if (hasUris) break
        } catch (err) {
          console.warn(`[AkashOrchestrator] getServices poll attempt ${i + 1}/${SERVICE_POLL_MAX_ATTEMPTS} failed:`, err instanceof Error ? err.message : err)
        }
      }

      // Create platform-level escrow
      try {
        const escrowService = getEscrowService(this.prisma)
        const billingApi = getBillingApiClient()

        const project = service.site?.projectId || service.afFunction?.projectId || service.projectId
        let organizationId: string | undefined
        if (project) {
          const proj = await this.prisma.project.findUnique({
            where: { id: typeof project === 'string' ? project : service.projectId },
            select: { organizationId: true },
          })
          organizationId = proj?.organizationId ?? undefined
        }

        if (organizationId && selectedBid.price.amount) {
          const orgMarkup = await billingApi.getOrgMarkup(
            (await billingApi.getOrgBilling(organizationId)).orgBillingId
          )

          await escrowService.createEscrow({
            akashDeploymentId: deployment.id,
            organizationId,
            pricePerBlock: selectedBid.price.amount,
            marginRate: orgMarkup.marginRate,
            userId: service.createdByUserId || 'system',
          })
        }
      } catch (escrowError) {
        console.warn(
          `[AkashOrchestrator] Escrow creation failed for deployment ${deployment.id}:`,
          escrowError instanceof Error ? escrowError.message : escrowError
        )
      }

      // Update deployment as active
      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: {
          status: 'ACTIVE',
          serviceUrls: akashServices,
          deployedAt: new Date(),
        },
      })

      // Build the public invoke URL via the subdomain proxy
      const baseDomain = process.env.PROXY_BASE_DOMAIN || 'alternatefutures.ai'
      const invokeUrl = `https://${service.slug}-app.${baseDomain}`

      if (service.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: {
            status: 'ACTIVE',
            invokeUrl,
          },
        })
      }

      // If URIs weren't available during initial polling, start a background
      // backfill that keeps trying for up to 3 more minutes. This handles slow
      // providers that need extra time to set up ingress.
      if (!hasUris) {
        console.warn(`[AkashOrchestrator] URIs not yet available for dseq=${dseq}. Starting background backfill...`)
        this.backfillServiceUrls(deployment.id, dseq, provider).catch(err =>
          console.error('[AkashOrchestrator] URI backfill failed:', err instanceof Error ? err.message : err)
        )
      }

      console.log('[AkashOrchestrator] Deployment complete:', invokeUrl)
      return deployment.id
    } catch (error) {
      if (deployment) {
        await this.prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: {
            status: 'FAILED',
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
          },
        })
      }

      if (service.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: { status: 'FAILED' },
        })
      }

      throw error
    } finally {
      try {
        rmSync(workDir, { recursive: true })
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * Deploy a function to Akash (convenience method)
   */
  async deployFunction(
    functionId: string,
    sourceCode: string,
    functionName: string,
    deposit = 5000000
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
  private async generateSDLForService(
    service: {
      type: ServiceType
      name: string
      slug: string
      templateId?: string | null
      containerPort?: number | null
      dockerImage?: string | null
      site?: { id: string } | null
      afFunction?: { id: string; sourceCode: string | null } | null
    }
  ): Promise<string> {
    if (service.type === 'FUNCTION') {
      if (!service.afFunction?.sourceCode) {
        throw new Error('Function has no source code')
      }
      return this.generateFunctionSDL(service.slug, service.afFunction.sourceCode)
    }

    const { getTemplateById, generateSDLFromTemplate } = await import('../../templates/index.js')

    // Priority 1: Use the service's own templateId (set when deployed from a template).
    // This ensures redeployments use the same template config (ports, env, resources)
    // that was used for the initial deployment.
    if (service.templateId) {
      const template = getTemplateById(service.templateId)
      if (template) {
        console.log(`[AkashOrchestrator] Generating SDL from template '${service.templateId}' for service '${service.slug}'`)
        return generateSDLFromTemplate(template, { serviceName: service.slug })
      }
      console.warn(`[AkashOrchestrator] Service '${service.slug}' has templateId '${service.templateId}' but template not found. Falling back.`)
    }

    // Priority 2: Custom Docker image with explicit containerPort
    if (service.dockerImage) {
      const port = service.containerPort || 80
      console.log(`[AkashOrchestrator] Generating SDL for custom Docker image '${service.dockerImage}' (port ${port}) for service '${service.slug}'`)
      return this.generateCustomDockerSDL(service.slug, service.dockerImage, port)
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
        throw new Error(`SDL generation not supported for service type: ${service.type}`)
    }
  }

  /**
   * Generate SDL for a custom Docker image with a specific container port.
   */
  private generateCustomDockerSDL(name: string, image: string, containerPort: number): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: ${image}
    expose:
      - port: ${containerPort}
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
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        ${name}:
          denom: uakt
          amount: 1000

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
    const packages = [...new Set(imports.map(i => {
      const match = i.match(/from ['"]([^'"./][^'"]*)['"]/)?.[1]
      return match?.split('/').slice(0, match.startsWith('@') ? 2 : 1).join('/') || ''
    }).filter(Boolean))]

    const installCmd = packages.length > 0
      ? `bun add ${packages.join(' ')}`
      : 'echo "No dependencies to install"'

    return `---
version: "2.0"

services:
  ${name}:
    image: oven/bun:1.1-alpine
    env:
      - PORT=3000
    command:
      - sh
      - -c
      - |
        echo 'Deploying function...'
        mkdir -p /app
        cd /app
        bun init -y
        echo '${base64Code}' | base64 -d > /app/index.ts
        echo 'Installing dependencies: ${packages.join(', ') || 'none'}'
        ${installCmd}
        echo 'Starting function...'
        bun run index.ts
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
          denom: uakt
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
          denom: uakt
          amount: 500

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  private generateVMSDL(name: string): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: ubuntu:22.04
    command:
      - sh
      - -c
      - |
        apt-get update && apt-get install -y openssh-server
        mkdir /run/sshd
        echo 'root:akash' | chpasswd
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
          denom: uakt
          amount: 2000

deployment:
  ${name}:
    dcloud:
      profile: ${name}
      count: 1
`
  }

  private generateDatabaseSDL(name: string): string {
    return `---
version: "2.0"

services:
  ${name}:
    image: postgres:15-alpine
    env:
      - POSTGRES_DB=akashdb
      - POSTGRES_USER=akash
      - POSTGRES_PASSWORD=akash_secure_password
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
          denom: uakt
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

export function getAkashOrchestrator(
  prisma: PrismaClient
): AkashOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new AkashOrchestrator(prisma)
  }
  return orchestratorInstance
}
