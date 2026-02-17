/**
 * Phala Cloud Deployment Orchestrator
 *
 * Uses the `phala` CLI to deploy CVMs on Phala Cloud.
 * Mirrors AkashOrchestrator style: create DB record first, update status during lifecycle.
 *
 * Auth: PHALA_CLOUD_API_KEY env (mapped from PHALA_API_KEY).
 * Never log the API key.
 */

import { execSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PrismaClient } from '@prisma/client'
import type { PhalaDeploymentStatus } from '@prisma/client'
import { getPhalaHourlyRate, applyMargin } from '../../config/pricing.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'

const PHALA_CLI_TIMEOUT_MS = 120_000
const POLL_INTERVAL_MS = 5000
const POLL_MAX_ATTEMPTS = 24 // 2 minutes

function getPhalaEnv(): Record<string, string> {
  const key = process.env.PHALA_API_KEY || process.env.PHALA_CLOUD_API_KEY
  if (!key) {
    throw new Error('PHALA_API_KEY or PHALA_CLOUD_API_KEY is not set')
  }
  return { ...process.env, PHALA_CLOUD_API_KEY: key }
}

function runPhala(args: string[], timeout = PHALA_CLI_TIMEOUT_MS): string {
  const env = getPhalaEnv()
  const cmd = `npx phala ${args.join(' ')}`
  return execSync(cmd, {
    encoding: 'utf-8',
    env,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  })
}

/**
 * Extract the first JSON object or array from a string that may contain
 * non-JSON prefix text (e.g. "Provisioning...\n{...}").
 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  // Fast path: already valid JSON
  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
  }

  // Find the first '{' or '[' and try to parse from there
  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)

  if (startIdx === -1) {
    throw new SyntaxError(`No JSON found in CLI output: ${trimmed.slice(0, 200)}`)
  }

  const jsonCandidate = trimmed.slice(startIdx)
  return JSON.parse(jsonCandidate)
}

export class PhalaOrchestrator {
  constructor(private prisma: PrismaClient) {}

  /**
   * Deploy a service to Phala from compose + env.
   * Creates DB record first, then runs phala deploy.
   */
  async deployServicePhala(
    serviceId: string,
    options: {
      composeContent: string
      env?: Record<string, string>
      envKeys?: string[] // keys only, for storage
      name?: string
      cvmSize?: string // tdx.small, tdx.medium, tdx.large, tdx.xlarge
    }
  ): Promise<string> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { site: true, afFunction: true, project: { select: { organizationId: true } } },
    })

    if (!service) {
      throw new Error(`Service not found: ${serviceId}`)
    }

    const name = options.name || `af-${service.slug}-${Date.now().toString(36)}`
    const envKeys = options.envKeys || []
    const cvmSize = options.cvmSize || 'tdx.large'

    // Resolve billing context
    let orgBillingId: string | null = null
    let organizationId: string | null = service.project?.organizationId ?? null
    let hourlyRateCents: number | null = null
    let marginRate: number | null = null

    if (organizationId) {
      try {
        const billingApi = getBillingApiClient()
        const orgBilling = await billingApi.getOrgBilling(organizationId)
        const orgMarkup = await billingApi.getOrgMarkup(orgBilling.orgBillingId)

        orgBillingId = orgBilling.orgBillingId
        marginRate = orgMarkup.marginRate

        const rawHourlyRate = getPhalaHourlyRate(cvmSize)
        const chargedHourlyRate = applyMargin(rawHourlyRate, orgMarkup.marginRate)
        hourlyRateCents = Math.ceil(chargedHourlyRate * 100)
      } catch (err) {
        console.warn(`[PhalaOrchestrator] Failed to resolve billing context for org ${organizationId}:`, err)
      }
    }

    // Create DB record first (with billing fields)
    const deployment = await this.prisma.phalaDeployment.create({
      data: {
        appId: 'pending',
        name,
        status: 'CREATING',
        composeContent: options.composeContent,
        envKeys: envKeys.length > 0 ? (envKeys as string[]) : undefined,
        cvmSize,
        serviceId,
        siteId: service.type === 'SITE' ? service.site?.id : null,
        afFunctionId: service.type === 'FUNCTION' ? service.afFunction?.id : null,
        // Billing fields
        hourlyRateCents,
        marginRate,
        orgBillingId,
        organizationId,
      },
    })

    let workDir: string | null = null

    try {
      workDir = mkdtempSync(join(tmpdir(), 'phala-deploy-'))
      const composePath = join(workDir, 'docker-compose.yml')
      const envPath = join(workDir, '.env')

      writeFileSync(composePath, options.composeContent)

      const envVars = options.env || {}
      const envLines = Object.entries(envVars)
        .map(([k, v]) => `${k}=${v}`)
        .join('\n')
      writeFileSync(envPath, envLines)

      const deployArgs = ['deploy', '-n', name, '-c', composePath]
      if (Object.keys(envVars).length > 0) {
        deployArgs.push('-e', envPath)
      }
      deployArgs.push('--json')

      const output = runPhala(deployArgs)
      const result = extractJson(output) as Record<string, unknown>

      if (!result?.success) {
        throw new Error(String(result?.error || result?.message || 'Deploy failed'))
      }

      const appIdRaw = result.app_id || result.appId || result.vm_uuid
      if (!appIdRaw) {
        throw new Error('Deploy succeeded but no app_id returned')
      }
      const appId = String(appIdRaw)

      await this.prisma.phalaDeployment.update({
        where: { id: deployment.id },
        data: { appId, status: 'STARTING' },
      })

      // Poll until running
      let appUrl: string | null = null
      for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS))
        const status = await this.getCvmStatus(appId)
        if (status?.status === 'running') {
          const urls = (status.public_urls || status.publicUrls || []) as Array<{ app?: string } | string>
          const first = urls[0]
          appUrl = typeof first === 'string' ? first : first?.app ?? null
          break
        }
        if (status?.status === 'failed' || status?.status === 'error') {
          const errMsg = typeof status.error === 'string' ? status.error : String(status.message || 'CVM failed')
          throw new Error(errMsg)
        }
      }

      await this.prisma.phalaDeployment.update({
        where: { id: deployment.id },
        data: {
          status: 'ACTIVE' as PhalaDeploymentStatus,
          appUrl,
          activeStartedAt: new Date(),
          lastBilledAt: new Date(), // billing clock starts now
        },
      })

      return deployment.id
    } catch (error) {
      await this.prisma.phalaDeployment.update({
        where: { id: deployment.id },
        data: {
          status: 'FAILED',
          errorMessage: error instanceof Error ? error.message : 'Unknown error',
        },
      })
      throw error
    } finally {
      if (workDir) {
        try {
          rmSync(workDir, { recursive: true })
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }

  /**
   * Get CVM status via phala cvms get --json
   */
  async getCvmStatus(appId: string): Promise<Record<string, unknown> | null> {
    try {
      const output = runPhala(['cvms', 'get', appId, '--json'], 15_000)
      return extractJson(output) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async stopPhalaDeployment(appId: string): Promise<void> {
    runPhala(['cvms', 'stop', appId], 30_000)
  }

  async startPhalaDeployment(appId: string): Promise<void> {
    runPhala(['cvms', 'start', appId], 30_000)
  }

  async deletePhalaDeployment(appId: string): Promise<void> {
    runPhala(['cvms', 'delete', appId, '--force'], 30_000)
  }

  async getPhalaLogs(appId: string, tail?: number): Promise<string | null> {
    try {
      const args = ['cvms', 'logs', appId]
      if (tail) args.push('--tail', String(tail))
      return runPhala(args, 15_000)
    } catch {
      return null
    }
  }

  async getPhalaAttestation(appId: string): Promise<Record<string, unknown> | null> {
    try {
      const output = runPhala(['cvms', 'attestation', appId, '--json'], 15_000)
      return extractJson(output) as Record<string, unknown>
    } catch {
      return null
    }
  }
}

let orchestratorInstance: PhalaOrchestrator | null = null

export function getPhalaOrchestrator(prisma: PrismaClient): PhalaOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new PhalaOrchestrator(prisma)
  }
  return orchestratorInstance
}
