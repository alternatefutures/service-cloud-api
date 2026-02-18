/**
 * Akash Deployment Orchestrator — JS SDK Implementation
 *
 * Drop-in replacement for orchestrator.ts (CLI-based). Same public API,
 * but uses @akashnetwork/chain-sdk instead of shelling out to `akash`
 * and `provider-services` binaries.
 *
 * Benefits:
 *   - No Go binary dependencies in the Docker image
 *   - No execSync (async all the way)
 *   - Better error handling (typed errors vs parsing CLI stderr)
 *   - Runs anywhere Node.js runs (serverless, containers, local)
 *
 * To switch from CLI to SDK, change the import in:
 *   - src/services/akash/index.ts (if it exists)
 *   - src/index.ts
 *   - src/resolvers/akash.ts
 *   - src/resolvers/templates.ts
 *
 * Or rename this file to orchestrator.ts and remove the old one.
 */

import { Prisma } from '@prisma/client'
import type { PrismaClient, ServiceType } from '@prisma/client'
import { providerSelector } from './providerSelector.js'
import { getEscrowService } from '../billing/escrowService.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'
import {
  getAkashSDKContext,
  sendManifestHTTPS,
  queryLeaseStatusHTTPS,
  SDL,
} from './sdk.js'

const BID_POLL_INTERVAL_MS = 5000
const BID_POLL_MAX_ATTEMPTS = 10
const SERVICE_POLL_INTERVAL_MS = 5000
const SERVICE_POLL_MAX_ATTEMPTS = 24

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

export class AkashOrchestratorSDK {
  constructor(private prisma: PrismaClient) {}

  async getAccountAddress(): Promise<string> {
    const ctx = await getAkashSDKContext()
    return ctx.ownerAddress
  }

  async getBalances(address: string): Promise<Array<{ denom: string; amount: string }>> {
    const { chainSDK } = await getAkashSDKContext()
    const res = await chainSDK.cosmos.bank.v1beta1.getAllBalances({
      address,
      pagination: undefined,
    })
    return (res.balances || []).map((b: { denom?: string; amount?: string }) => ({
      denom: b.denom || '',
      amount: b.amount || '0',
    }))
  }

  async createDeployment(sdlContent: string, deposit: number): Promise<{ dseq: number; owner: string }> {
    const { chainSDK, ownerAddress } = await getAkashSDKContext()

    const sdl = SDL.fromString(sdlContent, 'beta3')
    const groups = sdl.groups()
    const hash = await sdl.manifestVersion()

    const blockRes = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({})
    const blockHeight = Number(blockRes.block?.header?.height || 0)
    if (!blockHeight) throw new Error('Could not get current block height')

    const dseq = blockHeight

    console.log(`[AkashSDK] Creating deployment dseq=${dseq} owner=${ownerAddress}`)

    await chainSDK.akash.deployment.v1beta4.createDeployment({
      id: {
        owner: ownerAddress,
        dseq: BigInt(dseq),
      },
      groups,
      hash,
      deposit: {
        amount: {
          denom: 'uakt',
          amount: deposit.toString(),
        },
        sources: [1],
      },
    })

    return { dseq, owner: ownerAddress }
  }

  async getBids(
    owner: string,
    dseq: number,
  ): Promise<
    Array<{
      bidId: { provider: string; gseq: number; oseq: number }
      price: { amount: string; denom: string }
      provider?: { hostUri?: string }
    }>
  > {
    const { chainSDK } = await getAkashSDKContext()

    const bidsResponse = await chainSDK.akash.market.v1beta5.getBids({
      filters: { owner, dseq: BigInt(dseq) },
    })

    return await Promise.all(
      bidsResponse.bids.map(async (bidResponse: any) => {
        const bid = bidResponse.bid
        const bidId = bid?.id
        const price = bid?.price

        let providerInfo: { hostUri?: string } | undefined
        if (bidId?.provider) {
          try {
            const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({
              owner: bidId.provider,
            })
            providerInfo = { hostUri: providerRes.provider?.hostUri }
          } catch {
            // Provider info is optional enrichment
          }
        }

        return {
          bidId: {
            provider: bidId?.provider || '',
            gseq: Number(bidId?.gseq ?? 1),
            oseq: Number(bidId?.oseq ?? 1),
          },
          price: {
            amount: price?.amount || '0',
            denom: price?.denom || 'uakt',
          },
          provider: providerInfo,
        }
      }),
    )
  }

  async createLease(
    owner: string,
    dseq: number,
    gseq: number,
    oseq: number,
    provider: string,
  ): Promise<void> {
    const { chainSDK } = await getAkashSDKContext()

    await chainSDK.akash.market.v1beta5.createLease({
      bidId: {
        owner,
        dseq: BigInt(dseq),
        gseq,
        oseq,
        provider,
        bseq: 0,
      },
    })

    // Wait for lease to propagate
    await sleep(6000)
  }

  async sendManifest(sdlContent: string, dseq: number, provider: string): Promise<void> {
    const { certificate, chainSDK } = await getAkashSDKContext()

    try {
      await sendManifestHTTPS(sdlContent, dseq, provider, certificate, chainSDK)
    } catch (err) {
      console.warn('[AkashSDK] Manifest send failed, retrying in 5s...', err instanceof Error ? err.message : err)
      await sleep(5000)
      await sendManifestHTTPS(sdlContent, dseq, provider, certificate, chainSDK)
    }
  }

  async getServices(
    dseq: number,
    provider: string,
    gseq = 1,
    oseq = 1,
  ): Promise<Record<string, { uris: string[] }>> {
    const { certificate, chainSDK } = await getAkashSDKContext()

    const result = await queryLeaseStatusHTTPS(dseq, gseq, oseq, provider, certificate, chainSDK)
    const services = result.services || {}
    const out: Record<string, { uris: string[] }> = {}
    for (const [k, v] of Object.entries(services)) {
      out[k] = { uris: v.uris || [] }
    }
    return out
  }

  async closeDeployment(dseq: number): Promise<void> {
    const { chainSDK, ownerAddress } = await getAkashSDKContext()

    await chainSDK.akash.deployment.v1beta4.closeDeployment({
      id: {
        owner: ownerAddress,
        dseq: BigInt(dseq),
      },
    })
  }

  async getLogs(
    dseq: number,
    provider: string,
    service?: string,
    tail?: number,
  ): Promise<string> {
    // Log fetching via the provider's REST API requires a WebSocket connection.
    // For now, fall back to empty (same as the CLI version's catch block).
    // Full implementation would open a WSS connection to the provider.
    console.warn('[AkashSDK] getLogs via SDK not yet implemented (requires WebSocket to provider)')
    return ''
  }

  // ─── Background URI backfill ─────────────────────────────────

  private async backfillServiceUrls(
    deploymentId: string,
    dseq: number,
    provider: string,
  ): Promise<void> {
    const BACKFILL_INTERVAL_MS = 10_000
    const BACKFILL_MAX_ATTEMPTS = 18

    for (let i = 0; i < BACKFILL_MAX_ATTEMPTS; i++) {
      await sleep(BACKFILL_INTERVAL_MS)

      const dep = await this.prisma.akashDeployment.findUnique({
        where: { id: deploymentId },
        select: { status: true, serviceUrls: true },
      })
      if (!dep || dep.status !== 'ACTIVE') return

      const existing = dep.serviceUrls as Record<string, { uris?: string[] }> | null
      if (existing && Object.values(existing).some(s => s.uris && s.uris.length > 0)) return

      try {
        const services = await this.getServices(dseq, provider)
        const hasUris = Object.values(services).some(s => s.uris?.length > 0)
        if (hasUris) {
          await this.prisma.akashDeployment.update({
            where: { id: deploymentId },
            data: { serviceUrls: services },
          })
          console.log(`[AkashSDK] Backfill: URIs populated for ${deploymentId} after ${(i + 1) * 10}s`)
          return
        }
      } catch (err) {
        console.warn(`[AkashSDK] Backfill attempt ${i + 1} failed for ${deploymentId}:`, err instanceof Error ? err.message : err)
      }
    }

    console.warn(`[AkashSDK] Backfill gave up waiting for URIs on ${deploymentId} after 3 minutes`)
  }

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

      if (stale.length === 0) return

      console.log(`[AkashSDK] Found ${stale.length} ACTIVE deployment(s) with missing URIs. Starting backfills...`)

      for (const dep of stale) {
        const dseq = Number(dep.dseq)
        if (!dep.provider) continue
        this.backfillServiceUrls(dep.id, dseq, dep.provider).catch(err =>
          console.error(`[AkashSDK] Startup backfill failed for ${dep.id}:`, err instanceof Error ? err.message : err),
        )
      }
    } catch (err) {
      console.error('[AkashSDK] resumePendingBackfills error:', err)
    }
  }

  // ─── High-level deployment ───────────────────────────────────

  async deployService(
    serviceId: string,
    options: { deposit?: number; sdlContent?: string } = {},
  ): Promise<string> {
    const deposit = options.deposit || 5000000

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { site: true, afFunction: true },
    })
    if (!service) throw new Error(`Service not found: ${serviceId}`)

    // Close existing ACTIVE deployments
    const existingDeployments = await this.prisma.akashDeployment.findMany({
      where: { serviceId: service.id, status: 'ACTIVE' },
    })

    for (const existing of existingDeployments) {
      try {
        await this.closeDeployment(Number(existing.dseq))
        await this.prisma.akashDeployment.update({
          where: { id: existing.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
      } catch (err: any) {
        console.warn(`[AkashSDK] Failed to close dseq=${existing.dseq}: ${err.message}`)
        await this.prisma.akashDeployment.update({
          where: { id: existing.id },
          data: { status: 'CLOSED', closedAt: new Date() },
        })
      }
    }

    const sdlContent = options.sdlContent || await this.generateSDLForService(service)
    const owner = await this.getAccountAddress()
    let deployment: Awaited<ReturnType<typeof this.prisma.akashDeployment.create>> | null = null

    try {
      const { dseq } = await this.createDeployment(sdlContent, deposit)
      console.log(`[AkashSDK] Deployment created dseq=${dseq}`)

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

      // Poll for bids
      let bids: Awaited<ReturnType<typeof this.getBids>> = []
      for (let i = 0; i < BID_POLL_MAX_ATTEMPTS; i++) {
        await sleep(BID_POLL_INTERVAL_MS * (i + 1))
        bids = await this.getBids(owner, dseq)
        if (bids.length > 0) break
      }

      if (bids.length === 0) throw new Error('No bids received within timeout')

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'SELECTING_BID' },
      })

      const filteredBids = providerSelector.filterBids(bids as any, 'standalone')
      const safeBids = filteredBids.filter(b => b.isSafe)
      if (safeBids.length === 0) throw new Error('No safe bids available - all providers are blocked')

      const selectedBid = safeBids.sort((a, b) => {
        const priceA = parseFloat(a.price.amount) || 0
        const priceB = parseFloat(b.price.amount) || 0
        return priceA - priceB
      })[0]

      const provider = selectedBid.bidId.provider
      const gseq = selectedBid.bidId.gseq
      const oseq = selectedBid.bidId.oseq

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { provider, gseq, oseq, pricePerBlock: selectedBid.price.amount, status: 'CREATING_LEASE' },
      })

      await this.createLease(owner, dseq, gseq, oseq, provider)

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'SENDING_MANIFEST' },
      })

      await this.sendManifest(sdlContent, dseq, provider)

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'DEPLOYING' },
      })

      // Poll for service URLs
      let akashServices: Record<string, { uris: string[] }> = {}
      let hasUris = false
      for (let i = 0; i < SERVICE_POLL_MAX_ATTEMPTS; i++) {
        await sleep(SERVICE_POLL_INTERVAL_MS)
        try {
          akashServices = await this.getServices(dseq, provider, gseq, oseq)
          hasUris = Object.values(akashServices).some(s => s.uris?.length > 0)
          if (hasUris) break
        } catch (err) {
          console.warn(`[AkashSDK] getServices poll ${i + 1}/${SERVICE_POLL_MAX_ATTEMPTS}:`, err instanceof Error ? err.message : err)
        }
      }

      // Create escrow
      try {
        const escrowService = getEscrowService(this.prisma)
        const billingApi = getBillingApiClient()

        const projectId = service.site?.projectId || service.afFunction?.projectId || service.projectId
        let organizationId: string | undefined
        if (projectId) {
          const proj = await this.prisma.project.findUnique({
            where: { id: typeof projectId === 'string' ? projectId : service.projectId },
            select: { organizationId: true },
          })
          organizationId = proj?.organizationId ?? undefined
        }

        if (organizationId && selectedBid.price.amount) {
          const orgMarkup = await billingApi.getOrgMarkup(
            (await billingApi.getOrgBilling(organizationId)).orgBillingId,
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
        console.warn(`[AkashSDK] Escrow creation failed:`, escrowError instanceof Error ? escrowError.message : escrowError)
      }

      await this.prisma.akashDeployment.update({
        where: { id: deployment.id },
        data: { status: 'ACTIVE', serviceUrls: akashServices, deployedAt: new Date() },
      })

      const baseDomain = process.env.PROXY_BASE_DOMAIN || 'alternatefutures.ai'
      const invokeUrl = `https://${service.slug}-app.${baseDomain}`

      if (service.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: { status: 'ACTIVE', invokeUrl },
        })
      }

      if (!hasUris) {
        this.backfillServiceUrls(deployment.id, dseq, provider).catch(err =>
          console.error('[AkashSDK] URI backfill failed:', err instanceof Error ? err.message : err),
        )
      }

      console.log('[AkashSDK] Deployment complete:', invokeUrl)
      return deployment.id
    } catch (error) {
      if (deployment) {
        await this.prisma.akashDeployment.update({
          where: { id: deployment.id },
          data: { status: 'FAILED', errorMessage: error instanceof Error ? error.message : 'Unknown error' },
        })
      }

      if (service.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: { status: 'FAILED' },
        })
      }

      throw error
    }
  }

  async deployFunction(functionId: string, sourceCode: string, functionName: string, deposit = 5000000): Promise<string> {
    const func = await this.prisma.aFFunction.findUnique({
      where: { id: functionId },
      select: { serviceId: true },
    })
    if (!func?.serviceId) throw new Error('Function has no associated service in the registry')
    return this.deployService(func.serviceId, { deposit })
  }

  // ─── SDL generation (same as CLI orchestrator) ───────────────

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
    },
  ): Promise<string> {
    if (service.type === 'FUNCTION') {
      if (!service.afFunction?.sourceCode) throw new Error('Function has no source code')
      return this.generateFunctionSDL(service.slug, service.afFunction.sourceCode)
    }

    const { getTemplateById, generateSDLFromTemplate } = await import('../../templates/index.js')

    if (service.templateId) {
      const template = getTemplateById(service.templateId)
      if (template) return generateSDLFromTemplate(template, { serviceName: service.slug })
    }

    if (service.dockerImage) {
      return this.generateCustomDockerSDL(service.slug, service.dockerImage, service.containerPort || 80)
    }

    const typeToTemplate: Record<string, string> = {
      SITE: 'nginx-site',
      VM: 'node-ws-gameserver',
      DATABASE: 'postgres',
    }
    const fallbackTemplateId = typeToTemplate[service.type]
    if (fallbackTemplateId) {
      const template = getTemplateById(fallbackTemplateId)
      if (template) return generateSDLFromTemplate(template, { serviceName: service.slug })
    }

    switch (service.type) {
      case 'SITE': return this.generateSiteSDL(service.slug)
      case 'VM': return this.generateVMSDL(service.slug)
      case 'DATABASE': return this.generateDatabaseSDL(service.slug)
      default: throw new Error(`SDL generation not supported for service type: ${service.type}`)
    }
  }

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

  private generateFunctionSDL(name: string, sourceCode: string): string {
    const base64Code = Buffer.from(sourceCode, 'utf-8').toString('base64')
    const imports = sourceCode.match(/from ['"]([^'"./][^'"]*)['"]/g) || []
    const packages = [...new Set(imports.map(i => {
      const match = i.match(/from ['"]([^'"./][^'"]*)['"]/)?.[1]
      return match?.split('/').slice(0, match.startsWith('@') ? 2 : 1).join('/') || ''
    }).filter(Boolean))]
    const installCmd = packages.length > 0 ? `bun add ${packages.join(' ')}` : 'echo "No dependencies"'

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
        mkdir -p /app && cd /app && bun init -y
        echo '${base64Code}' | base64 -d > /app/index.ts
        ${installCmd}
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

// Singleton
let orchestratorSDKInstance: AkashOrchestratorSDK | null = null

export function getAkashOrchestratorSDK(prisma: PrismaClient): AkashOrchestratorSDK {
  if (!orchestratorSDKInstance) {
    orchestratorSDKInstance = new AkashOrchestratorSDK(prisma)
  }
  return orchestratorSDKInstance
}
