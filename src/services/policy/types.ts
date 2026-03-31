import type { PolicyStopReason } from '@prisma/client'

export { PolicyStopReason }

export interface DeploymentPolicyInput {
  acceptableGpuModels?: string[]
  gpuUnits?: number
  gpuVendor?: string
  maxBudgetUsd?: number
  maxMonthlyUsd?: number
  runtimeMinutes?: number
}

export interface DeploymentPolicyRecord {
  id: string
  acceptableGpuModels: string[]
  gpuUnits: number | null
  gpuVendor: string | null
  maxBudgetUsd: number | null
  maxMonthlyUsd: number | null
  runtimeMinutes: number | null
  expiresAt: Date | null
  stopReason: PolicyStopReason | null
  stoppedAt: Date | null
  totalSpentUsd: number
  createdAt: Date
  updatedAt: Date
}

export interface PolicyValidationResult {
  allowed: boolean
  reason?: string
}
