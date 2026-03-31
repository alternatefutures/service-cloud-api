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
  DeploymentHealthResult,
  ContainerHealth,
  ContainerStatus,
  OverallHealth,
  LogOptions,
  ProviderCapabilities,
  ProviderStatus,
} from './types.js'
import { getPhalaOrchestrator } from '../phala/orchestrator.js'
import { processFinalPhalaBilling } from '../billing/deploymentSettlement.js'
import { scheduleOrEnforcePolicyExpiry } from '../policy/runtimeScheduler.js'
import { createLogger } from '../../lib/logger.js'

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

const log = createLogger('phala-provider')

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

    const stoppedAt = new Date()
    if (deployment.status === 'ACTIVE') {
      await processFinalPhalaBilling(
        this.prisma,
        deploymentId,
        stoppedAt,
        'phala_provider_stop'
      )
    }

    const orchestrator = getPhalaOrchestrator(this.prisma)
    await orchestrator.stopPhalaDeployment(deployment.appId)

    await this.prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'STOPPED' },
    })

    if (deployment.policyId) {
      await this.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt },
      })
    }
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
      data: { status: 'ACTIVE', activeStartedAt: new Date(), lastBilledAt: new Date() },
    })

    if (deployment.policyId) {
      await this.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: null, stoppedAt: null },
      })

      await scheduleOrEnforcePolicyExpiry(this.prisma, deployment.policyId).catch(
        err => {
          log.warn(
            { deploymentId, policyId: deployment.policyId, err },
            'Failed to schedule resumed Phala policy expiry'
          )
        }
      )
    }
  }

  async close(deploymentId: string): Promise<void> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) throw new Error(`Phala deployment not found: ${deploymentId}`)
    if (deployment.status === 'DELETED') return

    const deletedAt = new Date()
    if (deployment.status === 'ACTIVE') {
      await processFinalPhalaBilling(
        this.prisma,
        deploymentId,
        deletedAt,
        'phala_provider_close'
      )
    }

    const orchestrator = getPhalaOrchestrator(this.prisma)
    await orchestrator.deletePhalaDeployment(deployment.appId)

    await this.prisma.phalaDeployment.update({
      where: { id: deploymentId },
      data: { status: 'DELETED' },
    })

    if (deployment.policyId) {
      await this.prisma.deploymentPolicy.update({
        where: { id: deployment.policyId },
        data: { stopReason: 'MANUAL_STOP', stoppedAt: deletedAt },
      })
    }
  }

  async getHealth(deploymentId: string): Promise<DeploymentHealthResult | null> {
    const deployment = await this.prisma.phalaDeployment.findUnique({
      where: { id: deploymentId },
    })
    if (!deployment) return null

    const terminalStates = new Set(['DELETED', 'FAILED', 'PERMANENTLY_FAILED'])
    if (terminalStates.has(deployment.status)) {
      return {
        provider: 'phala',
        overall: deployment.status === 'DELETED' ? 'unknown' : 'unhealthy',
        containers: [{
          name: deployment.name,
          status: 'error' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: deployment.appUrl ? [deployment.appUrl] : [],
          message: deployment.errorMessage ?? undefined,
        }],
        lastChecked: new Date(),
      }
    }

    if (deployment.status === 'CREATING' || deployment.status === 'STARTING') {
      return {
        provider: 'phala',
        overall: 'starting',
        containers: [{
          name: deployment.name,
          status: 'starting' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: [],
        }],
        lastChecked: new Date(),
      }
    }

    if (deployment.status === 'STOPPED') {
      return {
        provider: 'phala',
        overall: 'unknown',
        containers: [{
          name: deployment.name,
          status: 'unknown' as ContainerStatus,
          ready: false,
          total: 1,
          available: 0,
          uris: deployment.appUrl ? [deployment.appUrl] : [],
        }],
        lastChecked: new Date(),
      }
    }

    try {
      const orchestrator = getPhalaOrchestrator(this.prisma)
      const cvmStatus = await orchestrator.getCvmStatus(deployment.appId)

      let status: ContainerStatus = 'unknown'
      let overall: OverallHealth = 'unknown'
      const cvmState = (cvmStatus?.status as string) ?? ''

      if (cvmState === 'running') {
        status = 'running'
        overall = 'healthy'
      } else if (cvmState === 'starting' || cvmState === 'provisioning') {
        status = 'starting'
        overall = 'starting'
      } else if (cvmState === 'failed' || cvmState === 'error') {
        status = 'crashed'
        overall = 'unhealthy'
      }

      const container: ContainerHealth = {
        name: deployment.name,
        status,
        ready: status === 'running',
        total: 1,
        available: status === 'running' ? 1 : 0,
        uris: deployment.appUrl ? [deployment.appUrl] : [],
        message: (cvmStatus?.error as string) ?? (cvmStatus?.message as string) ?? undefined,
      }

      return { provider: 'phala', overall, containers: [container], lastChecked: new Date() }
    } catch {
      return {
        provider: 'phala',
        overall: deployment.status === 'ACTIVE' ? 'healthy' : 'unknown',
        containers: [{
          name: deployment.name,
          status: deployment.status === 'ACTIVE' ? 'running' : 'unknown',
          ready: deployment.status === 'ACTIVE',
          total: 1,
          available: deployment.status === 'ACTIVE' ? 1 : 0,
          uris: deployment.appUrl ? [deployment.appUrl] : [],
        }],
        lastChecked: new Date(),
      }
    }
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
