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
  // Spheron mirrors Phala's hourly cadence. The minimum-runtime floor
  // (20 minutes for Spheron — server-side contract) is sourced from
  // `MINIMUM_RUNTIME_FLOOR_MS` below, NOT from a provider-specific knob,
  // so adding a new GPU provider doesn't fork the contract.
  spheron: {
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

/**
 * Workload-kind discriminator used to drive provider-agnostic billing
 * policy (currently the minimum-runtime floor; future: per-kind margins,
 * per-kind suspension grace, etc.).
 *
 *   - `gpu` — any deployment that provisions one or more GPUs (Spheron VMs,
 *     Akash GPU leases, Phala GPU CVMs like h200.*). The 20-minute floor
 *     applies because Spheron's upstream contract bills the platform a
 *     20-min minimum and we mirror that across providers so users see
 *     consistent invoices regardless of where their GPU lands.
 *   - `cvm` — Phala TEE CVMs without a GPU (cpu/tdx tiers). No floor today.
 *   - `cpu` — Akash CPU deployments. No floor today.
 *
 * Each provider exposes a `getWorkloadKind(deploymentRow)` helper next to
 * its provider adapter; `processFinal{Akash,Phala,Spheron}Billing` calls
 * `getMinimumRuntimeFloorMs(kind)` on settlement.
 */
export type WorkloadKind = 'gpu' | 'cvm' | 'cpu'

/**
 * Minimum-billable-runtime floor by workload kind, in milliseconds.
 *
 * The platform charges `max(actualRuntimeMs, floorMs) × hourlyRate` so a
 * sub-floor close still produces a sane invoice. Currently only the GPU
 * floor is non-zero; CVM and CPU slots exist so flipping them later is
 * a one-line change and consumers don't have to special-case the lookup.
 *
 * SOURCE OF TRUTH — every provider settlement path MUST read from here.
 * Hard-coded floors elsewhere are forbidden (search the repo for
 * `MIN_RUNTIME` / `_FLOOR_MS` if adding a new one).
 *
 * Why GPU = 20 min:
 *   - Spheron's `/api/deployments/:id` DELETE endpoint returns 400 with
 *     `Instance must run for at least 20 minutes` inside this window —
 *     i.e. Spheron itself bills the platform `max(actualMinutes, 20) ×
 *     hourlyRate`. Mirroring the same floor on user-facing billing keeps
 *     the platform whole on sub-20-min closes.
 *   - For Akash and Phala GPUs, no upstream contract dictates 20 min —
 *     we apply it for cross-provider parity. A user choosing a different
 *     GPU provider should never get a different sub-floor invoice for the
 *     same close-in-30-seconds behaviour.
 */
export const MINIMUM_RUNTIME_FLOOR_MS: Record<WorkloadKind, number> = {
  gpu: 20 * 60_000,
  cvm: 0,
  cpu: 0,
}

/**
 * Look up the floor for a workload kind. Use this instead of indexing
 * `MINIMUM_RUNTIME_FLOOR_MS` directly so unknown kinds (defensive, e.g.
 * a future workload type added before all consumers are updated) safely
 * resolve to 0.
 */
export function getMinimumRuntimeFloorMs(kind: WorkloadKind): number {
  return MINIMUM_RUNTIME_FLOOR_MS[kind] ?? 0
}

/**
 * Convenience: floor in whole minutes (rounded up). Surfaced to the
 * GraphQL layer + frontend warning copy so the UI never hard-codes "20".
 */
export function getMinimumRuntimeFloorMinutes(kind: WorkloadKind): number {
  return Math.ceil(getMinimumRuntimeFloorMs(kind) / 60_000)
}
