/**
 * Provider Registry Scheduler
 *
 * Keeps the compute_provider table up to date:
 *   1. **Hourly scan** — fetches live provider data from the Akash console API,
 *      upserts GPU inventory & online status into the DB.
 *   2. DB data is consumed by the bid selection pipeline (providerSelector)
 *      and the web-app GPU availability endpoint.
 *
 * Follows the same start/stop pattern as ComputeBillingScheduler.
 */

import * as cron from 'node-cron'
import type { PrismaClient, ComputeProviderType } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('provider-registry')

const AKASH_CONSOLE_API = 'https://console-api.akash.network/v1/providers'
const FETCH_TIMEOUT_MS = 30_000

interface ConsoleGpuModel {
  vendor: string
  model: string
  ram: string
  interface: string
}

interface ConsoleProvider {
  owner?: string
  hostUri?: string
  isOnline: boolean
  stats?: {
    gpu?: {
      available?: number
      total?: number
    }
  }
  gpuModels?: ConsoleGpuModel[]
  attributes?: Array<{ key: string; value: string }>
}

export class ProviderRegistryScheduler {
  private cronJob: cron.ScheduledTask | null = null
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  start() {
    if (this.cronJob) {
      log.info('Already running')
      return
    }

    // Every hour at :15 (offset from billing at :00)
    this.cronJob = cron.schedule('15 * * * *', async () => {
      try {
        await this.scanProviders()
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'Hourly scan failed'
        )
      }
    })

    log.info('Started — scans every hour at :15')

    // Run once immediately on startup (non-blocking)
    this.scanProviders().catch(err => {
      log.error(
        { err: err instanceof Error ? err.message : err },
        'Initial scan failed'
      )
    })
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
      log.info('Stopped')
    }
  }

  /**
   * Run a scan manually (e.g. from test-deploy after test results).
   */
  async runNow(): Promise<void> {
    log.info('Manual scan triggered')
    await this.scanProviders()
  }

  /**
   * Fetch live Akash provider data and upsert into the DB.
   */
  async scanProviders(): Promise<{ upserted: number; errors: number }> {
    const start = Date.now()
    log.info('Scanning Akash providers...')

    let providers: ConsoleProvider[]
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

      const res = await fetch(AKASH_CONSOLE_API, {
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        log.error(`Akash console API returned ${res.status}`)
        return { upserted: 0, errors: 1 }
      }

      providers = (await res.json()) as ConsoleProvider[]
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        'Failed to fetch Akash console API'
      )
      return { upserted: 0, errors: 1 }
    }

    let upserted = 0
    let errors = 0
    const now = new Date()

    for (const provider of providers) {
      const address = provider.owner?.trim()
      if (!address) continue

      const gpuStats = provider.stats?.gpu
      const gpuAvailable = gpuStats?.available ?? 0
      const gpuTotal = gpuStats?.total ?? 0
      const gpuModels = (provider.gpuModels ?? [])
        .map(g => g.model?.toLowerCase())
        .filter((m): m is string => !!m)
      const uniqueGpuModels = [...new Set(gpuModels)]

      try {
        await this.prisma.computeProvider.upsert({
          where: { address },
          create: {
            address,
            providerType: 'AKASH' as ComputeProviderType,
            isOnline: provider.isOnline,
            lastSeenOnlineAt: provider.isOnline ? now : null,
            gpuModels: uniqueGpuModels,
            gpuAvailable,
            gpuTotal,
            attributes: provider.attributes as any ?? null,
          },
          update: {
            isOnline: provider.isOnline,
            ...(provider.isOnline ? { lastSeenOnlineAt: now } : {}),
            gpuModels: uniqueGpuModels,
            gpuAvailable,
            gpuTotal,
            attributes: provider.attributes as any ?? null,
          },
        })
        upserted++
      } catch (err) {
        log.warn(
          { address, err: err instanceof Error ? err.message : err },
          'Failed to upsert provider'
        )
        errors++
      }
    }

    // Mark providers not in the API response as offline
    const apiAddresses = new Set(
      providers
        .map(p => p.owner?.trim())
        .filter((a): a is string => !!a)
    )

    try {
      const staleProviders = await this.prisma.computeProvider.findMany({
        where: {
          providerType: 'AKASH',
          isOnline: true,
          address: { notIn: [...apiAddresses] },
        },
        select: { id: true },
      })

      if (staleProviders.length > 0) {
        await this.prisma.computeProvider.updateMany({
          where: { id: { in: staleProviders.map(p => p.id) } },
          data: { isOnline: false, gpuAvailable: 0 },
        })
        log.info(`Marked ${staleProviders.length} provider(s) offline (not in API response)`)
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : err },
        'Failed to mark stale providers offline'
      )
    }

    const durationMs = Date.now() - start
    log.info(
      { upserted, errors, durationMs },
      `Scan complete — ${upserted} provider(s) upserted in ${durationMs}ms`
    )

    return { upserted, errors }
  }
}
