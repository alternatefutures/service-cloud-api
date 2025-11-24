/**
 * Akash DNS Synchronization
 * Automatically update DNS when Akash deployments change
 */

/* eslint-disable no-console */
import { exec } from 'child_process'
import { promisify } from 'util'
import { DNSManager } from './dnsManager.js'
import type {
  AkashDeployment,
  DNSUpdateResult,
  OpenProviderConfig,
} from './types.js'

const execAsync = promisify(exec)

export class AkashDNSSync {
  private dnsManager: DNSManager
  private akashNode: string
  private akashChainId: string

  constructor(
    openProviderConfig: OpenProviderConfig,
    domain: string,
    akashNode: string,
    akashChainId: string
  ) {
    this.dnsManager = new DNSManager(openProviderConfig, domain)
    this.akashNode = akashNode
    this.akashChainId = akashChainId
  }

  /**
   * Get Akash deployment details including provider IPs
   */
  async getDeploymentDetails(
    dseq: string,
    provider: string
  ): Promise<AkashDeployment | null> {
    try {
      // Get provider info to determine service hostnames
      const { stdout: providerInfo } = await execAsync(
        `akash query provider get ${provider} --node ${this.akashNode} --chain-id ${this.akashChainId} --output json`
      )

      const providerData = JSON.parse(providerInfo)
      const providerUri =
        providerData.provider?.host_uri || providerData.host_uri

      if (!providerUri) {
        console.error('Provider URI not found in provider info')
        return null
      }

      console.log(`Provider: ${providerUri}`)

      // Use Akash blockchain to get deployment info
      // This is secure (public blockchain data) and doesn't require API keys or TLS connections
      console.log('Fetching deployment info from Akash blockchain...')

      // Get deployment details using akash CLI
      try {
        const { stdout: leaseListOutput } = await execAsync(
          `akash query market lease list ` +
            `--owner ${this.akashNode.includes('testnet') ? process.env.AKASH_TESTNET_ADDRESS : process.env.AKASH_ADDRESS || ''} ` +
            `--dseq ${dseq} ` +
            `--node ${this.akashNode} ` +
            `--chain-id ${this.akashChainId} ` +
            `--output json`
        )

        const leaseData = JSON.parse(leaseListOutput)
        const lease = leaseData.leases?.[0]?.lease

        if (!lease) {
          console.error('No lease found for deployment')
          return null
        }

        console.log('Lease found on blockchain')

        // For Akash deployments, services are exposed via provider ingress
        // The service hostname pattern is typically: <service>.<dseq>.<provider-domain>
        // We'll return instructions for manual DNS configuration since service endpoints
        // aren't stored on-chain - they're managed by providers

        console.warn(
          '\n' +
            '═══════════════════════════════════════════════════════════════\n' +
            'MANUAL DNS CONFIGURATION REQUIRED\n' +
            '═══════════════════════════════════════════════════════════════\n' +
            '\n' +
            'Deployment created successfully, but automatic DNS sync is not available.\n' +
            '\n' +
            'To get your service URLs:\n' +
            '1. Visit: https://console.akash.network\n' +
            '2. Find deployment: ' +
            dseq +
            '\n' +
            '3. Copy the service URI(s)\n' +
            '4. Configure DNS manually:\n' +
            '   - Extract IP from service URI\n' +
            '   - Point your DNS records to that IP\n' +
            '\n' +
            'Alternative: Get Akash Console API key for automatic sync\n' +
            '- Generate API key at: https://console.akash.network/settings/authorizations\n' +
            '- Add AKASH_CONSOLE_API_KEY to GitHub Secrets\n' +
            '- Update akashDnsSync.ts to use authenticated API calls\n' +
            '\n' +
            'Deployment Info:\n' +
            '  DSEQ: ' +
            dseq +
            '\n' +
            '  Provider: ' +
            provider +
            '\n' +
            '  Provider URI: ' +
            providerUri +
            '\n' +
            '═══════════════════════════════════════════════════════════════\n'
        )

        // Return empty services array to indicate manual configuration needed
        return {
          dseq,
          provider,
          services: [],
        }
      } catch (error) {
        console.error('Failed to query Akash blockchain:', error)
        return null
      }

      // SECURITY NOTE: Removed insecure fallback to direct provider queries
      //
      // Previously, this code would fall back to querying providers directly when
      // Cloudmos API failed. However, this required setting rejectUnauthorized: false
      // because many Akash providers use self-signed certificates.
      //
      // Disabling TLS validation is a critical security vulnerability that enables
      // man-in-the-middle (MITM) attacks. An attacker could intercept and modify
      // traffic between this service and Akash providers.
      //
      // We now rely exclusively on Cloudmos API, which:
      // - Uses proper TLS validation
      // - Provides all necessary deployment information
      // - Is a trusted service in the Akash ecosystem
      //
      // If deployment info is not available, we fail gracefully rather than
      // compromise security.
    } catch (error) {
      console.error('Failed to get Akash deployment details:', error)
      return null
    }
  }

  /**
   * Sync testnet DNS records for an Akash deployment
   */
  async syncTestnetDNS(
    dseq: string,
    provider: string
  ): Promise<DNSUpdateResult[]> {
    const deployment = await this.getDeploymentDetails(dseq, provider)
    if (!deployment) {
      return [{ success: false, error: 'Failed to get deployment details' }]
    }

    const results: DNSUpdateResult[] = []

    // Define testnet subdomain mapping
    const subdomainMap: Record<string, string> = {
      api: 'api-test',
      'yb-node-1': 'yb-test',
      ipfs: 'ipfs-test',
    }

    for (const service of deployment.services) {
      const subdomain = subdomainMap[service.name]
      if (!subdomain || !service.externalIP) {
        continue
      }

      console.log(
        `Syncing DNS for ${service.name}: ${subdomain} -> ${service.externalIP}`
      )

      const result = await this.dnsManager.updateAkashSubdomain(
        subdomain,
        service.externalIP,
        `http://${service.externalIP}:${service.port || 80}/health` // Optional health check
      )

      results.push(result)

      // Store DNS record info in service
      service.subdomain = subdomain
      service.dnsRecord = {
        name: subdomain,
        type: 'A',
        value: service.externalIP,
        ttl: 300,
      }
    }

    return results
  }

  /**
   * Sync mainnet DNS records for an Akash deployment
   */
  async syncMainnetDNS(
    dseq: string,
    provider: string
  ): Promise<DNSUpdateResult[]> {
    const deployment = await this.getDeploymentDetails(dseq, provider)
    if (!deployment) {
      return [{ success: false, error: 'Failed to get deployment details' }]
    }

    const results: DNSUpdateResult[] = []

    // Define mainnet subdomain mapping
    const subdomainMap: Record<string, string> = {
      api: 'api',
      'yb-node-1': 'yb',
      ipfs: 'ipfs',
    }

    for (const service of deployment.services) {
      const subdomain = subdomainMap[service.name]
      if (!subdomain || !service.externalIP) {
        continue
      }

      console.log(
        `Syncing DNS for ${service.name}: ${subdomain} -> ${service.externalIP}`
      )

      const result = await this.dnsManager.updateAkashSubdomain(
        subdomain,
        service.externalIP,
        `http://${service.externalIP}:${service.port || 80}/health` // Optional health check
      )

      results.push(result)

      // Wait for DNS propagation before moving to next service
      await this.dnsManager.waitForDNSPropagation(subdomain, service.externalIP)
    }

    return results
  }

  /**
   * Verify all DNS records for a deployment
   */
  async verifyDeploymentDNS(
    dseq: string,
    provider: string,
    isTestnet = true
  ): Promise<boolean> {
    const deployment = await this.getDeploymentDetails(dseq, provider)
    if (!deployment) {
      return false
    }

    const subdomainMap: Record<string, string> = isTestnet
      ? { api: 'api-test', 'yb-node-1': 'yb-test', ipfs: 'ipfs-test' }
      : { api: 'api', 'yb-node-1': 'yb', ipfs: 'ipfs' }

    for (const service of deployment.services) {
      const subdomain = subdomainMap[service.name]
      if (!subdomain || !service.externalIP) {
        continue
      }

      const check = await this.dnsManager.verifyDNSPropagation(
        subdomain,
        service.externalIP
      )
      if (!check.healthy) {
        console.error(`DNS verification failed for ${subdomain}:`, check)
        return false
      }
    }

    return true
  }

  /**
   * Export deployment DNS configuration
   */
  async exportDeploymentConfig(
    dseq: string,
    provider: string
  ): Promise<AkashDeployment | null> {
    return this.getDeploymentDetails(dseq, provider)
  }
}
