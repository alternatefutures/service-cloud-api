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
import { refreshProviderRegions } from '../regions/refresh.js'

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

    // Every 15 minutes at :00/:15/:30/:45 — Phase 51 mitigation. The hourly
    // cadence (Phase 24) was hiding a 0–60-min staleness window: a provider
    // sells out at :16, our snapshot says "still 8 H100 free" until :15
    // next hour, the dropdown advertises capacity that won't bid, the user
    // gets a confusing "no bids" timeout. 15-min cuts the worst-case to
    // ~16 min and pairs with the bid-probe gating in the BFF route.
    this.cronJob = cron.schedule('*/15 * * * *', async () => {
      try {
        await this.scanProviders()
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : err },
          'Scheduled scan failed'
        )
      }
    })

    log.info('Started — scans every 15 minutes')

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
      // Normalise the console API's gpuModels[] into three parallel
      // structures: a deduped string[] of model names (kept for backward
      // compat with every existing query/filter), and two JSON maps that
      // surface VRAM + interface per model so the dropdown/overview
      // cards can render "H100 · 80GB" without re-parsing chain attrs.
      const rawGpuModels = provider.gpuModels ?? []
      const gpuModels: string[] = []
      const gpuRam: Record<string, string> = {}
      const gpuInterface: Record<string, string> = {}
      for (const g of rawGpuModels) {
        const model = g.model?.toLowerCase()
        if (!model) continue
        gpuModels.push(model)
        // First write wins; same model on the same provider always
        // reports the same VRAM in the wild, but in case the console
        // ever returns conflicting rows we prefer the one with a
        // non-empty value over an empty placeholder.
        if (g.ram && !gpuRam[model]) gpuRam[model] = g.ram
        if (g.interface && !gpuInterface[model]) {
          gpuInterface[model] = g.interface.toLowerCase()
        }
      }
      const uniqueGpuModels = [...new Set(gpuModels)]
      const gpuRamPayload = Object.keys(gpuRam).length > 0 ? gpuRam : null
      const gpuInterfacePayload =
        Object.keys(gpuInterface).length > 0 ? gpuInterface : null

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
            gpuRam: gpuRamPayload as any,
            gpuInterface: gpuInterfacePayload as any,
            attributes: provider.attributes as any ?? null,
          },
          update: {
            isOnline: provider.isOnline,
            ...(provider.isOnline ? { lastSeenOnlineAt: now } : {}),
            gpuModels: uniqueGpuModels,
            gpuAvailable,
            gpuTotal,
            gpuRam: gpuRamPayload as any,
            gpuInterface: gpuInterfacePayload as any,
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

    // Phase 46 — region resolution piggybacks on the hourly scan. The
    // chain `attributes` we just upserted are the second-best region signal
    // (after Akashlytics lat/lon), so refreshing immediately after means
    // every newly-onboarded provider gets a region within an hour. Fail-open
    // by design: a region-refresh failure does not affect the registry scan
    // result, since region is purely additive metadata.
    if (process.env.AF_REGIONS_INGEST !== '0') {
      try {
        await refreshProviderRegions(this.prisma)
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : err },
          'Region refresh failed during hourly scan — region data may be stale'
        )
      }
    }

    return { upserted, errors }
  }
}
