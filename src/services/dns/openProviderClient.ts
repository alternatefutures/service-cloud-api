/**
 * OpenProvider DNS API Client
 * Handles authentication and DNS record operations
 *
 * API Docs: https://doc.openprovider.com/
 */

/* global fetch */
import type { DNSRecord, OpenProviderConfig, DNSUpdateResult } from './types.js'

export class OpenProviderClient {
  private config: OpenProviderConfig
  private authToken: string | null = null
  private tokenExpiry: Date | null = null
  private readonly apiUrl: string

  constructor(config: OpenProviderConfig) {
    this.config = config
    this.apiUrl = config.apiUrl || 'https://api.openprovider.eu'
  }

  /**
   * Authenticate with OpenProvider API
   */
  async authenticate(): Promise<void> {
    // Check if token is still valid
    if (this.authToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return
    }

    const response = await fetch(`${this.apiUrl}/v1beta/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: this.config.username,
        password: this.config.password,
      }),
    })

    if (!response.ok) {
      throw new Error(`OpenProvider auth failed: ${response.statusText}`)
    }

    const data = await response.json()
    this.authToken = data.data.token
    // Token expires in 24 hours, set expiry to 23 hours from now
    this.tokenExpiry = new Date(Date.now() + 23 * 60 * 60 * 1000)
  }

  /**
   * Make authenticated API request
   */
  private async request<T>(
    endpoint: string,
    method: string = 'GET',
    body?: unknown
  ): Promise<T> {
    await this.authenticate()

    const response = await fetch(`${this.apiUrl}${endpoint}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new Error(
        `OpenProvider API error: ${response.statusText} - ${error}`
      )
    }

    return response.json()
  }

  /**
   * Create a DNS zone
   */
  async createDNSZone(
    domain: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const parts = domain.split('.')
      const extension = parts.pop()
      const name = parts.join('.')

      await this.request('/v1beta/dns/zones', 'POST', {
        domain: {
          extension,
          name,
        },
        type: 'master',
      })

      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Get all DNS records for a domain
   */
  async listDNSRecords(domain: string): Promise<DNSRecord[]> {
    const data = await this.request<{
      data: { results: DNSRecord[] }
    }>(`/v1beta/dns/zones/${domain}/records`)

    return data.data.results
  }

  /**
   * Create a new DNS record
   */
  async createDNSRecord(
    domain: string,
    record: Omit<DNSRecord, 'id'>
  ): Promise<DNSUpdateResult> {
    try {
      const data = await this.request<{
        data: DNSRecord
      }>(`/v1beta/dns/zones/${domain}/records`, 'POST', record)

      return {
        success: true,
        recordId: data.data.id,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Update an existing DNS record
   */
  async updateDNSRecord(
    domain: string,
    recordId: string,
    record: Partial<DNSRecord>
  ): Promise<DNSUpdateResult> {
    try {
      await this.request(
        `/v1beta/dns/zones/${domain}/records/${recordId}`,
        'PUT',
        record
      )

      return {
        success: true,
        recordId,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Delete a DNS record
   */
  async deleteDNSRecord(
    domain: string,
    recordId: string
  ): Promise<DNSUpdateResult> {
    try {
      await this.request(
        `/v1beta/dns/zones/${domain}/records/${recordId}`,
        'DELETE'
      )

      return {
        success: true,
        recordId,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Find DNS record by name and type
   */
  async findDNSRecord(
    domain: string,
    name: string,
    type: DNSRecord['type']
  ): Promise<DNSRecord | null> {
    const records = await this.listDNSRecords(domain)
    return records.find(r => r.name === name && r.type === type) || null
  }
}
