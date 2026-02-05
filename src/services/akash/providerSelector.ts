/**
 * Akash Provider Selection Service
 *
 * Handles provider safety checking and bid filtering for user Akash deployments.
 * Prevents NAT hairpin issues by ensuring services that route through the SSL proxy
 * are not deployed on the same provider as the proxy.
 *
 * Usage:
 *   import { ProviderSelector } from './providerSelector';
 *
 *   const selector = new ProviderSelector();
 *   const safeBids = selector.filterBids(bids, 'backend');
 *   const isSafe = selector.isProviderSafe(providerAddress, 'backend');
 */

export type ServiceType = 'proxy' | 'backend' | 'standalone'

export interface ProviderInfo {
  address: string
  name: string
  hasIpLeases: boolean
  ipLeaseStatus: 'available' | 'exhausted' | 'unknown'
  lastChecked?: Date
  notes?: string
}

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
 * UPDATE THIS WHEN THE PROXY MOVES TO A DIFFERENT PROVIDER.
 * Source of truth: admin/infrastructure/deployments.ts
 *
 * History:
 * - 2025-12-23: Moved from DigitalFrontier to Europlots (IP pool exhausted)
 */
const PROXY_PROVIDER = 'akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc'
const PROXY_PROVIDER_NAME = 'Europlots'

/**
 * Providers with known issues that should be blocked for all deployments.
 * 
 * History:
 * - 2026-02-05: Added airitdecomp - wildcard DNS not configured for ingress
 */
const BLOCKED_PROVIDERS: Record<string, { address: string; name: string; reason: string }> = {
  akash1adyrcsp2ptwd83txgv555eqc0vhfufc37wx040: {
    address: 'akash1adyrcsp2ptwd83txgv555eqc0vhfufc37wx040',
    name: 'AiritDecomp',
    reason: 'Wildcard DNS not configured - ingress URLs do not resolve',
  },
}

/**
 * Known Akash providers with metadata.
 * Update when provider status changes.
 */
const KNOWN_PROVIDERS: Record<string, ProviderInfo> = {
  akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc: {
    address: 'akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc',
    name: 'Europlots',
    hasIpLeases: true,
    ipLeaseStatus: 'available',
    lastChecked: new Date('2025-12-23'),
    notes:
      'Currently hosting SSL proxy (62.3.50.133) - BLOCKED for backend services',
  },
  akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z: {
    address: 'akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z',
    name: 'DigitalFrontier',
    hasIpLeases: true,
    ipLeaseStatus: 'exhausted',
    lastChecked: new Date('2025-12-23'),
    notes: 'IP pool exhausted as of 2025-12-23',
  },
  akash1f6gmtjpx4r8qda9nxjwq26fp5mcjyqmaq5m6j7: {
    address: 'akash1f6gmtjpx4r8qda9nxjwq26fp5mcjyqmaq5m6j7',
    name: 'Subangle (GPU)',
    hasIpLeases: false,
    ipLeaseStatus: 'unknown',
    notes: 'GPU provider, recommended for compute workloads',
  },
}

export class ProviderSelector {
  private proxyProvider: string
  private proxyProviderName: string
  private knownProviders: Record<string, ProviderInfo>
  private blockedProviders: Record<string, { address: string; name: string; reason: string }>

  constructor(
    proxyProvider: string = PROXY_PROVIDER,
    proxyProviderName: string = PROXY_PROVIDER_NAME,
    knownProviders: Record<string, ProviderInfo> = KNOWN_PROVIDERS,
    blockedProviders: Record<string, { address: string; name: string; reason: string }> = BLOCKED_PROVIDERS
  ) {
    this.proxyProvider = proxyProvider
    this.proxyProviderName = proxyProviderName
    this.knownProviders = knownProviders
    this.blockedProviders = blockedProviders
  }

  /**
   * Get the current proxy provider address.
   */
  getProxyProvider(): string {
    return this.proxyProvider
  }

  /**
   * Get info about a provider if known.
   */
  getProviderInfo(address: string): ProviderInfo | undefined {
    return this.knownProviders[address]
  }

  /**
   * Get list of blocked providers for a given service type.
   *
   * @param serviceType - Type of service being deployed
   * @returns Array of provider addresses that should NOT be used
   */
  getBlockedProviders(serviceType: ServiceType): string[] {
    // Proxy can be on any provider - it doesn't route through itself
    if (serviceType === 'proxy') {
      return []
    }

    // Standalone services don't route through proxy
    if (serviceType === 'standalone') {
      return []
    }

    // Backend services must avoid proxy's provider (NAT hairpin)
    return [this.proxyProvider]
  }

  /**
   * Check if a provider is safe to use for a given service type.
   *
   * @param providerAddress - The provider to check
   * @param serviceType - Type of service being deployed
   * @returns Safety result with reason
   */
  isProviderSafe(
    providerAddress: string,
    serviceType: ServiceType
  ): ProviderSafetyResult {
    const providerInfo = this.knownProviders[providerAddress]
    const providerName = providerInfo?.name || 'Unknown'

    // Check global blocklist first (applies to ALL service types)
    const blockedInfo = this.blockedProviders[providerAddress]
    if (blockedInfo) {
      return {
        safe: false,
        provider: providerAddress,
        providerName: blockedInfo.name,
        reason: `BLOCKED PROVIDER: ${blockedInfo.name} - ${blockedInfo.reason}`,
        blockedProvider: providerAddress,
        blockedProviderName: blockedInfo.name,
      }
    }

    // Proxy can be on any provider (that's not globally blocked)
    if (serviceType === 'proxy') {
      return {
        safe: true,
        provider: providerAddress,
        providerName,
        reason: 'Proxy can be deployed on any provider with IP leases',
      }
    }

    // Standalone services don't route through proxy
    if (serviceType === 'standalone') {
      return {
        safe: true,
        provider: providerAddress,
        providerName,
        reason: 'Standalone services do not route through the proxy',
      }
    }

    // Backend services must avoid proxy's provider
    if (providerAddress === this.proxyProvider) {
      return {
        safe: false,
        provider: providerAddress,
        providerName,
        reason:
          `NAT HAIRPIN ISSUE: Provider ${this.proxyProviderName} (${providerAddress}) is hosting the SSL proxy. ` +
          `Services routed through the proxy cannot be deployed here - ` +
          `the proxy cannot reach its own provider's public ingress from within the provider's network.`,
        blockedProvider: this.proxyProvider,
        blockedProviderName: this.proxyProviderName,
      }
    }

    return {
      safe: true,
      provider: providerAddress,
      providerName,
      reason:
        'Provider is different from proxy provider - safe for backend services',
    }
  }

  /**
   * Filter a list of bids, marking unsafe ones.
   *
   * @param bids - Array of bids from Akash network
   * @param serviceType - Type of service being deployed
   * @returns Bids with safety information added
   */
  filterBids(bids: AkashBid[], serviceType: ServiceType): FilteredBid[] {
    return bids.map(bid => {
      const provider = bid.bidId.provider
      const safetyResult = this.isProviderSafe(provider, serviceType)
      const providerInfo = this.knownProviders[provider]

      return {
        ...bid,
        isSafe: safetyResult.safe,
        unsafeReason: safetyResult.safe ? undefined : safetyResult.reason,
        providerName: providerInfo?.name,
      }
    })
  }

  /**
   * Get only safe bids for a service type.
   *
   * @param bids - Array of bids from Akash network
   * @param serviceType - Type of service being deployed
   * @returns Only bids from safe providers
   */
  getSafeBids(bids: AkashBid[], serviceType: ServiceType): FilteredBid[] {
    return this.filterBids(bids, serviceType).filter(bid => bid.isSafe)
  }

  /**
   * Sort bids by price (lowest first) and safety (safe first).
   *
   * @param bids - Array of filtered bids
   * @returns Sorted bids
   */
  sortBidsByPriceAndSafety(bids: FilteredBid[]): FilteredBid[] {
    return [...bids].sort((a, b) => {
      // Safe bids first
      if (a.isSafe && !b.isSafe) return -1
      if (!a.isSafe && b.isSafe) return 1

      // Then by price (lowest first)
      const priceA = BigInt(a.price.amount)
      const priceB = BigInt(b.price.amount)
      if (priceA < priceB) return -1
      if (priceA > priceB) return 1

      return 0
    })
  }

  /**
   * Get the best (cheapest safe) provider from a list of bids.
   *
   * @param bids - Array of bids from Akash network
   * @param serviceType - Type of service being deployed
   * @returns Best provider address or null if none safe
   */
  getBestProvider(bids: AkashBid[], serviceType: ServiceType): string | null {
    const safeBids = this.getSafeBids(bids, serviceType)
    if (safeBids.length === 0) {
      return null
    }

    const sorted = this.sortBidsByPriceAndSafety(safeBids)
    return sorted[0].bidId.provider
  }

  /**
   * Generate provider guidance for documentation/UI.
   */
  generateProviderGuidance(serviceType: ServiceType): string {
    const blocked = this.getBlockedProviders(serviceType)

    const lines: string[] = [
      `## Provider Selection for ${serviceType} Services`,
      '',
    ]

    if (blocked.length > 0) {
      lines.push('### Blocked Providers (DO NOT USE)')
      lines.push('')
      for (const addr of blocked) {
        const info = this.knownProviders[addr]
        lines.push(`- **${info?.name || 'Unknown'}** (\`${addr}\`)`)
        lines.push(
          `  - Reason: Currently hosting SSL proxy - NAT hairpin issue`
        )
      }
      lines.push('')
    }

    lines.push('### Recommended Providers')
    lines.push('')
    for (const [addr, info] of Object.entries(this.knownProviders)) {
      if (!blocked.includes(addr)) {
        lines.push(`- **${info.name}** (\`${addr}\`)`)
        if (info.notes) {
          lines.push(`  - ${info.notes}`)
        }
      }
    }

    return lines.join('\n')
  }
}

// Default singleton instance
export const providerSelector = new ProviderSelector()

// Export constants for external use
export { PROXY_PROVIDER, PROXY_PROVIDER_NAME, KNOWN_PROVIDERS }
