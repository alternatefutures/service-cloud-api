/**
 * Billing API Client
 *
 * HTTP client for service-cloud-api → service-auth internal billing API.
 * Protected by x-af-introspection-secret header.
 *
 * This client is the bridge between deployment operations (cloud-api)
 * and the wallet/balance system (auth service).
 */

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:1601'
const INTROSPECTION_SECRET = process.env.AUTH_INTROSPECTION_SECRET || ''

interface DebitResult {
  success: boolean
  balanceCents: number
  alreadyProcessed?: boolean
}

interface CreditResult {
  success: boolean
  balanceCents: number
  alreadyProcessed?: boolean
}

interface OrgBalance {
  orgBillingId: string
  balanceCents: number
  balanceUsd: string
}

interface OrgMarkup {
  orgBillingId: string
  marginRate: number
  marginPercent: number
}

interface OrgBillingInfo {
  orgBillingId: string
  organizationId: string
  stripeCustomerId?: string
  trialEndsAt?: string
  trialConverted?: boolean
}

class BillingApiClient {
  private baseUrl: string
  private secret: string

  constructor() {
    this.baseUrl = `${AUTH_SERVICE_URL}/billing/internal`
    this.secret = INTROSPECTION_SECRET
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`

    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'x-af-introspection-secret': this.secret,
        ...options.headers,
      },
    })

    const body = await response.json() as T & { error?: string }

    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`)
      ;(error as any).statusCode = response.status
      ;(error as any).body = body
      throw error
    }

    return body
  }

  // ========================================
  // ESCROW OPERATIONS
  // ========================================

  /**
   * Debit org wallet for Akash escrow deposit
   * Returns the new balance or throws on insufficient balance
   */
  async escrowDeposit(args: {
    orgBillingId: string
    organizationId: string
    userId: string
    amountCents: number
    deploymentId: string
    description?: string
  }): Promise<DebitResult> {
    return this.request<DebitResult>('/escrow-deposit', {
      method: 'POST',
      body: JSON.stringify(args),
    })
  }

  /**
   * Credit org wallet for Akash escrow refund (deployment closed)
   */
  async escrowRefund(args: {
    orgBillingId: string
    amountCents: number
    deploymentId: string
    description?: string
  }): Promise<CreditResult> {
    return this.request<CreditResult>('/escrow-refund', {
      method: 'POST',
      body: JSON.stringify(args),
    })
  }

  // ========================================
  // COMPUTE DEBIT (Daily billing)
  // ========================================

  /**
   * Debit org wallet for compute usage (daily billing)
   */
  async computeDebit(args: {
    orgBillingId: string
    amountCents: number
    serviceType: string
    provider: string
    resource: string
    description?: string
    idempotencyKey: string
    metadata?: Record<string, unknown>
  }): Promise<DebitResult> {
    return this.request<DebitResult>('/compute-debit', {
      method: 'POST',
      body: JSON.stringify(args),
    })
  }

  // ========================================
  // BALANCE & MARKUP QUERIES
  // ========================================

  /**
   * Get org wallet balance
   */
  async getOrgBalance(orgBillingId: string): Promise<OrgBalance> {
    return this.request<OrgBalance>(`/org-balance/${orgBillingId}`)
  }

  /**
   * Get org plan markup rate
   */
  async getOrgMarkup(orgBillingId: string): Promise<OrgMarkup> {
    return this.request<OrgMarkup>(`/org-markup/${orgBillingId}`)
  }

  /**
   * Resolve orgId to OrgBilling record
   */
  async getOrgBilling(orgId: string): Promise<OrgBillingInfo> {
    return this.request<OrgBillingInfo>(`/org-billing/${orgId}`)
  }

  // ========================================
  // NOTIFICATIONS
  // ========================================

  /**
   * Send billing notification email
   */
  async notify(args: {
    orgId: string
    type: 'low_balance_pause' | 'low_balance_warning' | 'escrow_depleted'
    email: string
    orgName?: string
    balanceCents?: number
    dailyCostCents?: number
    pausedServices?: string[]
  }): Promise<{ success: boolean; type: string }> {
    return this.request<{ success: boolean; type: string }>('/notify', {
      method: 'POST',
      body: JSON.stringify(args),
    })
  }
}

// Singleton
let instance: BillingApiClient | null = null

export function getBillingApiClient(): BillingApiClient {
  if (!instance) {
    instance = new BillingApiClient()
  }
  return instance
}

export { BillingApiClient }
export type { DebitResult, CreditResult, OrgBalance, OrgMarkup, OrgBillingInfo }
