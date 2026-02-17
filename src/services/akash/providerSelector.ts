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
 * Backend services must avoid deploying on the same provider as the SSL proxy
 * to prevent NAT hairpin issues.
 *
 * Configure via env in production:
 * - `AKASH_SSL_PROXY_PROVIDER`
 * - `AKASH_SSL_PROXY_PROVIDER_NAME`
 *
 * Source of truth for the current proxy provider:
 * - repo root `DEPLOYMENTS.md`
 */
const PROXY_PROVIDER = process.env.AKASH_SSL_PROXY_PROVIDER || 'akash1zlsep362zz46qlwzttm06t8lv9qtg8gtaya97u'
const PROXY_PROVIDER_NAME = process.env.AKASH_SSL_PROXY_PROVIDER_NAME || 'america.computer'

/**
 * Providers with known issues that should be blocked for all deployments.
 * 
 * History:
 * - 2026-02-05: Added airitdecomp - wildcard DNS not configured for ingress
 * - 2026-02-17: Added akash1chnhn... - consistently fails manifest submission
 */
const BLOCKED_PROVIDERS: Record<string, { address: string; name: string; reason: string }> = {
  akash1adyrcsp2ptwd83txgv555eqc0vhfufc37wx040: {
    address: 'akash1adyrcsp2ptwd83txgv555eqc0vhfufc37wx040',
    name: 'AiritDecomp',
    reason: 'Wildcard DNS not configured - ingress URLs do not resolve',
  },
  akash1chnhnu50f6hv98xl0m7xm95vel457ysp32uwpj: {
    address: 'akash1chnhnu50f6hv98xl0m7xm95vel457ysp32uwpj',
    name: 'Unknown (chnhnu...)',
    reason: 'Consistently fails to accept manifest submissions (send-manifest error)',
  },
  akash1swxj75e8tz2nuepnqdas787h3eqfmhyh8lak8g: {
    address: 'akash1swxj75e8tz2nuepnqdas787h3eqfmhyh8lak8g',
    name: 'DataNode UK',
    reason: 'Extremely slow ingress setup - URIs not available for 5+ minutes after deployment',
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
    lastChecked: new Date('2026-01-30'),
    notes: 'Previously hosted SSL proxy, now available for services',
  },
  akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z: {
    address: 'akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z',
    name: 'DigitalFrontier',
    hasIpLeases: true,
    ipLeaseStatus: 'available',
    lastChecked: new Date('2026-01-30'),
    notes: 'Previously hosted SSL proxy - avoid if proxy is deployed here (see env config)',
  },
  akash1zlsep362zz46qlwzttm06t8lv9qtg8gtaya97u: {
    address: 'akash1zlsep362zz46qlwzttm06t8lv9qtg8gtaya97u',
    name: 'america.computer',
    hasIpLeases: true,
    ipLeaseStatus: 'available',
    lastChecked: new Date('2026-02-07'),
    notes: 'Hosts SSL proxy in current production (see repo-root deployment tracker)',
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
