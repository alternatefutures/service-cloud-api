/**
 * Phala DeploymentProvider Adapter
 *
 * Wraps the existing PhalaOrchestrator behind the DeploymentProvider interface.
 *
 * Status mapping (Phala native → ProviderStatus):
 *   CREATING               → 'creating'
 *   STARTING               → 'starting'
 *   ACTIVE                 → 'active'
 *   FAILED                 → 'failed'
 *   STOPPED                → 'stopped'
 *   DELETED                → 'deleted'
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
import { getPhalaOrchestrator } from '../phala/orchestrator.js'

const PHALA_STATUS_MAP: Record<string, ProviderStatus> = {
  CREATING: 'creating',
  STARTING: 'starting',
  ACTIVE: 'active',
  FAILED: 'failed',
  STOPPED: 'stopped',
  DELETED: 'deleted',
}

function mapStatus(nativeStatus: string): ProviderStatus {
  return PHALA_STATUS_MAP[nativeStatus] ?? 'failed'
}

export class PhalaProvider implements DeploymentProvider {
  readonly name = 'phala'
  readonly displayName = 'Phala Cloud (TEE)'

  constructor(private prisma: PrismaClient) {}

  isAvailable(): boolean {
    return !!(process.env.PHALA_API_KEY || process.env.PHALA_CLOUD_API_KEY)
  }

  async deploy(serviceId: string, options: DeployOptions): Promise<DeploymentResult> {
    if (!options.composeContent) {
      throw new Error('Phala deployments require composeContent in DeployOptions')
    }

    const orchestrator = getPhalaOrchestrator(this.prisma)

    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
    })
    if (!service) throw new Error(`Service not found: ${serviceId}`)

    const deploymentId = await orchestrator.deployServicePhala(serviceId, {
      composeContent: options.composeContent,
      env: options.env,
      envKeys: options.env ? Object.keys(options.env) : undefined,
      name: `af-${service.slug}-${Date.now().toString(36)}`,
    })

    const deployment = await this.prisma.phalaDeployment.findUnique({
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
    if (deployment.appUrl) {
      serviceUrls.app = [deployment.appUrl]
    }

    return {
      deploymentId: deployment.id,
      providerDeploymentId: deployment.appId,
      status: mapStatus(deployment.status),
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      errorMessage: deployment.errorMessage ?? undefined,
    }
  }

  async stop(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)

    const orchestrator = getPhalaOrchestrator(this.prisma)
    await orchestrator.stopPhalaDeployment(deployment.appId)

    await this.prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'STOPPED' },
    })
  }

  async start(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)

    const orchestrator = getPhalaOrchestrator(this.prisma)
    await orchestrator.startPhalaDeployment(deployment.appId)

    await this.prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'ACTIVE' },
    })
  }

  async close(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)
    if (deployment.status === 'DELETED') return

    const orchestrator = getPhalaOrchestrator(this.prisma)
    await orchestrator.deletePhalaDeployment(deployment.appId)

    await this.prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'DELETED' },
    })
  }

  async getStatus(deploymentId: string): Promise<DeploymentStatusResult> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)

    const orchestrator = getPhalaOrchestrator(this.prisma)
    const cvmStatus = await orchestrator.getCvmStatus(deployment.appId)

    const serviceUrls: Record<string, string[]> = {}
    if (deployment.appUrl) {
      serviceUrls.app = [deployment.appUrl]
    }

    return {
      status: mapStatus(deployment.status),
      nativeStatus: deployment.status,
      serviceUrls: Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined,
      metadata: {
        appId: deployment.appId,
        name: deployment.name,
        cvmSize: deployment.cvmSize,
        teepod: deployment.teepod,
        hourlyRateCents: deployment.hourlyRateCents,
        totalBilledCents: deployment.totalBilledCents,
        cvmLiveStatus: cvmStatus,
      },
    }
  }

  async getLogs(deploymentId: string, opts?: LogOptions): Promise<string> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)

    const orchestrator = getPhalaOrchestrator(this.prisma)
    return (await orchestrator.getPhalaLogs(deployment.appId, opts?.tail)) ?? ''
  }

  getCapabilities(): ProviderCapabilities {
    return {
      supportsStop: true,
      supportsLogStreaming: false,
      supportsTEE: true,
      supportsPersistentStorage: true,
      supportsWebSocket: true,
      configFormat: 'compose',
      billingModel: 'hourly',
    }
  }
}

export function createPhalaProvider(prisma: PrismaClient): PhalaProvider {
  return new PhalaProvider(prisma)
}
