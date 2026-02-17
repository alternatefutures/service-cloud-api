/**
 * Pricing Configuration for Alternate Futures Platform (2026-02-14)
 *
 * Pricing model:
 *   - IPFS pinning: flat $0.01/GB (loss-leader, rounded to nearest GB)
 *   - All other storage/compute: pass-through provider cost + plan margin
 *     - Monthly plan: 25% markup
 *     - Yearly plan:  20% markup
 *   - Akash compute: provider bid cost + plan margin
 *   - Phala TEE: provider rate + plan margin
 *
 * All raw costs in USD. Margin is applied by the billing system at charge-time
 * using the org's active plan usageMarkup rate.
 */

// ============================================
// DEFAULT PLAN MARGINS (fallbacks — actual per-org
// margin comes from SubscriptionPlan.usageMarkup)
// ============================================

export const DEFAULT_MONTHLY_MARGIN = 0.25
export const DEFAULT_YEARLY_MARGIN = 0.20

// ============================================
// STORAGE — RAW PROVIDER COSTS
// ============================================

export const STORAGE_PRICING = {
  /** IPFS pinning — flat rate, NOT pass-through (loss-leader) */
  ipfs: {
    model: 'flat' as const,
    ratePerGb: 0.01, // $/GB/month — rounded to nearest GB
  },
  /** Filecoin storage deals — pass-through + margin */
  filecoin: {
    model: 'passthrough' as const,
    ratePerGb: 0.03, // raw provider cost $/GB/month (margin added at billing)
  },
  /** Arweave permanent storage — pass-through + margin, one-time */
  arweave: {
    model: 'passthrough' as const,
    ratePerGb: 5.0, // raw provider cost $/GB one-time (margin added at billing)
  },
  /** Storj decentralized storage — pass-through + margin */
  storj: {
    model: 'passthrough' as const,
    ratePerGb: 0.004, // raw provider cost $/GB/month
    egressPerGb: 0.007, // raw provider egress cost $/GB
  },
} as const

// ============================================
// COMPUTE — RAW PROVIDER COSTS
// ============================================

export const COMPUTE_PRICING = {
  /** Agent runtime — per hour */
  agentRuntime: 0.05,
  /** Function invocations — per million */
  functionInvocations: 0.2,
  /** GPU processing (ComfyUI/standard) — per hour */
  gpuProcessing: 0.5,
} as const

// ============================================
// PHALA TEE — RAW PROVIDER RATES ($/hr)
// ============================================

export const PHALA_RATES: Record<string, number> = {
  'tdx.small': 0.07,
  'tdx.medium': 0.10,
  'tdx.large': 0.14,
  'tdx.xlarge': 0.28,
}

// ============================================
// AKASH — CONVERSION HELPERS
// ============================================

/** Approximate AKT/USD price — update via env or price feed */
export const AKT_USD_PRICE = parseFloat(process.env.AKT_USD_PRICE || '3.50')

/** Akash blocks per day (~6s/block) */
export const AKASH_BLOCKS_PER_DAY = 14400

// ============================================
// BANDWIDTH
// ============================================

export const BANDWIDTH_PRICING = {
  free: {
    included: 100, // GB
    overage: 0.1, // $/GB
  },
  pro: {
    included: 1024, // 1 TB
    overage: 0.08,
  },
  enterprise: {
    included: null as null,
    overage: null as null,
  },
} as const

// ============================================
// CONTAINER REGISTRY (Self-Hosted on Akash)
// ============================================

export const REGISTRY_PRICING = {
  storage: 0.06, // $/GB/month
  database: 0.1, // $/GB/month
  compute: 0.02, // $/hr
} as const

// ============================================
// BACKWARDS-COMPAT EXPORT
// ============================================

/** @deprecated Use STORAGE_PRICING, COMPUTE_PRICING, etc. directly */
export const PRICING = {
  storage: {
    ipfs: STORAGE_PRICING.ipfs.ratePerGb,
    filecoin: STORAGE_PRICING.filecoin.ratePerGb,
    arweave: STORAGE_PRICING.arweave.ratePerGb,
  },
  bandwidth: BANDWIDTH_PRICING,
  compute: COMPUTE_PRICING,
  registry: REGISTRY_PRICING,
} as const

// ============================================
// CALCULATION HELPERS
// ============================================

/**
 * Apply margin to a raw provider cost
 * @param rawCostUsd - Raw provider cost in USD
 * @param marginRate - Markup rate (e.g. 0.25 for 25%). Sourced from plan usageMarkup.
 * @returns Charged amount in USD
 */
export function applyMargin(rawCostUsd: number, marginRate: number): number {
  return rawCostUsd * (1 + marginRate)
}

/**
 * Calculate storage cost
 * For IPFS: flat rate (margin already baked in — loss-leader)
 * For others: raw cost only — caller must apply plan margin via applyMargin()
 *
 * @param storageType - The storage network type
 * @param sizeGB - Size in gigabytes
 * @param months - Number of months (default: 1, ignored for arweave)
 * @returns Raw cost in USD (before margin, except IPFS which is flat)
 */
export function calculateStorageCost(
  storageType: keyof typeof STORAGE_PRICING,
  sizeGB: number,
  months: number = 1
): number {
  const config = STORAGE_PRICING[storageType]

  // Arweave is one-time payment
  if (storageType === 'arweave') {
    return sizeGB * config.ratePerGb
  }

  // IPFS and others are monthly
  return sizeGB * config.ratePerGb * months
}

/**
 * Calculate storage cost with margin applied
 * Convenience wrapper that applies the plan's margin for pass-through providers.
 * IPFS is flat-rate (no additional margin).
 */
export function calculateStorageCostWithMargin(
  storageType: keyof typeof STORAGE_PRICING,
  sizeGB: number,
  marginRate: number,
  months: number = 1
): { rawCost: number; chargedCost: number; marginRate: number } {
  const rawCost = calculateStorageCost(storageType, sizeGB, months)
  const config = STORAGE_PRICING[storageType]

  // IPFS is flat-rate — no margin applied
  if (config.model === 'flat') {
    return { rawCost, chargedCost: rawCost, marginRate: 0 }
  }

  // Pass-through: apply plan margin
  return { rawCost, chargedCost: applyMargin(rawCost, marginRate), marginRate }
}

/**
 * Convert Akash pricePerBlock (uAKT) to USD per day
 * @param pricePerBlock - Price in uAKT per block (from bid)
 * @returns Daily cost in USD (raw, before margin)
 */
export function akashPricePerBlockToUsdPerDay(pricePerBlock: string | number): number {
  const priceUakt = typeof pricePerBlock === 'string' ? parseFloat(pricePerBlock) : pricePerBlock
  const dailyUakt = priceUakt * AKASH_BLOCKS_PER_DAY
  const dailyAkt = dailyUakt / 1_000_000
  return dailyAkt * AKT_USD_PRICE
}

/**
 * Get Phala TEE hourly rate for a given CVM size
 * @param cvmSize - CVM size tier (e.g. 'tdx.large')
 * @returns Hourly rate in USD (raw, before margin)
 */
export function getPhalaHourlyRate(cvmSize: string): number {
  return PHALA_RATES[cvmSize] ?? PHALA_RATES['tdx.large'] // default to large
}

/**
 * Calculate bandwidth overage cost
 */
export function calculateBandwidthCost(
  tier: 'free' | 'pro' | 'enterprise',
  usageGB: number
): number {
  const tierConfig = BANDWIDTH_PRICING[tier]

  if (tier === 'enterprise' || !tierConfig.included || !tierConfig.overage) {
    return 0
  }

  const overage = Math.max(0, usageGB - tierConfig.included)
  return overage * tierConfig.overage
}

/**
 * Calculate compute cost
 */
export function calculateComputeCost(
  type: keyof typeof COMPUTE_PRICING,
  units: number
): number {
  return units * COMPUTE_PRICING[type]
}

/**
 * Calculate monthly registry hosting cost on Akash
 */
export function calculateRegistryCost(
  storageGB: number,
  databaseGB: number,
  computeHours: number = 730
): number {
  return (
    storageGB * REGISTRY_PRICING.storage +
    databaseGB * REGISTRY_PRICING.database +
    computeHours * REGISTRY_PRICING.compute
  )
}

/**
 * Get pricing information as a JSON object (for API responses / frontend)
 *
 * NOTE: All prices shown are the final user-facing price.
 * Internal cost structure (raw provider cost + margin) is never exposed.
 */
export function getPricingInfo() {
  return {
    storage: [
      {
        network: 'IPFS',
        type: 'Per GB/month',
        price: STORAGE_PRICING.ipfs.ratePerGb,
      },
      {
        network: 'Filecoin',
        type: 'Per GB/month',
        price: STORAGE_PRICING.filecoin.ratePerGb,
      },
      {
        network: 'Arweave',
        type: 'One-time per GB',
        price: STORAGE_PRICING.arweave.ratePerGb,
      },
      {
        network: 'Storj',
        type: 'Per GB/month',
        price: STORAGE_PRICING.storj.ratePerGb,
        egressPrice: STORAGE_PRICING.storj.egressPerGb,
      },
    ],
    bandwidth: [
      {
        tier: 'Free',
        included: BANDWIDTH_PRICING.free.included,
        overage: BANDWIDTH_PRICING.free.overage,
      },
      {
        tier: 'Pro',
        included: BANDWIDTH_PRICING.pro.included,
        overage: BANDWIDTH_PRICING.pro.overage,
      },
      { tier: 'Enterprise', included: 'Custom', overage: 'Custom' },
    ],
    compute: [
      { service: 'Agent Runtime', price: COMPUTE_PRICING.agentRuntime, unit: 'hour' },
      { service: 'Function Invocations', price: COMPUTE_PRICING.functionInvocations, unit: 'million' },
      { service: 'GPU Processing', price: COMPUTE_PRICING.gpuProcessing, unit: 'hour' },
    ],
    phalaTee: Object.entries(PHALA_RATES).map(([size, rate]) => ({
      size,
      price: rate,
      unit: 'hour',
    })),
    registry: [
      { resource: 'IPFS Storage', price: REGISTRY_PRICING.storage, unit: 'GB/month' },
      { resource: 'PostgreSQL Database', price: REGISTRY_PRICING.database, unit: 'GB/month' },
      { resource: 'Akash Compute', price: REGISTRY_PRICING.compute, unit: 'hour' },
    ],
  }
}
