/**
 * Phala Cloud Deployment Orchestrator
 *
 * Uses the `phala` CLI to deploy CVMs on Phala Cloud.
 * Mirrors AkashOrchestrator style: create DB record first, update status during lifecycle.
 *
 * Auth: PHALA_CLOUD_API_KEY env (mapped from PHALA_API_KEY).
 * Never log the API key.
 */

import { spawn, execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync, accessSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import type { PrismaClient } from '@prisma/client'
import type { PhalaDeploymentStatus } from '@prisma/client'
import type { ShellSession } from '../providers/types.js'
import { getPhalaHourlyRate, applyMargin } from '../../config/pricing.js'
import { getBillingApiClient } from '../billing/billingApiClient.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('phala-orchestrator')

/**
 * macOS ships LibreSSL which fails Phala's TLS-tunneled SSH.
 * Prefer Homebrew OpenSSL when available; fall back to system binary.
 */
function resolveOpenSslBin(): string {
  const brewPath = '/opt/homebrew/opt/openssl@3/bin/openssl'
  try {
    accessSync(brewPath)
    return brewPath
  } catch {
    return 'openssl'
  }
}

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

function runPhalaAsync(args: string[], timeout = PHALA_CLI_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = getPhalaEnv()
    const child = spawn('npx', ['phala', ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error(`Phala CLI timed out after ${timeout}ms`))
    }, timeout)

    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve(stdout)
      } else {
        reject(new Error(`Phala CLI exited with code ${code}: ${stderr.slice(0, 500)}`))
      }
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
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
   *
   * When QStash is available, creates the DB record and enqueues
   * DEPLOY_CVM as a background step with automatic retry on failure.
   * When QStash is not available (local dev), runs the step pipeline
   * in-process.
   */
  async deployServicePhala(
    serviceId: string,
    options: {
      composeContent: string
      env?: Record<string, string>
      envKeys?: string[]
      name?: string
      cvmSize?: string
      gpuModel?: string
      hourlyRateUsd?: number
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

    log.info(
      {
        serviceId,
        serviceName: service.slug,
        cvmSize,
        gpuModel: options.gpuModel ?? null,
        envKeyCount: envKeys.length,
        composeLength: options.composeContent.length,
        hourlyRateUsd: options.hourlyRateUsd,
      },
      'deployServicePhala: starting deployment'
    )

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

        const rawHourlyRate = options.hourlyRateUsd ?? getPhalaHourlyRate(cvmSize)
        const chargedHourlyRate = applyMargin(rawHourlyRate, orgMarkup.marginRate)
        hourlyRateCents = Math.ceil(chargedHourlyRate * 100)
      } catch (err) {
        log.warn({ err }, `Failed to resolve billing context for org ${organizationId}`)
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
        gpuModel: options.gpuModel ?? null,
        serviceId,
        siteId: service.type === 'SITE' ? service.site?.id : null,
        afFunctionId: service.type === 'FUNCTION' ? service.afFunction?.id : null,
        hourlyRateCents,
        marginRate,
        orgBillingId,
        organizationId,
        retryCount: 0,
      },
    })

    log.info(`Created deployment record ${deployment.id}, enqueuing DEPLOY_CVM step...`)

    const { isQStashEnabled, publishJob } = await import('../queue/qstashClient.js')
    const { handlePhalaStep } = await import('../queue/webhookHandler.js')

    if (isQStashEnabled()) {
      await publishJob('/queue/phala/step', { step: 'DEPLOY_CVM', deploymentId: deployment.id })
    } else {
      handlePhalaStep({ step: 'DEPLOY_CVM', deploymentId: deployment.id }).catch(err => {
        log.error({ err }, 'In-process step pipeline failed')
      })
    }

    return deployment.id
  }

  /**
   * Get CVM status via phala cvms get --json
   */
  async getCvmStatus(appId: string): Promise<Record<string, unknown> | null> {
    try {
      const output = await runPhalaAsync(['cvms', 'get', appId, '--json'], 15_000)
      return extractJson(output) as Record<string, unknown>
    } catch {
      return null
    }
  }

  /**
   * Probe CVM existence at the provider. Used by the sweeper's reconciler to
   * distinguish "CVM is genuinely gone (deleted out-of-band on Phala's side
   * or never existed)" from "CLI threw a transient error" — the former is a
   * sweeper-close signal ('gone' verdict), the latter must NOT close the row.
   *
   * Returns:
   *   - 'exists'  : phala cvms get succeeded → the CVM is registered with the
   *                 provider (even if it's currently unhealthy/crashed).
   *   - 'gone'    : phala cvms get failed with a "not found" / "404" error —
   *                 the provider has no record of this appId. The DB row is
   *                 an orphan and Phala billing should be settled.
   *   - 'unknown' : transient error (timeout, network blip, CLI crash). The
   *                 sweeper treats this as visible_only and never closes.
   */
  async probeCvmExistence(appId: string): Promise<'exists' | 'gone' | 'unknown'> {
    try {
      await runPhalaAsync(['cvms', 'get', appId, '--json'], 15_000)
      return 'exists'
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
      // Phala CLI surfaces "not found" / "no such" / "404" in stderr when
      // the appId doesn't exist. Anything else (timeout, ECONNRESET, JSON
      // parse error, generic non-zero exit) stays 'unknown' so we don't
      // close on transient failures.
      const isGone =
        msg.includes('not found') ||
        msg.includes('no such') ||
        msg.includes('404') ||
        msg.includes('does not exist')
      return isGone ? 'gone' : 'unknown'
    }
  }

  async stopPhalaDeployment(appId: string): Promise<void> {
    await runPhalaAsync(['cvms', 'stop', appId], 30_000)
  }

  async startPhalaDeployment(appId: string): Promise<void> {
    await runPhalaAsync(['cvms', 'start', appId], 30_000)
  }

  async deletePhalaDeployment(appId: string): Promise<void> {
    await runPhalaAsync(['cvms', 'delete', appId, '--force'], 30_000)
  }

  async getPhalaLogs(appId: string, tail?: number): Promise<string | null> {
    try {
      const args = ['cvms', 'logs', appId]
      if (tail) args.push('--tail', String(tail))
      return await runPhalaAsync(args, 15_000)
    } catch {
      return null
    }
  }

  async getPhalaAttestation(appId: string): Promise<Record<string, unknown> | null> {
    try {
      const output = await runPhalaAsync(['cvms', 'attestation', appId, '--json'], 15_000)
      return extractJson(output) as Record<string, unknown>
    } catch {
      return null
    }
  }

  async getCvmRuntimeConfig(appId: string): Promise<{ hostname: string; default_gateway_domain: string; ssh_authorized_keys: string[] } | null> {
    try {
      const output = await runPhalaAsync(['runtime-config', appId, '--json'], 15_000)
      const result = extractJson(output) as Record<string, unknown>
      if (!result?.success) return null
      return {
        hostname: result.hostname as string,
        default_gateway_domain: result.default_gateway_domain as string,
        ssh_authorized_keys: (result.ssh_authorized_keys as string[]) ?? [],
      }
    } catch {
      return null
    }
  }

  /**
   * Spawn an interactive SSH shell into a running CVM.
   * Uses the gateway info from runtime-config and a platform SSH keypair.
   */
  async getShell(appId: string, command?: string): Promise<ShellSession> {
    const sshKeyPath = getSshKeyPath()
    try {
      accessSync(sshKeyPath)
    } catch {
      throw new Error(
        `Platform SSH key not found at ${sshKeyPath}. ` +
        'Set PHALA_SSH_KEY_PATH or generate a key with: ssh-keygen -t ed25519 -f ~/.ssh/af_phala_ed25519'
      )
    }

    const config = await this.getCvmRuntimeConfig(appId)
    const gateway = config?.default_gateway_domain
    if (!gateway) {
      throw new Error(`Cannot determine CVM gateway for SSH (appId: ${appId})`)
    }

    const opensslBin = resolveOpenSslBin()
    const sshTarget = `root@${appId}-22.${gateway}`
    const sshArgs = [
      '-o', `ProxyCommand=${opensslBin} s_client -quiet -connect %h:%p 2>/dev/null`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ConnectTimeout=30',
      '-p', '443',
      '-i', sshKeyPath,
      sshTarget,
    ]

    if (command && command !== '/bin/bash' && command !== '/bin/sh') {
      sshArgs.push(command)
    }

    log.info(`Spawning Phala SSH: ssh ${sshArgs.join(' ')}`)

    let pty: any
    try {
      const { createRequire } = await import('module')
      const require = createRequire(import.meta.url)
      pty = require('node-pty')
    } catch {
      log.warn('node-pty not available, falling back to spawn-based SSH')
      return this.getShellFallback(sshArgs)
    }

    let sshBinPath = 'ssh'
    try {
      sshBinPath = execFileSync('which', ['ssh'], { encoding: 'utf-8' }).trim()
    } catch { /* fall through with bare name */ }

    const ptyProcess = pty.spawn(sshBinPath, sshArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: { ...process.env },
    })

    let killed = false

    return {
      write(data: Buffer | string) {
        if (!killed) ptyProcess.write(typeof data === 'string' ? data : data.toString())
      },
      onData(callback: (data: Buffer) => void) {
        ptyProcess.onData((data: string) => callback(Buffer.from(data)))
      },
      onExit(callback: (code: number | null) => void) {
        ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
          killed = true
          callback(exitCode)
        })
      },
      resize(cols: number, rows: number) {
        if (!killed) ptyProcess.resize(cols, rows)
      },
      kill() {
        if (!killed) { killed = true; ptyProcess.kill() }
      },
    }
  }

  private getShellFallback(sshArgs: string[]): ShellSession {
    const child = spawn('ssh', sshArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    })

    let killed = false

    return {
      write(data: Buffer | string) {
        if (!killed) child.stdin?.write(data)
      },
      onData(callback: (data: Buffer) => void) {
        child.stdout?.on('data', (chunk: Buffer) => callback(chunk))
        child.stderr?.on('data', (chunk: Buffer) => callback(chunk))
      },
      onExit(callback: (code: number | null) => void) {
        child.on('close', (code) => { killed = true; callback(code) })
      },
      resize() { /* no PTY resize without node-pty */ },
      kill() {
        if (!killed) { killed = true; child.kill('SIGTERM') }
      },
    }
  }
}

/**
 * Resolve the platform SSH private key path for Phala CVM access.
 * Set PHALA_SSH_KEY_PATH to override the default location.
 */
export function getSshKeyPath(): string {
  return process.env.PHALA_SSH_KEY_PATH || join(homedir(), '.ssh', 'af_phala_ed25519')
}

let orchestratorInstance: PhalaOrchestrator | null = null

export function getPhalaOrchestrator(prisma: PrismaClient): PhalaOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new PhalaOrchestrator(prisma)
  }
  return orchestratorInstance
}
