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
  AkashService,
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

      // Query Cloudmos API for deployment info (secure, no direct provider connection)
      console.log('Fetching deployment info from Cloudmos API...')
      try {
        const cloudmosResponse = await globalThis.fetch(
          `https://api.cloudmos.io/v1/deployments/${dseq}`
        )

        if (cloudmosResponse.ok) {
          const cloudmosData = (await cloudmosResponse.json()) as {
            services?: Array<{ name: string; uris?: string[] }>
          }
          console.log('Got deployment info from Cloudmos')

          // Extract service URIs from Cloudmos data
          const services: AkashService[] = []
          if (cloudmosData.services) {
            for (const service of cloudmosData.services) {
              if (service.uris && service.uris.length > 0) {
                const uri = service.uris[0]
                const match = uri.match(/^(?:https?:\/\/)?([^:/]+):?(\d+)?/)
                if (match) {
                  services.push({
                    name: service.name,
                    externalIP: match[1],
                    port: match[2] ? parseInt(match[2]) : 80,
                    subdomain: '',
                  })
                }
              }
            }
          }

          if (services.length > 0) {
            return { dseq, provider, services }
          }

          // Deployment found but no services available yet
          console.warn(
            `Deployment ${dseq} found but no service URIs available yet. ` +
              'This is normal for new deployments - they may take a few minutes to appear in Cloudmos.'
          )
          return null
        }

        // API returned non-OK status
        console.error(
          `Cloudmos API returned ${cloudmosResponse.status}: ${cloudmosResponse.statusText}`
        )
        return null
      } catch (error) {
        console.error('Failed to fetch from Cloudmos API:', error)
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
