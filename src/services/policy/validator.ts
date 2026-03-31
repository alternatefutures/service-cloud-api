import type { DeploymentPolicyInput, PolicyValidationResult } from './types.js'

/**
 * Pre-deploy validation: rejects if projected costs exceed budget caps.
 */
export function validateBudgetBeforeDeploy(
  policy: DeploymentPolicyInput,
  projectedDailyUsd: number
): PolicyValidationResult {
  if (policy.maxMonthlyUsd != null && policy.maxMonthlyUsd > 0) {
    const projectedMonthly = projectedDailyUsd * 30
    if (projectedMonthly > policy.maxMonthlyUsd) {
      return {
        allowed: false,
        reason: `Projected monthly cost ($${projectedMonthly.toFixed(2)}) exceeds monthly budget cap ($${policy.maxMonthlyUsd.toFixed(2)})`,
      }
    }
  }

  if (policy.maxBudgetUsd != null && policy.maxBudgetUsd <= 0) {
    return {
      allowed: false,
      reason: 'Total budget cap must be greater than zero',
    }
  }

  if (policy.runtimeMinutes != null && policy.runtimeMinutes <= 0) {
    return {
      allowed: false,
      reason: 'Runtime duration must be greater than zero',
    }
  }

  if (policy.gpuUnits != null && (policy.gpuUnits < 1 || policy.gpuUnits > 8)) {
    return {
      allowed: false,
      reason: 'GPU units must be between 1 and 8',
    }
  }

  return { allowed: true }
}

/**
 * Validates that at least one acceptable GPU model is available from the provider.
 */
export function validateGpuConstraints(
  acceptableModels: string[],
  availableModels: string[]
): PolicyValidationResult {
  if (!acceptableModels.length) {
    return { allowed: true }
  }

  const normalizedAcceptable = acceptableModels.map((m) => m.toLowerCase())
  const normalizedAvailable = availableModels.map((m) => m.toLowerCase())

  const hasMatch = normalizedAcceptable.some((m) => normalizedAvailable.includes(m))
  if (!hasMatch) {
    return {
      allowed: false,
      reason: `No providers offer the requested GPU models: ${acceptableModels.join(', ')}`,
    }
  }

  return { allowed: true }
}

/**
 * Validates the raw policy input for structural correctness.
 */
export function validatePolicyInput(input: DeploymentPolicyInput): PolicyValidationResult {
  if (input.maxBudgetUsd != null && input.maxBudgetUsd <= 0) {
    return { allowed: false, reason: 'Total budget cap must be greater than zero' }
  }

  if (input.maxMonthlyUsd != null && input.maxMonthlyUsd <= 0) {
    return { allowed: false, reason: 'Monthly budget cap must be greater than zero' }
  }

  if (input.runtimeMinutes != null && input.runtimeMinutes <= 0) {
    return { allowed: false, reason: 'Runtime duration must be greater than zero' }
  }

  if (input.gpuUnits != null && (input.gpuUnits < 1 || input.gpuUnits > 8)) {
    return { allowed: false, reason: 'GPU units must be between 1 and 8' }
  }

  if (input.acceptableGpuModels?.length) {
    const invalid = input.acceptableGpuModels.filter((m) => !m.trim())
    if (invalid.length) {
      return { allowed: false, reason: 'GPU model names must not be empty strings' }
    }
  }

  return { allowed: true }
}
