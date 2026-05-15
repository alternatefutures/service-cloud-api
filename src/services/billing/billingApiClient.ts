/**
 * Billing API Client
 *
 * HTTP client for service-cloud-api → service-auth internal billing API.
 * Protected by x-af-introspection-secret header.
 *
 * This client is the bridge between deployment operations (cloud-api)
 * and the wallet/balance system (auth service).
 *
 * Every outbound request forwards the current trace id via
 * `X-AF-Trace-Id` so events on both sides of this call (debit in auth,
 * deploy in cloud-api) share one trace id in the audit log.
 */

import { currentTraceId } from '../../lib/audit.js'

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

interface UsageLogResult {
  success: boolean
  usageId: string
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
        'x-af-trace-id': currentTraceId(),
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

  /**
   * Record a normalized usage event when billing happened outside computeDebit
   * (e.g. Akash escrow accrual/final settlement).
   */
  async usageLog(args: {
    orgBillingId: string
    userId?: string
    serviceType: string
    provider: string
    resource: string
    model?: string
    usdCostRaw: number
    marginRate: number
    usdCharged: number
    requestId: string
    metadata?: Record<string, unknown>
  }): Promise<UsageLogResult> {
    return this.request<UsageLogResult>('/usage-log', {
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
  // MONTHLY SPEND
  // ========================================

  /**
   * Get total DEBIT spend for the current month from auth ledger
   */
  async getOrgMonthlySpend(orgId: string): Promise<{ orgId: string; currentMonthCents: number }> {
    return this.request(`/org-monthly-spend/${orgId}`)
  }

  // ========================================
  // SUBSCRIPTION STATUS
  // ========================================

  /**
   * Check org subscription status (for pre-deploy gating)
   */
  async getSubscriptionStatus(orgId: string): Promise<{
    status: string
    trialEnd: number | null
    daysRemaining: number | null
    graceRemaining: number | null
    planName: string | null
  }> {
    return this.request(`/subscription-status/${orgId}`)
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
    /**
     * Stable dedupe key. Auth-side stores it in
     * `organization_notification_log` and skips the email send on
     * collision. Required to avoid duplicate emails when this client
     * is invoked by retried QStash steps or the billing scheduler.
     */
    idempotencyKey?: string
  }): Promise<{ success: boolean; type: string; alreadyProcessed?: boolean }> {
    return this.request<{ success: boolean; type: string; alreadyProcessed?: boolean }>('/notify', {
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
export type {
  DebitResult,
  CreditResult,
  UsageLogResult,
  OrgBalance,
  OrgMarkup,
  OrgBillingInfo,
}
