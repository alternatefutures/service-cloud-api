import { describe, expect, it, vi } from 'vitest'
import {
  assertAndIncrementOrgConcurrency,
  ConcurrencyCapExceededError,
  decrementOrgConcurrency,
} from './concurrencyService.js'

/**
 * Build a minimal in-memory prisma double that mimics the
 * SELECT FOR UPDATE → UPDATE flow inside
 * `assertAndIncrementOrgConcurrency`. The interesting invariants we want
 * to lock in:
 *
 *   1. The cap is strictly enforced (cap+1 throws).
 *   2. The throw is `ConcurrencyCapExceededError` (caller depends on it
 *      to surface the correct GraphQL error code).
 *   3. Decrement clamps at zero (never goes negative under double-call).
 */
function buildPrismaDouble(initial: Record<string, number> = {}) {
  const rows = new Map<string, number>(Object.entries(initial))
  const exec = async (sql: string, ...params: unknown[]): Promise<number> => {
    if (sql.includes('UPDATE organization_concurrency_counter')) {
      const orgId = params[0] as string
      const current = rows.get(orgId) ?? 0
      rows.set(orgId, Math.max(0, current - 1))
      return 1
    }
    return 0
  }
  return {
    rows,
    prisma: {
      $executeRawUnsafe: vi.fn(exec),
      $transaction: vi.fn(async (cb: (tx: any) => Promise<unknown>) => {
        const tx = {
          $queryRawUnsafe: vi.fn(async (_sql: string, orgId: string) => {
            const v = rows.get(orgId)
            return v === undefined ? [] : [{ active_count: v }]
          }),
          organizationConcurrencyCounter: {
            create: vi.fn(async ({ data }: { data: { organizationId: string; activeCount: number } }) => {
              if (rows.has(data.organizationId)) {
                const err = new Error('unique violation') as Error & { code: string }
                err.code = 'P2002'
                throw err
              }
              rows.set(data.organizationId, data.activeCount)
              return { ...data }
            }),
            update: vi.fn(async ({ where, data }: { where: { organizationId: string }; data: { activeCount: number } }) => {
              rows.set(where.organizationId, data.activeCount)
              return { organizationId: where.organizationId, activeCount: data.activeCount }
            }),
            upsert: vi.fn(),
          },
        }
        return cb(tx)
      }),
    } as any,
  }
}

describe('assertAndIncrementOrgConcurrency', () => {
  it('bootstraps a counter row at 0 and increments to 1 on first deploy', async () => {
    const { prisma, rows } = buildPrismaDouble()
    const result = await assertAndIncrementOrgConcurrency(prisma, 'org-new', 5)
    expect(result.activeCount).toBe(1)
    expect(rows.get('org-new')).toBe(1)
  })

  it('rejects when the next claim would exceed the cap', async () => {
    const { prisma } = buildPrismaDouble({ 'org-busy': 3 })
    await expect(
      assertAndIncrementOrgConcurrency(prisma, 'org-busy', 3),
    ).rejects.toBeInstanceOf(ConcurrencyCapExceededError)
  })

  it('allows the claim that exactly hits the cap', async () => {
    const { prisma, rows } = buildPrismaDouble({ 'org-edge': 4 })
    const result = await assertAndIncrementOrgConcurrency(prisma, 'org-edge', 5)
    expect(result.activeCount).toBe(5)
    expect(rows.get('org-edge')).toBe(5)
  })
})

describe('decrementOrgConcurrency', () => {
  it('decrements an existing counter', async () => {
    const { prisma, rows } = buildPrismaDouble({ 'org-1': 2 })
    await decrementOrgConcurrency(prisma, 'org-1')
    expect(rows.get('org-1')).toBe(1)
  })

  it('clamps at zero on double-decrement (idempotent close paths)', async () => {
    const { prisma, rows } = buildPrismaDouble({ 'org-1': 0 })
    await decrementOrgConcurrency(prisma, 'org-1')
    await decrementOrgConcurrency(prisma, 'org-1')
    expect(rows.get('org-1')).toBe(0)
  })

  it('is a no-op for null/undefined orgId (callers may not always have one)', async () => {
    const { prisma } = buildPrismaDouble()
    await expect(decrementOrgConcurrency(prisma, null)).resolves.toBeUndefined()
    await expect(decrementOrgConcurrency(prisma, undefined)).resolves.toBeUndefined()
    expect(prisma.$executeRawUnsafe).not.toHaveBeenCalled()
  })
})
