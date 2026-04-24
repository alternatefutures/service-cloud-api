import { describe, expect, it, vi } from 'vitest'
import { resolveAkashActiveSince, resolvePhalaActiveSince } from './leaseChain.js'

interface FakeAkashRow {
  id: string
  deployedAt: Date | null
  failoverParentId: string | null
  resumedFromId: string | null
  parentDeploymentId: string | null
}

interface FakePhalaRow {
  id: string
  activeStartedAt: Date | null
  resumedFromId: string | null
  parentDeploymentId: string | null
}

function akashPrisma(rows: FakeAkashRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    akashDeployment: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        return Promise.resolve(byId.get(where.id) ?? null)
      }),
    },
  } as any
}

function phalaPrisma(rows: FakePhalaRow[]) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  return {
    phalaDeployment: {
      findUnique: vi.fn().mockImplementation(({ where }) => {
        return Promise.resolve(byId.get(where.id) ?? null)
      }),
    },
  } as any
}

describe('resolveAkashActiveSince', () => {
  const T = (s: string) => new Date(s)

  it('returns this row deployedAt when there is no parent chain', async () => {
    const prisma = akashPrisma([
      {
        id: 'a',
        deployedAt: T('2026-04-20T10:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'a')
    expect(since?.toISOString()).toBe('2026-04-20T10:00:00.000Z')
  })

  it('walks failoverParentId back to the chain root', async () => {
    const prisma = akashPrisma([
      {
        id: 'c',
        deployedAt: T('2026-04-23T00:00:00Z'),
        failoverParentId: 'b',
        resumedFromId: null,
        parentDeploymentId: null,
      },
      {
        id: 'b',
        deployedAt: T('2026-04-22T00:00:00Z'),
        failoverParentId: 'a',
        resumedFromId: null,
        parentDeploymentId: null,
      },
      {
        id: 'a',
        deployedAt: T('2026-04-21T00:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'c')
    expect(since?.toISOString()).toBe('2026-04-21T00:00:00.000Z')
  })

  it('walks resumedFromId across a balance-low / topup bounce', async () => {
    // The exact scenario the user hit: SUSPENDED row a was redeployed by
    // resumeHandler into a fresh row b. Without resumedFromId the walker
    // would stop at b's deployedAt (2h ago); with it, the walker reaches
    // a and reports the original 3-day-old start.
    const prisma = akashPrisma([
      {
        id: 'b',
        deployedAt: T('2026-04-24T16:00:00Z'),
        failoverParentId: null,
        resumedFromId: 'a',
        parentDeploymentId: null,
      },
      {
        id: 'a',
        deployedAt: T('2026-04-21T16:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'b')
    expect(since?.toISOString()).toBe('2026-04-21T16:00:00.000Z')
  })

  it('mixes failover, resume, and queue-retry links in one chain', async () => {
    // d: failover from c.   c: resume from b.   b: queue retry from a.
    // The walker must traverse all three relation kinds to reach a.
    const prisma = akashPrisma([
      {
        id: 'd',
        deployedAt: T('2026-04-24T18:00:00Z'),
        failoverParentId: 'c',
        resumedFromId: null,
        parentDeploymentId: null,
      },
      {
        id: 'c',
        deployedAt: T('2026-04-23T12:00:00Z'),
        failoverParentId: null,
        resumedFromId: 'b',
        parentDeploymentId: null,
      },
      {
        id: 'b',
        deployedAt: T('2026-04-22T08:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: 'a',
      },
      {
        id: 'a',
        deployedAt: T('2026-04-20T08:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'd')
    expect(since?.toISOString()).toBe('2026-04-20T08:00:00.000Z')
  })

  it('returns null when no row in the chain ever reached ACTIVE', async () => {
    const prisma = akashPrisma([
      {
        id: 'b',
        deployedAt: null,
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: 'a',
      },
      {
        id: 'a',
        deployedAt: null,
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'b')
    expect(since).toBeNull()
  })

  it('breaks cycles defensively (visited-set guard)', async () => {
    // Buggy data: a → b → a. The walker MUST terminate.
    const prisma = akashPrisma([
      {
        id: 'a',
        deployedAt: T('2026-04-20T00:00:00Z'),
        failoverParentId: 'b',
        resumedFromId: null,
        parentDeploymentId: null,
      },
      {
        id: 'b',
        deployedAt: T('2026-04-21T00:00:00Z'),
        failoverParentId: 'a',
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'a')
    expect(since?.toISOString()).toBe('2026-04-20T00:00:00.000Z')
  })

  it('precedence: failoverParentId beats resumedFromId beats parentDeploymentId', async () => {
    // Row a has all three set — the walker should follow failoverParentId
    // first. The other two parents exist but should NOT be walked from a.
    const prisma = akashPrisma([
      {
        id: 'a',
        deployedAt: T('2026-04-24T10:00:00Z'),
        failoverParentId: 'failover-parent',
        resumedFromId: 'resume-parent',
        parentDeploymentId: 'queue-parent',
      },
      {
        id: 'failover-parent',
        deployedAt: T('2026-04-22T10:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
      {
        id: 'resume-parent',
        deployedAt: T('2026-04-15T10:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
      {
        id: 'queue-parent',
        deployedAt: T('2026-04-01T10:00:00Z'),
        failoverParentId: null,
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolveAkashActiveSince(prisma, 'a')
    expect(since?.toISOString()).toBe('2026-04-22T10:00:00.000Z')
  })
})

describe('resolvePhalaActiveSince', () => {
  const T = (s: string) => new Date(s)

  it('returns this row activeStartedAt when no parent chain', async () => {
    const prisma = phalaPrisma([
      {
        id: 'a',
        activeStartedAt: T('2026-04-20T10:00:00Z'),
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolvePhalaActiveSince(prisma, 'a')
    expect(since?.toISOString()).toBe('2026-04-20T10:00:00.000Z')
  })

  it('walks parentDeploymentId chain (queue retries)', async () => {
    const prisma = phalaPrisma([
      {
        id: 'b',
        activeStartedAt: T('2026-04-22T00:00:00Z'),
        resumedFromId: null,
        parentDeploymentId: 'a',
      },
      {
        id: 'a',
        activeStartedAt: T('2026-04-21T00:00:00Z'),
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolvePhalaActiveSince(prisma, 'b')
    expect(since?.toISOString()).toBe('2026-04-21T00:00:00.000Z')
  })

  it('walks resumedFromId (future-proof for Phala destroy+recreate resume)', async () => {
    const prisma = phalaPrisma([
      {
        id: 'b',
        activeStartedAt: T('2026-04-24T00:00:00Z'),
        resumedFromId: 'a',
        parentDeploymentId: null,
      },
      {
        id: 'a',
        activeStartedAt: T('2026-04-20T00:00:00Z'),
        resumedFromId: null,
        parentDeploymentId: null,
      },
    ])
    const since = await resolvePhalaActiveSince(prisma, 'b')
    expect(since?.toISOString()).toBe('2026-04-20T00:00:00.000Z')
  })
})
