import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GraphQLError } from 'graphql'
import {
  assertDeploymentsEnabled,
  assertWithinHourlyCap,
  assertOrgConcurrency,
  assertLaunchAllowed,
  isHourlyCapAllowlisted,
} from './launchGuards.js'
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

describe('launchGuards', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    delete process.env.DEPLOYMENTS_DISABLED
    delete process.env.DEPLOYMENTS_DISABLED_REASON
    delete process.env.BETA_MAX_HOURLY_CENTS
    delete process.env.BETA_HOURLY_CAP_ALLOWLIST
    delete process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG
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
      process.env.BETA_MAX_HOURLY_CENTS = '2000' // $20/hr
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

  describe('assertOrgConcurrency', () => {
    it('allows when under the default cap (10)', async () => {
      const prisma = buildPrisma(3, 2)
      await expect(assertOrgConcurrency('org-1', prisma)).resolves.toBeUndefined()
    })

    it('rejects when at or above the default cap', async () => {
      const prisma = buildPrisma(6, 4) // 10 total
      await expect(assertOrgConcurrency('org-1', prisma)).rejects.toThrow(GraphQLError)
      try {
        await assertOrgConcurrency('org-1', prisma)
      } catch (e) {
        expect((e as GraphQLError).extensions?.code).toBe('CONCURRENCY_LIMIT_REACHED')
        expect((e as GraphQLError).extensions?.activeDeployments).toBe(10)
        expect((e as GraphQLError).extensions?.maxActiveDeployments).toBe(10)
      }
    })

    it('respects a raised cap via env', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '50'
      const prisma = buildPrisma(30, 15) // 45 total, under 50
      await expect(assertOrgConcurrency('org-1', prisma)).resolves.toBeUndefined()
    })

    it('respects a lowered cap via env', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '3'
      const prisma = buildPrisma(2, 2) // 4 total, over 3
      await expect(assertOrgConcurrency('org-1', prisma)).rejects.toThrow(GraphQLError)
    })

    it('disables the guard when env is exactly "0"', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = '0'
      const prisma = buildPrisma(100, 100)
      await expect(assertOrgConcurrency('org-1', prisma)).resolves.toBeUndefined()
    })

    it('falls back to default 10 for garbage input', async () => {
      process.env.MAX_ACTIVE_DEPLOYMENTS_PER_ORG = 'lots'
      const prisma = buildPrisma(5, 5) // 10 total, at default cap
      await expect(assertOrgConcurrency('org-1', prisma)).rejects.toThrow(GraphQLError)
    })

    it('skips the check when organizationId is undefined', async () => {
      const prisma = buildPrisma(100, 100)
      await expect(assertOrgConcurrency(undefined, prisma)).resolves.toBeUndefined()
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
      expect(prisma.phalaDeployment.count).not.toHaveBeenCalled()
    })
  })

  describe('assertLaunchAllowed', () => {
    it('passes when all guards pass', async () => {
      const prisma = buildPrisma(1, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100)).resolves.toBeUndefined()
    })

    it('rejects when kill-switch is on (before concurrency check)', async () => {
      process.env.DEPLOYMENTS_DISABLED = 'true'
      const prisma = buildPrisma(0, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 100)).rejects.toThrow(GraphQLError)
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
    })

    it('rejects when hourly cap is exceeded (before concurrency check)', async () => {
      process.env.BETA_MAX_HOURLY_CENTS = '100'
      const prisma = buildPrisma(0, 0)
      await expect(assertLaunchAllowed('org-1', prisma, 150)).rejects.toThrow(GraphQLError)
      expect(prisma.akashDeployment.count).not.toHaveBeenCalled()
    })

    it('rejects when org is at concurrency limit', async () => {
      const prisma = buildPrisma(10, 0) // at default cap
      await expect(assertLaunchAllowed('org-1', prisma, 100)).rejects.toThrow(GraphQLError)
    })

    it('allowlisted org still gated by concurrency cap', async () => {
      process.env.BETA_MAX_HOURLY_CENTS = '100'
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-power'
      const prisma = buildPrisma(10, 0)
      // Hourly cap bypassed for org-power, but concurrency still applies
      await expect(assertLaunchAllowed('org-power', prisma, 10_000)).rejects.toThrow(
        /CONCURRENCY_LIMIT_REACHED|active deployments/i,
      )
    })

    it('allowlisted org under concurrency cap succeeds at any rate', async () => {
      process.env.BETA_MAX_HOURLY_CENTS = '100'
      process.env.BETA_HOURLY_CAP_ALLOWLIST = 'org-power'
      const prisma = buildPrisma(1, 0)
      await expect(assertLaunchAllowed('org-power', prisma, 50_000)).resolves.toBeUndefined()
    })
  })
})
