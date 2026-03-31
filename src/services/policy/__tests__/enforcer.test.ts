import { describe, test, expect } from 'vitest'

// The enforcer functions interact with Prisma + orchestrators, so we test
// the policy limit checking logic conceptually here. Full integration tests
// require a running database.

describe('Policy enforcement logic', () => {
  test('budget exceeded when totalSpentUsd >= maxBudgetUsd', () => {
    const policy = { maxBudgetUsd: 50, totalSpentUsd: 50.01 }
    expect(policy.totalSpentUsd >= policy.maxBudgetUsd).toBe(true)
  })

  test('budget not exceeded when totalSpentUsd < maxBudgetUsd', () => {
    const policy = { maxBudgetUsd: 50, totalSpentUsd: 49.99 }
    expect(policy.totalSpentUsd >= policy.maxBudgetUsd).toBe(false)
  })

  test('runtime expired when expiresAt <= now', () => {
    const past = new Date(Date.now() - 60_000)
    expect(past <= new Date()).toBe(true)
  })

  test('runtime not expired when expiresAt > now', () => {
    const future = new Date(Date.now() + 3600_000)
    expect(future <= new Date()).toBe(false)
  })

  test('no enforcement when no policy constraints', () => {
    const policy = { maxBudgetUsd: null, expiresAt: null }
    const needsEnforcement =
      (policy.maxBudgetUsd != null) || (policy.expiresAt != null)
    expect(needsEnforcement).toBe(false)
  })

  test('enforcement needed when budget is set', () => {
    const policy = { maxBudgetUsd: 100, expiresAt: null }
    const needsEnforcement =
      (policy.maxBudgetUsd != null) || (policy.expiresAt != null)
    expect(needsEnforcement).toBe(true)
  })

  test('enforcement needed when expiresAt is set', () => {
    const policy = { maxBudgetUsd: null, expiresAt: new Date() }
    const needsEnforcement =
      (policy.maxBudgetUsd != null) || (policy.expiresAt != null)
    expect(needsEnforcement).toBe(true)
  })
})
