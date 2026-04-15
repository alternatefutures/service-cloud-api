/**
 * Centralized Billing Configuration
 *
 * All billing tuning knobs in one place. Previously scattered across
 * escrowService.ts, computeBillingScheduler.ts, and hardcoded literals.
 *
 * Billing mode is orthogonal to policy enforcement:
 *   - Policies observe spend (totalSpentUsd, consumedCents)
 *   - Billing mode determines when wallet is debited
 *   - Both paths update tracking fields consistently
 */

export const BILLING_CONFIG = {
  akash: {
    // Escrow: 0 = no upfront hold (pure pay-as-you-go).
    // Set > 0 to pre-fund N days (e.g. for budget-cap or auto-stop features later).
    escrowDays: 0,
    billingIntervalHours: 1,
    minBillingIntervalHours: 1,
    minBalanceCentsToLaunch: 100,
  },
  phala: {
    billingIntervalHours: 1,
    minBalanceCentsToLaunch: 100,
  },
  scheduler: {
    cronExpression: '0 * * * *',
  },
  thresholds: {
    /** Suspend when balance cannot cover this many hours of total burn. */
    lowBalanceHours: 1,
    checkIntervalCron: '*/10 * * * *',
    failClosedAboveCentsPerDay: 500,
  },
} as const

export type BillingConfig = typeof BILLING_CONFIG
