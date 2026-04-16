import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphQLError } from 'graphql'

const opsAlertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../lib/opsAlert.js', () => ({
  opsAlert: opsAlertMock,
}))

import {
  assertDeploymentsEnabled,
  assertWithinHourlyCap,
  assertOrgConcurrency,
  assertLaunchAllowed,
  classifyTier,
  resolveConcurrencyCap,
  isHourlyCapAllowlisted,
} from './launchGuards.js'
import type { SubscriptionStatusInfo } from './subscriptionCheck.js'
import type { PrismaClient } from '@prisma/client'

function buildPrisma(akashActive = 0, phalaActive = 0): PrismaClient {
  return {
    akashDeployment: {
      count: vi.fn().mockResolvedValue(akashActive),
    },
    phalaDeployment: {
      count: vi.fn().mockResolvedValue(phalaActive),
    },
  } as unknown as PrismaClient
}

function sub(status: string | null): SubscriptionStatusInfo {
  return {
    status,
    trialEnd: null,
    daysRemaining: null,
    graceRemaining: null,
    planName: null,
  }
}

const TRIAL = sub('TRIALING')
const PAID = sub('ACTIVE')
const PAST_DUE = sub('PAST_DUE')

describe('launchGuards', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.DEPLOYMENTS_DISABLED
    delete process.env.DEPLOYMENTS_DISABLED_REASON
    delete process.env.BETA_MAX_HOURLY_CENTS
    delete process.env.BETA_HOURLY_CAP_ALLOWLIST
    delete process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG
    delete process.env.MAX_ACTIVE_DEPLOYMENTS_TRIAL
    delete process.env.MAX_ACTIVE_DEPLOYMENTS_PAID
    opsAlertMock.mockClear()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  describe('assertDeploymentsEnabled', () => {
    it('allows deployments when env var is unset', () => {
      expect(() => assertDeploymentsEnabled()).not.toThrow()
    })

    it('allows deployments when env var is false', () => {
      process.env.DEPLOYMENTS_DISABLED = 'false'
      expect(() => assertDeploymentsEnabled()).not.toThrow()
    })

    it('rejects when DEPLOYMENTS_DISABLED=true', () => {
      process.env.DEPLOYMENTS_DISABLED = 'true'
      expect(() => assertDeploymentsEnabled()).toThrow(GraphQLError)
      try {
        assertDeploymentsEnabled()
      } catch (e) {
        expect((e as GraphQLError).extensions?.code).toBe('DEPLOYMENTS_DISABLED')
      }
    })

    it('accepts alternate truthy values', () => {
      for (const v of ['1', 'yes', 'on', 'TRUE', 'Yes']) {
        process.env.DEPLOYMENTS_DISABLED = v
        expect(() => assertDeploymentsEnabled()).toThrow(GraphQLError)
      }
    })

    it('uses custom reason when DEPLOYMENTS_DISABLED_REASON is set', () => {
      process.env.DEPLOYMENTS_DISABLED = 'true'
      process.env.DEPLOYMENTS_DISABLED_REASON = 'Scheduled maintenance until 2pm UTC'
      try {
        assertDeploymentsEnabled()
      } catch (e) {
        expect((e as GraphQLError).message).toContain('Scheduled maintenance')
      }
    })
  })

  describe('isHourlyCapAllowlisted', () => {
    it('returns false when allowlist is unset', () => {
      expect(isHourlyCapAllowlisted('org-1')).toBe(false)
    })

    it('returns true for orgs in the CSV', () => {
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-1, org-2 ,org-3'
      expect(isHourlyCapAllowlisted('org-1')).toBe(true)
      expect(isHourlyCapAllowlisted('org-2')).toBe(true)
      expect(isHourlyCapAllowlisted('org-3')).toBe(true)
    })

    it('returns false for orgs not in the CSV', () => {
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-1,org-2'
      expect(isHourlyCapAllowlisted('org-99')).toBe(false)
    })

    it('tolerates whitespace and empty entries', () => {
      process.env.BETA_HOURLY_CAP_ALLOWLIST = '  org-1 , ,org-2, '
      expect(isHourlyCapAllowlisted('org-1')).toBe(true)
      expect(isHourlyCapAllowlisted('org-2')).toBe(true)
      expect(isHourlyCapAllowlisted('')).toBe(false)
    })

    it('returns false for undefined/null orgId', () => {
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-1'
      expect(isHourlyCapAllowlisted(undefined)).toBe(false)
      expect(isHourlyCapAllowlisted(null)).toBe(false)
    })
  })

  describe('assertWithinHourlyCap', () => {
    it('allows any rate when cap is unset', () => {
      expect(() => assertWithinHourlyCap('org-1', 10_000)).not.toThrow()
    })

    it('allows any rate when cap is 0', () => {
      process.env.BETA_MAX_HOURLY_CENTS = '0'
      expect(() => assertWithinHourlyCap('org-1', 10_000)).not.toThrow()
    })

    it('allows any rate when cap is non-numeric', () => {
      process.env.BETA_MAX_HOURLY_CENTS = 'abc'
      expect(() => assertWithinHourlyCap('org-1', 10_000)).not.toThrow()
    })

    it('allows rate at or below cap', () => {
      process.env.BETA_MAX_HOURLY_CENTS = '2000'
      expect(() => assertWithinHourlyCap('org-1', 1999)).not.toThrow()
      expect(() => assertWithinHourlyCap('org-1', 2000)).not.toThrow()
    })

    it('rejects rate above cap', () => {
      process.env.BETA_MAX_HOURLY_CENTS = '2000'
      expect(() => assertWithinHourlyCap('org-1', 2001)).toThrow(GraphQLError)
      try {
        assertWithinHourlyCap('org-1', 5000)
      } catch (e) {
        expect((e as GraphQLError).extensions?.code).toBe('HOURLY_CAP_EXCEEDED')
        expect((e as GraphQLError).extensions?.maxHourlyCostCents).toBe(2000)
        expect((e as GraphQLError).extensions?.projectedHourlyCostCents).toBe(5000)
        expect((e as GraphQLError).extensions?.allowlistable).toBe(true)
      }
    })

    it('bypasses cap for allowlisted orgs', () => {
      process.env.BETA_MAX_HOURLY_CENTS = '2000'
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-power-user'
      expect(() => assertWithinHourlyCap('org-power-user', 10_000)).not.toThrow()
      expect(() => assertWithinHourlyCap('org-normal', 10_000)).toThrow(GraphQLError)
    })
  })

  describe('classifyTier', () => {
    it('maps ACTIVE → paid', () => {
      expect(classifyTier(PAID)).toBe('paid')
    })

    it('maps PAST_DUE → paid (grace period still trusted)', () => {
      expect(classifyTier(PAST_DUE)).toBe('paid')
    })

    it('maps TRIALING → trial', () => {
      expect(classifyTier(TRIAL)).toBe('trial')
    })

    it('maps null/unknown → trial (fail-safe)', () => {
      expect(classifyTier(null)).toBe('trial')
      expect(classifyTier(sub(null))).toBe('trial')
      expect(classifyTier(sub('WEIRD_STATUS'))).toBe('trial')
      expect(classifyTier(sub('SUSPENDED'))).toBe('trial')
    })
  })

  describe('resolveConcurrencyCap', () => {
    it('returns tier defaults when no env is set', () => {
      expect(resolveConcurrencyCap('trial')).toBe(10)
      expect(resolveConcurrencyCap('paid')).toBe(25)
    })

    it('honors per-tier env overrides', () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_TRIAL = '5'
      process.env.MAX_ACTIVE_DEPLOYMENTS_PAID = '100'
      expect(resolveConcurrencyCap('trial')).toBe(5)
      expect(resolveConcurrencyCap('paid')).toBe(100)
    })

    it('falls back to default when tier env is garbage', () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_TRIAL = 'lol'
      expect(resolveConcurrencyCap('trial')).toBe(10)
    })

    it('global override wins over per-tier envs', () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_TRIAL = '5'
      process.env.MAX_ACTIVE_DEPLOYMENTS_PAID = '100'
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '3'
      expect(resolveConcurrencyCap('trial')).toBe(3)
      expect(resolveConcurrencyCap('paid')).toBe(3)
    })

    it('global override "0" disables the guard (returns null)', () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_TRIAL = '5'
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '0'
      expect(resolveConcurrencyCap('trial')).toBeNull()
      expect(resolveConcurrencyCap('paid')).toBeNull()
    })

    it('garbage global override falls through to tier defaults', () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = 'nope'
      expect(resolveConcurrencyCap('trial')).toBe(10)
      expect(resolveConcurrencyCap('paid')).toBe(25)
    })
  })

  describe('assertOrgConcurrency', () => {
    it('trial: allows when under default cap (10)', async () => {
      const prisma = buildPrisma(3, 2)
      await expect(assertOrgConcurrency('org-1', prisma, TRIAL)).resolves.toBeUndefined()
    })

    it('trial: rejects at default cap (10)', async () => {
      const prisma = buildPrisma(6, 4)
      await expect(assertOrgConcurrency('org-1', prisma, TRIAL)).rejects.toThrow(GraphQLError)
      try {
        await assertOrgConcurrency('org-1', prisma, TRIAL)
      } catch (e) {
        expect((e as GraphQLError).extensions?.code).toBe('CONCURRENCY_LIMIT_REACHED')
        expect((e as GraphQLError).extensions?.tier).toBe('trial')
        expect((e as GraphQLError).extensions?.maxActiveDeployments).toBe(10)
        expect((e as GraphQLError).extensions?.upgradeable).toBe(true)
        expect((e as GraphQLError).message).toMatch(/Subscribe to a paid plan/)
      }
    })

    it('paid: allows more deployments than trial default', async () => {
      const prisma = buildPrisma(15, 0)
      await expect(assertOrgConcurrency('org-1', prisma, PAID)).resolves.toBeUndefined()
    })

    it('paid: rejects at paid default cap (25)', async () => {
      const prisma = buildPrisma(25, 0)
      await expect(assertOrgConcurrency('org-1', prisma, PAID)).rejects.toThrow(GraphQLError)
      try {
        await assertOrgConcurrency('org-1', prisma, PAID)
      } catch (e) {
        expect((e as GraphQLError).extensions?.tier).toBe('paid')
        expect((e as GraphQLError).extensions?.upgradeable).toBe(false)
        expect((e as GraphQLError).message).toMatch(/contact support/)
      }
    })

    it('PAST_DUE still gets paid cap (grace period)', async () => {
      const prisma = buildPrisma(15, 0)
      await expect(assertOrgConcurrency('org-1', prisma, PAST_DUE)).resolves.toBeUndefined()
    })

    it('unknown subscription status falls back to trial cap (fail-safe)', async () => {
      const prisma = buildPrisma(10, 0)
      await expect(assertOrgConcurrency('org-1', prisma, null)).rejects.toThrow(GraphQLError)
    })

    it('per-tier env overrides work', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PAID = '50'
      const prisma = buildPrisma(30, 15)
      await expect(assertOrgConcurrency('org-1', prisma, PAID)).resolves.toBeUndefined()
    })

    it('global MAX_ACTIVE_DEPLOYMENTS_PER_ORG still overrides all tiers (incident lever)', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '3'
      const prisma = buildPrisma(2, 2)
      await expect(assertOrgConcurrency('org-1', prisma, PAID)).rejects.toThrow(GraphQLError)
    })

    it('global override "0" disables the guard entirely', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '0'
      const prisma = buildPrisma(100, 100)
      await expect(assertOrgConcurrency('org-1', prisma, TRIAL)).resolves.toBeUndefined()
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
    })

    it('disabled guard fires a deduped opsAlert (warning, hourly suppress)', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '0'
      const prisma = buildPrisma(0, 0)

      await assertOrgConcurrency('org-1', prisma, TRIAL)
      await assertOrgConcurrency('org-2', prisma, PAID)

      // Both calls hit the alert path — `opsAlert` itself dedupes (we just
      // verify we ALWAYS call it with the same key + a long suppressMs so
      // dedupe actually engages downstream).
      expect(opsAlertMock).toHaveBeenCalledTimes(2)
      const firstCall = opsAlertMock.mock.calls[0]?.[0]
      const secondCall = opsAlertMock.mock.calls[1]?.[0]
      expect(firstCall.key).toBe('launch-guards:concurrency-disabled')
      expect(secondCall.key).toBe('launch-guards:concurrency-disabled')
      expect(firstCall.severity).toBe('warning')
      expect(firstCall.suppressMs).toBeGreaterThanOrEqual(60 * 60 * 1000)
      expect(firstCall.context).toEqual({ organizationId: 'org-1', tier: 'trial' })
      expect(secondCall.context).toEqual({ organizationId: 'org-2', tier: 'paid' })
    })

    it('does not fire the disabled-guard alert when the guard is enabled', async () => {
      const prisma = buildPrisma(1, 0)
      await assertOrgConcurrency('org-1', prisma, PAID)
      expect(opsAlertMock).not.toHaveBeenCalled()
    })

    it('skips the check when organizationId is undefined', async () => {
      const prisma = buildPrisma(100, 100)
      await expect(assertOrgConcurrency(undefined, prisma, TRIAL)).resolves.toBeUndefined()
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
    })
  })

  describe('assertLaunchAllowed', () => {
    it('passes when all guards pass (paid)', async () => {
      const prisma = buildPrisma(1, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100, PAID)).resolves.toBeUndefined()
    })

    it('passes when all guards pass (trial)', async () => {
      const prisma = buildPrisma(1, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100, TRIAL)).resolves.toBeUndefined()
    })

    it('rejects when kill-switch is on (before concurrency check)', async () => {
      process.env.DEPLOYMENTS_DISABLED = 'true'
      const prisma = buildPrisma(0, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100, PAID)).rejects.toThrow(GraphQLError)
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
    })

    it('rejects when hourly cap is exceeded (before concurrency check)', async () => {
      process.env.BETA_MAX_HOURLY_CENTS = '100'
      const prisma = buildPrisma(0, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 150, PAID)).rejects.toThrow(GraphQLError)
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
    })

    it('trial org at 10 deployments is rejected even when paid org would succeed', async () => {
      const prisma = buildPrisma(10, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100, TRIAL)).rejects.toThrow(GraphQLError)
    })

    it('paid org at 10 deployments is still allowed (paid cap is higher)', async () => {
      const prisma = buildPrisma(10, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100, PAID)).resolves.toBeUndefined()
    })

    it('allowlisted org still gated by concurrency cap', async () => {
      process.env.BETA_MAX_HOURLY_CENTS = '100'
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-power'
      const prisma = buildPrisma(25, 0)
      await expect(assertLaunchAllowed('org-power', prisma, 10_000, PAID)).rejects.toThrow(
        /CONCURRENCY_LIMIT_REACHED|active deployments/i,
      )
    })

    it('allowlisted paid org under cap succeeds at any rate', async () => {
      process.env.BETA_MAX_HOURLY_CENTS = '100'
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-power'
      const prisma = buildPrisma(1, 0)
      await expect(assertLaunchAllowed('org-power', prisma, 50_000, PAID)).resolves.toBeUndefined()
    })
  })
})
