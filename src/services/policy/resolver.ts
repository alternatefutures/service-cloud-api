import type { DeploymentPolicyRecord } from './types.js'

/**
 * Provider-neutral GPU filtering for Akash bids.
 *
 * Each bid has a provider address. We check if the provider's GPU model
 * matches one of the acceptable models from the policy.
 */
export function filterAkashBidsByPolicy<
  T extends { provider: string; gpuModel?: string | null },
>(bids: T[], policy: DeploymentPolicyRecord | null): T[] {
  if (!policy || !policy.acceptableGpuModels.length) {
    return bids
  }

  const acceptable = new Set(policy.acceptableGpuModels.map((m) => m.toLowerCase()))
  return bids.filter((bid) => {
    if (!bid.gpuModel) return false
    return acceptable.has(bid.gpuModel.toLowerCase())
  })
}

/**
 * Provider-neutral GPU filtering for Phala instance types.
 */
export function filterPhalaInstancesByPolicy<
  T extends { gpu?: string | null; gpuCount?: number | null },
>(instances: T[], acceptableGpuModels: string[], gpuUnits?: number | null): T[] {
  let filtered = instances

  if (acceptableGpuModels.length > 0) {
    const acceptable = new Set(acceptableGpuModels.map((m) => m.toLowerCase()))
    filtered = filtered.filter((inst) => {
      if (!inst.gpu) return false
      return acceptable.has(inst.gpu.toLowerCase())
    })
  }

  if (gpuUnits != null && gpuUnits > 0) {
    filtered = filtered.filter((inst) => {
      return (inst.gpuCount ?? 1) >= gpuUnits
    })
  }

  return filtered
}
