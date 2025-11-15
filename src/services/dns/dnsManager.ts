/**
 * DNS Manager
 * High-level DNS operations for Akash deployments
 */

/* eslint-disable no-console */
/* global fetch, setTimeout */
import { OpenProviderClient } from './openProviderClient.js'
import type {
  DNSRecord,
  DNSUpdateResult,
  DNSHealthCheck,
  OpenProviderConfig,
} from './types.js'

export class DNSManager {
  private client: OpenProviderClient
  private domain: string
  private defaultTTL: number

  constructor(config: OpenProviderConfig, domain: string, defaultTTL = 300) {
    this.client = new OpenProviderClient(config)
    this.domain = domain
    this.defaultTTL = defaultTTL
  }

  /**
   * Ensure a subdomain exists and points to the correct IP
   * Creates if it doesn't exist, updates if it does
   */
  async ensureSubdomain(
    subdomain: string,
    ip: string,
    ttl?: number
  ): Promise<DNSUpdateResult> {
    const existing = await this.client.findDNSRecord(
      this.domain,
      subdomain,
      'A'
    )

    if (existing) {
      if (!existing.id) {
        return {
          success: false,
          error: 'Existing DNS record has no ID',
        }
      }
      // Update existing record
      if (existing.value !== ip) {
        console.log(`Updating DNS: ${subdomain}.${this.domain} -> ${ip}`)
        return this.client.updateDNSRecord(this.domain, existing.id, {
          value: ip,
          ttl: ttl || this.defaultTTL,
        })
      } else {
        console.log(`DNS already correct: ${subdomain}.${this.domain} -> ${ip}`)
        return {
          success: true,
          recordId: existing.id,
        }
      }
    } else {
      // Create new record
      console.log(`Creating DNS: ${subdomain}.${this.domain} -> ${ip}`)
      return this.client.createDNSRecord(this.domain, {
        name: subdomain,
        type: 'A',
        value: ip,
        ttl: ttl || this.defaultTTL,
      })
    }
  }

  /**
   * Update Akash subdomain with health check before switching
   */
  async updateAkashSubdomain(
    subdomain: string,
    newIP: string,
    healthCheckUrl?: string
  ): Promise<DNSUpdateResult> {
    // Optional: Health check before DNS update
    if (healthCheckUrl) {
      const healthy = await this.healthCheck(healthCheckUrl)
      if (!healthy) {
        return {
          success: false,
          error: 'Health check failed, refusing to update DNS',
        }
      }
    }

    return this.ensureSubdomain(subdomain, newIP)
  }

  /**
   * Rollback DNS to previous IP
   */
  async rollbackDNS(
    subdomain: string,
    previousIP: string
  ): Promise<DNSUpdateResult> {
    console.log(
      `Rolling back DNS: ${subdomain}.${this.domain} -> ${previousIP}`
    )
    return this.ensureSubdomain(subdomain, previousIP)
  }

  /**
   * Health check a URL
   */
  private async healthCheck(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { method: 'GET' })
      return response.ok
    } catch (error) {
      console.error(`Health check failed for ${url}:`, error)
      return false
    }
  }

  /**
   * Verify DNS propagation by checking current resolution
   */
  async verifyDNSPropagation(
    subdomain: string,
    expectedIP: string
  ): Promise<DNSHealthCheck> {
    const fqdn = `${subdomain}.${this.domain}`

    try {
      // Use a public DNS-over-HTTPS service to check resolution
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${fqdn}&type=A`,
        {
          headers: {
            Accept: 'application/dns-json',
          },
        }
      )

      const data = await response.json()
      const currentIP = data.Answer?.[0]?.data

      return {
        subdomain: fqdn,
        expectedIP,
        currentIP,
        healthy: currentIP === expectedIP,
        checkedAt: new Date(),
      }
    } catch (error) {
      console.error(`DNS verification failed for ${fqdn}:`, error)
      return {
        subdomain: fqdn,
        expectedIP,
        healthy: false,
        checkedAt: new Date(),
      }
    }
  }

  /**
   * Wait for DNS propagation with timeout
   */
  async waitForDNSPropagation(
    subdomain: string,
    expectedIP: string,
    timeoutMs = 300000 // 5 minutes
  ): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime < timeoutMs) {
      const check = await this.verifyDNSPropagation(subdomain, expectedIP)
      if (check.healthy) {
        console.log(
          `DNS propagated successfully for ${subdomain}: ${expectedIP}`
        )
        return true
      }

      // Wait 10 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 10000))
    }

    console.error(`DNS propagation timeout for ${subdomain}`)
    return false
  }

  /**
   * List all DNS records for the domain
   */
  async listRecords(): Promise<DNSRecord[]> {
    return this.client.listDNSRecords(this.domain)
  }

  /**
   * Delete a subdomain
   */
  async deleteSubdomain(subdomain: string): Promise<DNSUpdateResult> {
    const existing = await this.client.findDNSRecord(
      this.domain,
      subdomain,
      'A'
    )

    if (!existing) {
      return {
        success: false,
        error: 'DNS record not found',
      }
    }

    if (!existing.id) {
      return {
        success: false,
        error: 'DNS record has no ID',
      }
    }

    return this.client.deleteDNSRecord(this.domain, existing.id)
  }
}
