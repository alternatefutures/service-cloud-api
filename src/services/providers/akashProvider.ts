/**
 * Akash DeploymentProvider Adapter
 *
 * Wraps the existing AkashOrchestrator behind the DeploymentProvider interface.
 * This is a thin adapter — all real logic lives in orchestrator.ts.
 *
 * Status mapping (Akash native → ProviderStatus):
 *   CREATING, WAITING_BIDS, SELECTING_BID, CREATING_LEASE,
 *     SENDING_MANIFEST, DEPLOYING                         → 'creating'
 *   ACTIVE                                                → 'active'
 *   FAILED                                                → 'failed'
 *   CLOSED                                                → 'closed'
 *   SUSPENDED                                             → 'suspended'
 */

import type { PrismaClient } from '@prisma/client'
import type {
  DeploymentProvider,
  DeployOptions,
  DeploymentResult,
  DeploymentStatusResult,
  LogOptions,
  ProviderCapabilities,
  ProviderStatus,
} from './types.js'
import { getAkashOrchestrator } from '../akash/orchestrator.js'

const AKASH_STATUS_MAP: Record<string, ProviderStatus> = {
  CREATING: 'creating',
  WAITING_BIDS: 'creating',
  SELECTING_BID: 'creating',
  CREATING_LEASE: 'creating',
  SENDING_MANIFEST: 'creating',
  DEPLOYING: 'creating',
  ACTIVE: 'active',
  FAILED: 'failed',
  CLOSED: 'closed',
  SUSPENDED: 'suspended',
}

function mapStatus(nativeStatus: string): ProviderStatus {
  return AKASH_STATUS_MAP[nativeStatus] ?? 'failed'
}

export class AkashProvider implements DeploymentProvider {
  readonly name = 'akash'
  readonly displayName = 'Akash Network'

  constructor(private prisma: PrismaClient) {}

  isAvailable(): boolean {
    return !!process.env.AKASH_MNEMONIC
  }

  async deploy(serviceId: string, options: DeployOptions): Promise<DeploymentResult> {
    const orchestrator = getAkashOrchestrator(this.prisma)

    if (options.sourceCode) {
      const service = await this.prisma.service.findUnique({
        where: { id: serviceId },
        include: { afFunction: true },
      })
      if (service?.type === 'FUNCTION' && service.afFunction) {
        await this.prisma.aFFunction.update({
          where: { id: service.afFunction.id },
          data: { sourceCode: options.sourceCode },
        })
      }
    }

    const deploymentId = await orchestrator.deployService(serviceId, {
      deposit: options.deposit,
      sdlContent: options.sdlContent,
    })

    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })

    if (!deployment) {
      return {
        deploymentId,
        providerDeploymentId: 'unknown',
        status: 'failed',
        errorMessage: 'Deployment record not found after creation',
      }
    }

    const serviceUrls: Record<string, string[]> = {}
    if (deployment.serviceUrls && typeof deployment.serviceUrls === 'object') {
      for (const [k, v] of Object.entries(deployment.serviceUrls as Record<string, { uris?: string[] }>)) {
        serviceUrls[k] = v.uris || []
      }
    }

    return {
      deploymentId: deployment.id,
      providerDeploymentId: deployment.dseq.toString(),
      status: mapStatus(deployment.status),
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      errorMessage: deployment.errorMessage ?? undefined,
    }
  }

  async stop(_deploymentId: string): Promise<void> {
    throw new Error('Akash does not support stop/resume. Use close() to permanently terminate.')
  }

  async close(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Akash deployment not found: ${deploymentId}`)
    if (deployment.status === 'CLOSED') return

    const orchestrator = getAkashOrchestrator(this.prisma)

    try {
      await orchestrator.closeDeployment(Number(deployment.dseq))
    } catch (err) {
      console.warn(`[AkashProvider] On-chain close failed for dseq=${deployment.dseq}, force-closing DB:`, err)
    }

    await this.prisma.akashDeployment.update({
      where: { id: deploymentId },
      data: { status: 'CLOSED', closedAt: new Date() },
    })
  }

  async getStatus(deploymentId: string): Promise<DeploymentStatusResult> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Akash deployment not found: ${deploymentId}`)

    const serviceUrls: Record<string, string[]> = {}
    if (deployment.serviceUrls && typeof deployment.serviceUrls === 'object') {
      for (const [k, v] of Object.entries(deployment.serviceUrls as Record<string, { uris?: string[] }>)) {
        serviceUrls[k] = v.uris || []
      }
    }

    return {
      status: mapStatus(deployment.status),
      nativeStatus: deployment.status,
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      metadata: {
        dseq: deployment.dseq.toString(),
        provider: deployment.provider,
        owner: deployment.owner,
        pricePerBlock: deployment.pricePerBlock,
        depositUakt: deployment.depositUakt?.toString(),
      },
    }
  }

  async getLogs(deploymentId: string, opts?: LogOptions): Promise<string> {
    const deployment = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment || !deployment.provider) {
      throw new Error(`Akash deployment not found or has no provider: ${deploymentId}`)
    }

    const orchestrator = getAkashOrchestrator(this.prisma)
    return orchestrator.getLogs(
      Number(deployment.dseq),
      deployment.provider,
      opts?.service,
      opts?.tail,
      deployment.gseq,
      deployment.oseq,
    )
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStop: false,
      supportsLogStreaming: false,
      supportsTEE: false,
      supportsPersistentStorage: true,
      supportsWebSocket: true,
      configFormat: 'sdl',
      billingModel: 'escrow',
    }
  }
}

export function createAkashProvider(prisma: PrismaClient): AkashProvider {
  return new AkashProvider(prisma)
}
