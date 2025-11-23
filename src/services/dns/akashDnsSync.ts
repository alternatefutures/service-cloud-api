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
      // Step 1: Get provider info to find the host URI
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

      console.log(`Querying provider at ${providerUri}`)

      // Step 2: Query provider's REST API for lease status
      // Default gseq and oseq are 1 for most deployments
      const leaseStatusUrl = `${providerUri}/lease/${dseq}/1/1/status`

      // Use global fetch (Node 18+)
      const response = await globalThis.fetch(leaseStatusUrl)
      if (!response.ok) {
        throw new Error(
          `Provider API returned ${response.status}: ${response.statusText}`
        )
      }

      const data = (await response.json()) as {
        forwarded_ports?: Record<string, Array<{ host: string; port: number }>>
        services?: Record<string, { uris?: string[] }>
      }
      const services: AkashService[] = []

      // Parse forwarded ports and extract service info
      if (data.forwarded_ports) {
        for (const [serviceName, ports] of Object.entries(
          data.forwarded_ports
        )) {
          const portInfo = ports as { host: string; port: number }[]
          if (portInfo.length > 0) {
            services.push({
              name: serviceName,
              externalIP: portInfo[0].host,
              port: portInfo[0].port,
              subdomain: '', // Will be set based on service name
            })
          }
        }
      }

      // Also check for services array if forwarded_ports is not present
      if (services.length === 0 && data.services) {
        for (const [serviceName, serviceData] of Object.entries(
          data.services
        )) {
          if (serviceData.uris && serviceData.uris.length > 0) {
            // Extract IP and port from URI
            const uri = serviceData.uris[0]
            const match = uri.match(/^(?:https?:\/\/)?([^:/]+):?(\d+)?/)
            if (match) {
              services.push({
                name: serviceName,
                externalIP: match[1],
                port: match[2] ? parseInt(match[2]) : 80,
                subdomain: '', // Will be set based on service name
              })
            }
          }
        }
      }

      return {
        dseq,
        provider,
        services,
      }
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
