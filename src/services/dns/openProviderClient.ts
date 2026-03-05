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
   * Made public to allow advanced zone operations
   */
  async request<T>(
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
   * List all DNS zones in the OpenProvider account
   */
  async listDNSZones(): Promise<
    Array<{ name: string; active: boolean; createdAt?: string }>
  > {
    const data = await this.request<{
      data: {
        results: Array<{
          name: { name: string; extension: string }
          active: boolean
          creation_date?: string
        }>
        total: number
      }
    }>('/v1beta/dns/zones?limit=500')

    return data.data.results.map((zone) => ({
      name: `${zone.name.name}.${zone.name.extension}`,
      active: zone.active,
      createdAt: zone.creation_date,
    }))
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
   * Note: Openprovider uses PUT to modify zones, not POST to create individual records
   */
  async createDNSRecord(
    domain: string,
    record: Omit<DNSRecord, 'id'>
  ): Promise<DNSUpdateResult> {
    try {
      // First, get the zone to get its ID
      const zone = await this.request<{
        data: { id: number; name: { extension: string; name: string } }
      }>(`/v1beta/dns/zones/${domain}`)

      // Use PUT to modify the zone and add the record
      await this.request(`/v1beta/dns/zones/${domain}`, 'PUT', {
        id: zone.data.id,
        name: zone.data.name,
        records: {
          add: [record],
        },
      })

      return {
        success: true,
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

  // ── Domain Registration ──────────────────────────────────────────

  /**
   * Check availability and optionally pricing for one or more domains.
   * Returns status "free" (available) or "active" (taken), plus pricing when requested.
   */
  async checkDomainAvailability(
    domains: Array<{ name: string; extension: string }>,
    withPrice = true
  ): Promise<DomainCheckResult[]> {
    const data = await this.request<{
      data: {
        results: Array<{
          domain: string
          status: string
          reason: string
          is_premium: boolean
          premium?: { currency: string; price: { create: number } }
          price?: {
            product: { currency: string; price: number }
            reseller: { currency: string; price: number }
          }
        }>
      }
    }>('/v1beta/domains/check', 'POST', {
      domains,
      with_price: withPrice,
    })

    return data.data.results.map((r) => ({
      domain: r.domain,
      available: r.status === 'free',
      status: r.status,
      reason: r.reason ?? '',
      isPremium: r.is_premium ?? false,
      price: r.price?.reseller
        ? {
            currency: r.price.reseller.currency,
            registrationPrice: r.price.reseller.price,
          }
        : undefined,
      premiumPrice: r.is_premium && r.premium
        ? {
            currency: r.premium.currency,
            registrationPrice: r.premium.price.create,
          }
        : undefined,
    }))
  }

  /**
   * Get pricing for a domain (registration, renewal, transfer).
   */
  async getDomainPrice(
    name: string,
    extension: string,
    operation: 'create' | 'renew' | 'transfer' = 'create',
    period = 1
  ): Promise<DomainPriceResult> {
    const data = await this.request<{
      data: {
        is_premium: boolean
        is_promotion: boolean
        price: {
          product: { currency: string; price: number }
          reseller: { currency: string; price: number }
        }
        promotion_data?: { start_date: string; end_date: string }
      }
    }>(
      `/v1beta/domains/prices?domain.name=${encodeURIComponent(name)}&domain.extension=${encodeURIComponent(extension)}&operation=${operation}&period=${period}`
    )

    return {
      currency: data.data.price.reseller.currency,
      price: data.data.price.reseller.price,
      isPremium: data.data.is_premium,
      isPromotion: data.data.is_promotion,
      period,
    }
  }

  /**
   * Register (purchase) a domain. Requires owner_handle to be set up in OpenProvider.
   * Auto-configures our nameservers and enables WHOIS privacy.
   */
  async registerDomain(opts: {
    name: string
    extension: string
    period?: number
    ownerHandle: string
    adminHandle?: string
    techHandle?: string
    billingHandle?: string
    nameservers?: Array<{ name: string; ip?: string }>
    autorenew?: 'on' | 'off' | 'default'
    enableWhoisPrivacy?: boolean
    acceptPremiumFee?: number
  }): Promise<DomainRegistrationResult> {
    try {
      const body: Record<string, unknown> = {
        domain: { name: opts.name, extension: opts.extension },
        period: opts.period ?? 1,
        unit: 'y',
        owner_handle: opts.ownerHandle,
        admin_handle: opts.adminHandle ?? opts.ownerHandle,
        tech_handle: opts.techHandle ?? opts.ownerHandle,
        billing_handle: opts.billingHandle ?? opts.ownerHandle,
        autorenew: opts.autorenew ?? 'default',
        is_private_whois_enabled: opts.enableWhoisPrivacy ?? true,
      }

      if (opts.nameservers?.length) {
        body.name_servers = opts.nameservers.map((ns, i) => ({
          name: ns.name,
          ...(ns.ip ? { ip: ns.ip } : {}),
          seq_nr: i + 1,
        }))
      }

      if (opts.acceptPremiumFee) {
        body.accept_premium_fee = opts.acceptPremiumFee
      }

      const data = await this.request<{
        data: { id: number; status: string }
      }>('/v1beta/domains', 'POST', body)

      return {
        success: true,
        domainId: data.data.id,
        status: data.data.status,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * List domains registered through our OpenProvider reseller account.
   */
  async listRegisteredDomains(opts?: {
    limit?: number
    offset?: number
    status?: string
    extension?: string
  }): Promise<{
    domains: RegisteredDomain[]
    total: number
  }> {
    const params = new URLSearchParams()
    if (opts?.limit) params.set('limit', String(opts.limit))
    if (opts?.offset) params.set('offset', String(opts.offset))
    if (opts?.status) params.set('status', opts.status)
    if (opts?.extension) params.set('extension', opts.extension)

    const qs = params.toString()
    const data = await this.request<{
      data: {
        results: Array<{
          id: number
          domain: { name: string; extension: string }
          status: string
          expiration_date: string
          renewal_date: string
          autorenew: string
          is_private_whois_enabled: boolean
          creation_date?: string
        }>
        total: number
      }
    }>(`/v1beta/domains${qs ? `?${qs}` : ''}`)

    return {
      domains: data.data.results.map((d) => ({
        id: d.id,
        fullName: `${d.domain.name}.${d.domain.extension}`,
        name: d.domain.name,
        extension: d.domain.extension,
        status: d.status,
        expirationDate: d.expiration_date,
        renewalDate: d.renewal_date,
        autorenew: d.autorenew,
        whoisPrivacy: d.is_private_whois_enabled,
        createdAt: d.creation_date,
      })),
      total: data.data.total,
    }
  }

  /**
   * Renew an existing domain registration.
   */
  async renewDomain(
    domainId: number,
    period = 1
  ): Promise<{ success: boolean; error?: string }> {
    try {
      await this.request(`/v1beta/domains/${domainId}/renew`, 'POST', {
        period,
      })
      return { success: true }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }
}

// ── Types ────────────────────────────────────────────────────────────

export interface DomainCheckResult {
  domain: string
  available: boolean
  status: string
  reason: string
  isPremium: boolean
  price?: { currency: string; registrationPrice: number }
  premiumPrice?: { currency: string; registrationPrice: number }
}

export interface DomainPriceResult {
  currency: string
  price: number
  isPremium: boolean
  isPromotion: boolean
  period: number
}

export interface DomainRegistrationResult {
  success: boolean
  domainId?: number
  status?: string
  error?: string
}

export interface RegisteredDomain {
  id: number
  fullName: string
  name: string
  extension: string
  status: string
  expirationDate: string
  renewalDate: string
  autorenew: string
  whoisPrivacy: boolean
  createdAt?: string
}
