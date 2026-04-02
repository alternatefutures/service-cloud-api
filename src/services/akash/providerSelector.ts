/**
 * Akash Provider Selection Service
 *
 * Handles provider safety checking and bid filtering for user Akash deployments.
 * Prevents NAT hairpin issues by ensuring services that route through the SSL proxy
 * are not deployed on the same provider as the proxy.
 *
 * Verified (preferred) providers are loaded from the compute_provider DB table.
 * During bid selection, preferred providers are chosen over unverified ones
 * (cheapest preferred first), with unverified providers used only as a last resort.
 */

import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('provider-selector')

export type ServiceType = 'proxy' | 'backend' | 'standalone'

// ── In-memory cache (refreshed from DB periodically) ────────────────

let verifiedProviders = new Set<string>()
let blockedProviders = new Map<string, string>() // address → reason
let lastRefreshedAt = 0
const CACHE_TTL_MS = 5 * 60_000 // 5 minutes

/**
 * Refresh the verified/blocked provider sets from the database.
 * Called automatically when the cache expires, or manually after test runs.
 */
export async function refreshProviderCache(prisma: PrismaClient): Promise<void> {
  try {
    const providers = await prisma.computeProvider.findMany({
      where: { providerType: 'AKASH' },
      select: { address: true, verified: true, blocked: true, blockReason: true },
    })

    const nextVerified = new Set<string>()
    const nextBlocked = new Map<string, string>()

    for (const p of providers) {
      if (p.verified) nextVerified.add(p.address)
      if (p.blocked) nextBlocked.set(p.address, p.blockReason || 'Blocked')
    }

    verifiedProviders = nextVerified
    blockedProviders = nextBlocked
    lastRefreshedAt = Date.now()

    log.info(
      `Refreshed provider cache: ${nextVerified.size} verified, ${nextBlocked.size} blocked`
    )
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : err },
      'Failed to refresh provider cache from DB — using stale cache'
    )
  }
}

function isCacheStale(): boolean {
  return Date.now() - lastRefreshedAt > CACHE_TTL_MS
}

// ── Types ─────────────────────────────────────────────────────────────

export interface ProviderSafetyResult {
  safe: boolean
  provider: string
  providerName?: string
  reason: string
  blockedProvider?: string
  blockedProviderName?: string
}

export interface AkashBid {
  bidId: {
    owner: string
    dseq: bigint
    gseq: number
    oseq: number
    provider: string
  }
  state: number
  price: {
    denom: string
    amount: string
  }
  createdAt?: bigint
}

export interface FilteredBid extends AkashBid {
  isSafe: boolean
  unsafeReason?: string
  providerName?: string
}

/**
 * Current SSL proxy provider configuration.
 *
 * Backend services must avoid deploying on the same provider as the SSL proxy
 * to prevent NAT hairpin issues.
 */
const PROXY_PROVIDER = process.env.AKASH_SSL_PROXY_PROVIDER || 'akash1zlsep362zz46qlwzttm06t8lv9qtg8gtaya97u'
const PROXY_PROVIDER_NAME = process.env.AKASH_SSL_PROXY_PROVIDER_NAME || 'america.computer'

/**
 * Minimum provider uptime percentage required to accept a bid.
 * Providers below this threshold are filtered out during bid selection.
 * Fail-open: if Akashlytics API is unreachable, providers are allowed through.
 */
const MIN_UPTIME_PERCENT = parseFloat(process.env.AKASH_MIN_PROVIDER_UPTIME || '99.0')
const AKASHLYTICS_API_BASE = 'https://api.akashlytics.com/v1/providers'
const UPTIME_CACHE_TTL_MS = 5 * 60 * 1000
const UPTIME_FETCH_TIMEOUT_MS = 5_000

interface UptimeCacheEntry {
  uptime: number | null
  fetchedAt: number
}

const uptimeCache = new Map<string, UptimeCacheEntry>()

export class ProviderSelector {
  private proxyProvider: string
  private proxyProviderName: string

  constructor(
    proxyProvider: string = PROXY_PROVIDER,
    proxyProviderName: string = PROXY_PROVIDER_NAME,
  ) {
    this.proxyProvider = proxyProvider
    this.proxyProviderName = proxyProviderName
  }

  getProxyProvider(): string {
    return this.proxyProvider
  }

  /**
   * Ensure the provider cache is fresh. Call this before bid selection
   * if you have a Prisma client available.
   */
  async ensureFresh(prisma: PrismaClient): Promise<void> {
    if (isCacheStale()) {
      await refreshProviderCache(prisma)
    }
  }

  getBlockedProviders(serviceType: ServiceType): string[] {
    if (serviceType === 'proxy' || serviceType === 'standalone') return []
    return [this.proxyProvider]
  }

  isProviderSafe(
    providerAddress: string,
    serviceType: ServiceType
  ): ProviderSafetyResult {
    // Check DB-sourced blocklist
    const blockReason = blockedProviders.get(providerAddress)
    if (blockReason) {
      return {
        safe: false,
        provider: providerAddress,
        reason: `BLOCKED PROVIDER: ${blockReason}`,
        blockedProvider: providerAddress,
      }
    }

    if (serviceType === 'proxy' || serviceType === 'standalone') {
      return {
        safe: true,
        provider: providerAddress,
        reason: `${serviceType} services are not restricted by proxy provider`,
      }
    }

    if (providerAddress === this.proxyProvider) {
      return {
        safe: false,
        provider: providerAddress,
        reason:
          `NAT HAIRPIN ISSUE: Provider ${this.proxyProviderName} (${providerAddress}) is hosting the SSL proxy. ` +
          `Services routed through the proxy cannot be deployed here.`,
        blockedProvider: this.proxyProvider,
        blockedProviderName: this.proxyProviderName,
      }
    }

    return {
      safe: true,
      provider: providerAddress,
      reason: 'Provider is safe for this service type',
    }
  }

  filterBids(bids: AkashBid[], serviceType: ServiceType): FilteredBid[] {
    return bids.map(bid => {
      const provider = bid.bidId.provider
      const safetyResult = this.isProviderSafe(provider, serviceType)
      return {
        ...bid,
        isSafe: safetyResult.safe,
        unsafeReason: safetyResult.safe ? undefined : safetyResult.reason,
      }
    })
  }

  getSafeBids(bids: AkashBid[], serviceType: ServiceType): FilteredBid[] {
    return this.filterBids(bids, serviceType).filter(bid => bid.isSafe)
  }

  sortBidsByPriceAndSafety(bids: FilteredBid[]): FilteredBid[] {
    return [...bids].sort((a, b) => {
      if (a.isSafe && !b.isSafe) return -1
      if (!a.isSafe && b.isSafe) return 1
      const priceA = BigInt(a.price.amount)
      const priceB = BigInt(b.price.amount)
      if (priceA < priceB) return -1
      if (priceA > priceB) return 1
      return 0
    })
  }

  getBestProvider(bids: AkashBid[], serviceType: ServiceType): string | null {
    const safeBids = this.getSafeBids(bids, serviceType)
    if (safeBids.length === 0) return null
    const sorted = this.sortBidsByPriceAndSafety(safeBids)
    return sorted[0].bidId.provider
  }

  /**
   * Select the best bid using the verified provider whitelist from DB.
   * Preferred (verified) providers are chosen first, sorted by price.
   * Unverified providers are only used when no preferred provider has bid.
   */
  selectPreferredBid(bids: FilteredBid[]): FilteredBid | null {
    if (bids.length === 0) return null

    const preferred: FilteredBid[] = []
    const unverified: FilteredBid[] = []

    for (const bid of bids) {
      if (verifiedProviders.has(bid.bidId.provider)) {
        preferred.push(bid)
      } else {
        unverified.push(bid)
      }
    }

    const byPrice = (a: FilteredBid, b: FilteredBid) =>
      parseFloat(a.price.amount) - parseFloat(b.price.amount)

    if (preferred.length > 0) {
      preferred.sort(byPrice)
      log.info(
        `${preferred.length} preferred provider(s) bidding, ` +
        `picking cheapest: ${preferred[0].bidId.provider} @ ${preferred[0].price.amount}`
      )
      return preferred[0]
    }

    unverified.sort(byPrice)
    log.info(
      `No preferred providers among ${bids.length} bid(s). ` +
      `Falling back to cheapest: ${unverified[0].bidId.provider}`
    )
    return unverified[0]
  }

  isPreferredProvider(address: string): boolean {
    return verifiedProviders.has(address)
  }

  async fetchProviderUptime(address: string): Promise<number | null> {
    const cached = uptimeCache.get(address)
    if (cached && Date.now() - cached.fetchedAt < UPTIME_CACHE_TTL_MS) {
      return cached.uptime
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), UPTIME_FETCH_TIMEOUT_MS)

      const res = await fetch(`${AKASHLYTICS_API_BASE}/${address}`, {
        signal: controller.signal,
      })
      clearTimeout(timeout)

      if (!res.ok) {
        uptimeCache.set(address, { uptime: null, fetchedAt: Date.now() })
        return null
      }

      const data = await res.json() as Record<string, unknown>
      const uptime = typeof data.uptime === 'number' ? data.uptime
        : typeof data.uptime === 'string' ? parseFloat(data.uptime)
        : null

      uptimeCache.set(address, { uptime, fetchedAt: Date.now() })
      return uptime
    } catch {
      uptimeCache.set(address, { uptime: null, fetchedAt: Date.now() })
      return null
    }
  }

  /**
   * Filter safe bids by provider uptime from Akashlytics.
   * Fail-open: providers with unknown uptime are kept as fallback.
   */
  async filterBidsByUptime(bids: FilteredBid[]): Promise<FilteredBid[]> {
    if (bids.length === 0) return bids

    const uptimeResults = await Promise.allSettled(
      bids.map(bid => this.fetchProviderUptime(bid.bidId.provider))
    )

    const qualified: FilteredBid[] = []
    const unknownUptime: FilteredBid[] = []
    const rejected: Array<{ provider: string; uptime: number }> = []

    for (let i = 0; i < bids.length; i++) {
      const bid = bids[i]
      const result = uptimeResults[i]
      const uptime = result.status === 'fulfilled' ? result.value : null

      if (verifiedProviders.has(bid.bidId.provider)) {
        qualified.push(bid)
        continue
      }

      if (uptime === null) {
        unknownUptime.push(bid)
      } else if (uptime >= MIN_UPTIME_PERCENT) {
        qualified.push(bid)
      } else {
        rejected.push({ provider: bid.bidId.provider, uptime })
      }
    }

    if (rejected.length > 0) {
      log.info(
        `Filtered ${rejected.length} provider(s) below ${MIN_UPTIME_PERCENT}% uptime: ${rejected.map(r => `${r.provider} (${r.uptime.toFixed(1)}%)`).join(', ')}`
      )
    }

    if (qualified.length > 0) {
      if (unknownUptime.length > 0) {
        log.info(
          `${unknownUptime.length} provider(s) had unknown uptime, skipped in favor of ${qualified.length} verified provider(s)`
        )
      }
      return qualified
    }

    if (unknownUptime.length > 0) {
      log.info(
        `No providers met uptime threshold (${MIN_UPTIME_PERCENT}%). Falling back to ${unknownUptime.length} provider(s) with unknown uptime.`
      )
      return unknownUptime
    }

    log.info(`All ${bids.length} provider(s) failed uptime check. No bids remain.`)
    return []
  }
}

// Default singleton instance
export const providerSelector = new ProviderSelector()

export { PROXY_PROVIDER, PROXY_PROVIDER_NAME, MIN_UPTIME_PERCENT }
