import { describe, test, expect } from 'bun:test'
import {
  validatePolicyInput,
  validateBudgetBeforeDeploy,
  validateGpuConstraints,
} from '../validator.js'

describe('validatePolicyInput', () => {
  test('allows empty policy', () => {
    expect(validatePolicyInput({}).allowed).toBe(true)
  })

  test('allows valid policy with all fields', () => {
    const result = validatePolicyInput({
      acceptableGpuModels: ['h100', 'a100'],
      gpuUnits: 2,
      gpuVendor: 'nvidia',
      maxBudgetUsd: 50,
      maxMonthlyUsd: 100,
      runtimeMinutes: 240,
    })
    expect(result.allowed).toBe(true)
  })

  test('rejects negative budget', () => {
    const result = validatePolicyInput({ maxBudgetUsd: -5 })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('greater than zero')
  })

  test('rejects zero budget', () => {
    const result = validatePolicyInput({ maxBudgetUsd: 0 })
    expect(result.allowed).toBe(false)
  })

  test('rejects negative monthly budget', () => {
    const result = validatePolicyInput({ maxMonthlyUsd: -1 })
    expect(result.allowed).toBe(false)
  })

  test('rejects negative runtime', () => {
    const result = validatePolicyInput({ runtimeMinutes: -10 })
    expect(result.allowed).toBe(false)
  })

  test('rejects zero runtime', () => {
    const result = validatePolicyInput({ runtimeMinutes: 0 })
    expect(result.allowed).toBe(false)
  })

  test('rejects gpu units below 1', () => {
    const result = validatePolicyInput({ gpuUnits: 0 })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('between 1 and 8')
  })

  test('rejects gpu units above 8', () => {
    const result = validatePolicyInput({ gpuUnits: 16 })
    expect(result.allowed).toBe(false)
  })

  test('rejects empty string GPU models', () => {
    const result = validatePolicyInput({ acceptableGpuModels: ['h100', '', 'a100'] })
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('empty strings')
  })
})

describe('validateBudgetBeforeDeploy', () => {
  test('allows when no monthly cap', () => {
    const result = validateBudgetBeforeDeploy({}, 10)
    expect(result.allowed).toBe(true)
  })

  test('allows when projected is under cap', () => {
    const result = validateBudgetBeforeDeploy({ maxMonthlyUsd: 100 }, 3)
    expect(result.allowed).toBe(true)
  })

  test('rejects when projected monthly exceeds cap', () => {
    const result = validateBudgetBeforeDeploy({ maxMonthlyUsd: 50 }, 5)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('exceeds monthly budget')
  })

  test('rejects zero budget cap', () => {
    const result = validateBudgetBeforeDeploy({ maxBudgetUsd: 0 }, 1)
    expect(result.allowed).toBe(false)
  })

  test('rejects zero runtime', () => {
    const result = validateBudgetBeforeDeploy({ runtimeMinutes: 0 }, 1)
    expect(result.allowed).toBe(false)
  })
})

describe('validateGpuConstraints', () => {
  test('allows when no constraints', () => {
    const result = validateGpuConstraints([], ['h100', 'a100'])
    expect(result.allowed).toBe(true)
  })

  test('allows when match exists', () => {
    const result = validateGpuConstraints(['h100'], ['h100', 'a100'])
    expect(result.allowed).toBe(true)
  })

  test('allows case-insensitive match', () => {
    const result = validateGpuConstraints(['H100'], ['h100'])
    expect(result.allowed).toBe(true)
  })

  test('rejects when no match', () => {
    const result = validateGpuConstraints(['h200'], ['h100', 'a100'])
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('No providers offer')
  })

  test('rejects when available is empty', () => {
    const result = validateGpuConstraints(['h100'], [])
    expect(result.allowed).toBe(false)
  })
})
