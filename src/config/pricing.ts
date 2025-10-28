/**
 * Pricing Configuration for Alternate Futures Platform
 * All prices in USD
 */

export const PRICING = {
  /**
   * Storage Costs
   */
  storage: {
    /** IPFS pinning - per GB/month */
    ipfs: 0.06,
    /** Filecoin storage deals - per GB/month */
    filecoin: 0.03,
    /** Arweave permanent storage - one-time per GB */
    arweave: 6.0,
  },

  /**
   * Bandwidth Costs
   */
  bandwidth: {
    /** Free tier included bandwidth (GB) */
    free: {
      included: 100,
      overage: 0.1,
    },
    /** Pro tier bandwidth (GB) */
    pro: {
      included: 1024, // 1 TB
      overage: 0.08,
    },
    /** Enterprise tier - custom pricing */
    enterprise: {
      included: null,
      overage: null,
    },
  },

  /**
   * Compute Costs
   */
  compute: {
    /** Agent runtime - per hour */
    agentRuntime: 0.05,
    /** Function invocations - per million */
    functionInvocations: 0.2,
    /** GPU processing (ComfyUI) - per hour */
    gpuProcessing: 0.5,
  },

  /**
   * Container Registry Costs (Self-Hosted on Akash)
   */
  registry: {
    /** IPFS storage for container images - per GB/month */
    storage: 0.06,
    /** PostgreSQL database for metadata - per GB/month */
    database: 0.10,
    /** Akash compute for registry service - per hour */
    compute: 0.02,
  },
} as const;

/**
 * Calculate storage cost for a given storage type and size
 * @param storageType - The storage network type
 * @param sizeGB - Size in gigabytes
 * @param months - Number of months (default: 1)
 * @returns Cost in USD
 */
export function calculateStorageCost(
  storageType: 'ipfs' | 'filecoin' | 'arweave',
  sizeGB: number,
  months: number = 1
): number {
  const pricePerGB = PRICING.storage[storageType];

  // Arweave is one-time payment
  if (storageType === 'arweave') {
    return sizeGB * pricePerGB;
  }

  // IPFS and Filecoin are monthly
  return sizeGB * pricePerGB * months;
}

/**
 * Calculate bandwidth overage cost
 * @param tier - User's billing tier
 * @param usageGB - Total bandwidth usage in GB
 * @returns Overage cost in USD
 */
export function calculateBandwidthCost(
  tier: 'free' | 'pro' | 'enterprise',
  usageGB: number
): number {
  const tierConfig = PRICING.bandwidth[tier];

  // Enterprise has custom pricing
  if (tier === 'enterprise' || !tierConfig.included || !tierConfig.overage) {
    return 0;
  }

  // Calculate overage
  const overage = Math.max(0, usageGB - tierConfig.included);
  return overage * tierConfig.overage;
}

/**
 * Calculate compute cost
 * @param type - Type of compute resource
 * @param units - Number of units (hours for agents/GPU, millions for functions)
 * @returns Cost in USD
 */
export function calculateComputeCost(
  type: 'agentRuntime' | 'functionInvocations' | 'gpuProcessing',
  units: number
): number {
  return units * PRICING.compute[type];
}

/**
 * Calculate monthly registry hosting cost on Akash
 * @param storageGB - Storage used in GB
 * @param databaseGB - Database size in GB
 * @param computeHours - Compute hours per month (default: 730 for 24/7)
 * @returns Monthly cost in USD
 */
export function calculateRegistryCost(
  storageGB: number,
  databaseGB: number,
  computeHours: number = 730 // 24/7 for a month
): number {
  const storageCost = storageGB * PRICING.registry.storage;
  const databaseCost = databaseGB * PRICING.registry.database;
  const computeCost = computeHours * PRICING.registry.compute;

  return storageCost + databaseCost + computeCost;
}

/**
 * Get pricing information as a JSON object
 */
export function getPricingInfo() {
  return {
    storage: [
      { network: 'IPFS', type: 'Per GB/month', price: PRICING.storage.ipfs },
      { network: 'Filecoin', type: 'Per GB/month', price: PRICING.storage.filecoin },
      { network: 'Arweave', type: 'One-time per GB', price: PRICING.storage.arweave },
    ],
    bandwidth: [
      { tier: 'Free', included: PRICING.bandwidth.free.included, overage: PRICING.bandwidth.free.overage },
      { tier: 'Pro', included: PRICING.bandwidth.pro.included, overage: PRICING.bandwidth.pro.overage },
      { tier: 'Enterprise', included: 'Custom', overage: 'Custom' },
    ],
    compute: [
      { service: 'Agent Runtime', price: PRICING.compute.agentRuntime, unit: 'hour' },
      { service: 'Function Invocations', price: PRICING.compute.functionInvocations, unit: 'million' },
      { service: 'GPU Processing', price: PRICING.compute.gpuProcessing, unit: 'hour' },
    ],
    registry: [
      { resource: 'IPFS Storage', price: PRICING.registry.storage, unit: 'GB/month' },
      { resource: 'PostgreSQL Database', price: PRICING.registry.database, unit: 'GB/month' },
      { resource: 'Akash Compute', price: PRICING.registry.compute, unit: 'hour' },
    ],
  };
}
