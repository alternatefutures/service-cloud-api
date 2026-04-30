import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted so the mock factories can reference them (vi.mock is hoisted to
// the top of the file, above non-hoisted `const` declarations).
const {
  execAsyncMock,
  closeDeploymentMock,
  refundEscrowMock,
  settleAkashEscrowToTimeMock,
  opsAlertMock,
} = vi.hoisted(() => ({
  execAsyncMock: vi.fn(),
  closeDeploymentMock: vi
    .fn()
    .mockResolvedValue({ chainStatus: 'CLOSED', txhash: 'mock-tx' }),
  refundEscrowMock: vi.fn().mockResolvedValue(undefined),
  settleAkashEscrowToTimeMock: vi.fn().mockResolvedValue(undefined),
  opsAlertMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../queue/asyncExec.js', () => ({
  execAsync: execAsyncMock,
}))

vi.mock('../../lib/akashEnv.js', () => ({
  getAkashEnv: vi.fn(() => ({
    AKASH_FROM: 'test-key',
    AKASH_KEY_NAME: 'test-key',
    AKASH_NODE: 'https://rpc.test',
    AKASH_CHAIN_ID: 'akashnet-2',
  })),
}))

vi.mock('../akash/orchestrator.js', () => ({
  getAkashOrchestrator: vi.fn(() => ({
    closeDeployment: closeDeploymentMock,
  })),
}))

vi.mock('./escrowService.js', () => ({
  getEscrowService: vi.fn(() => ({
    refundEscrow: refundEscrowMock,
  })),
}))

vi.mock('./deploymentSettlement.js', () => ({
  settleAkashEscrowToTime: settleAkashEscrowToTimeMock,
}))

vi.mock('../../lib/opsAlert.js', () => ({
  opsAlert: opsAlertMock,
}))

vi.mock('../../config/akash.js', () => ({
  BLOCKS_PER_HOUR: 588,
  BLOCKS_PER_DAY: 14_124,
  BLOCKS_PER_MONTH: 429_909,
  AKASH_SECONDS_PER_BLOCK: 6.117,
  TX_SETTLE_DELAY_MS: 0,
  POST_LEASE_HOURS: 2,
}))

import { EscrowHealthMonitor } from './escrowHealthMonitor.js'

function enableChainOrphanSweep() {
  process.env.AKASH_ALLOW_CHAIN_ORPHAN_SWEEP = '1'
}

interface FakeAkashDeployment {
  id: string
  dseq: bigint
  pricePerBlock: string | null
  owner: string
}

/**
 * `deployments` represents the ACTIVE rows used by the refill loop.
 * `nonActiveRows` represents additional rows we've recorded in any
 * non-ACTIVE state. The orphan sweep now needs the {status, id} pair to
 * decide whether a chain-active dseq should be left alone (mid-flow on
 * chain) or closed (DB says lease is supposed to be gone — escrow leak).
 */
function buildPrisma(
  deployments: FakeAkashDeployment[],
  nonActiveRows: Array<{ id: string; dseq: bigint; status: string }> = [],
) {
  return {
    akashDeployment: {
      findMany: vi.fn().mockImplementation(({ where, select }: any = {}) => {
        // First call: ACTIVE-only with full select for refill loop.
        if (where?.status === 'ACTIVE') return Promise.resolve(deployments)
        // Second call: every known row (no filter) projected with
        // {dseq, status, id} for the orphan-sweep classifier.
        if (select?.dseq && select?.status && !where) {
          const all = [
            ...deployments.map(d => ({ dseq: d.dseq, status: 'ACTIVE', id: d.id })),
            ...nonActiveRows.map(r => ({ dseq: r.dseq, status: r.status, id: r.id })),
          ]
          return Promise.resolve(all)
        }
        if (select?.dseq && !where) {
          // Backwards-compat for any caller still requesting only dseq.
          const all = [
            ...deployments.map(d => ({ dseq: d.dseq })),
            ...nonActiveRows.map(r => ({ dseq: r.dseq })),
          ]
          return Promise.resolve(all)
        }
        return Promise.resolve([])
      }),
      findUnique: vi.fn().mockImplementation(({ where }) => {
        const d = deployments.find(x => x.id === where.id)
        return Promise.resolve(d ? { status: 'ACTIVE' } : null)
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as any
}

/**
 * Mock `execAsync` by inspecting its args. Each arg-pattern returns a
 * fixed JSON string, the way the real `akash` CLI would.
 */
function installAkashCli(overrides: {
  blockHeight?: number
  walletAddress?: string
  walletUactBalance?: number
  listDeployments?: Array<{
    dseq: string
    fundsUact: number
    transferredUact: number
    settledAt: number
    closed?: boolean
  }>
  depositShouldFail?: string
}) {
  execAsyncMock.mockReset()
  execAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
    // status → latest_block_height
    if (args[0] === 'status') {
      return Promise.resolve(
        JSON.stringify({
          sync_info: { latest_block_height: String(overrides.blockHeight ?? 1_000_000) },
        }),
      )
    }

    // keys show <name> -a → wallet address.
    // Default to `akash1owner` so it matches the standard test fixture's
    // AkashDeployment.owner field (the new owner-validation guard requires
    // these to match — see "SAFETY: bails out on owner mismatch" test).
    if (args[0] === 'keys' && args[1] === 'show') {
      return Promise.resolve(`${overrides.walletAddress ?? 'akash1owner'}\n`)
    }

    // query bank balances → wallet ACT balance
    if (args[0] === 'query' && args[1] === 'bank' && args[2] === 'balances') {
      return Promise.resolve(
        JSON.stringify({
          balances: [
            { denom: 'uact', amount: String(overrides.walletUactBalance ?? 100_000_000) },
          ],
        }),
      )
    }

    // query deployment list → escrow account listing
    if (args[0] === 'query' && args[1] === 'deployment' && args[2] === 'list') {
      return Promise.resolve(
        JSON.stringify({
          deployments: (overrides.listDeployments ?? []).map(d => ({
            deployment: { deployment_id: { dseq: d.dseq } },
            escrow_account: {
              state: {
                state: d.closed ? 'closed' : 'open',
                funds: [{ denom: 'uact', amount: String(d.fundsUact) }],
                transferred: [{ denom: 'uact', amount: String(d.transferredUact) }],
                settled_at: String(d.settledAt),
              },
            },
          })),
        }),
      )
    }

    // tx escrow deposit → refill
    if (args[0] === 'tx' && args[1] === 'escrow' && args[2] === 'deposit') {
      if (overrides.depositShouldFail) {
        return Promise.reject(new Error(overrides.depositShouldFail))
      }
      return Promise.resolve(JSON.stringify({ code: 0, txhash: 'abc123' }))
    }

    return Promise.resolve('{}')
  })
}

describe('EscrowHealthMonitor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AKASH_ALLOW_CHAIN_ORPHAN_SWEEP
    closeDeploymentMock.mockResolvedValue({ chainStatus: 'CLOSED', txhash: 'mock-tx' })
    refundEscrowMock.mockResolvedValue(undefined)
    settleAkashEscrowToTimeMock.mockResolvedValue(undefined)
    opsAlertMock.mockResolvedValue(undefined)
  })

  it('refills when estimated runway < MIN_ESCROW_HOURS (1h)', async () => {
    // ppb = 1000 uact/block → hourly burn = 588_000 uact (BLOCKS_PER_HOUR=588)
    // funds = 1_000_000, transferred = 0, blocks elapsed = 700 → unsettled = 700_000
    // real balance = 300_000 → ~0.51h remaining → should refill.
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_700,
      listDeployments: [
        { dseq: '100', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
      ],
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    // Find the tx escrow deposit call
    const depositCall = execAsyncMock.mock.calls.find(
      c => c[1][0] === 'tx' && c[1][1] === 'escrow' && c[1][2] === 'deposit',
    )
    expect(depositCall).toBeDefined()
    // Refill amount: ppb * BLOCKS_PER_HOUR * REFILL_HOURS = 1000 * 588 * 1 = 588_000
    expect(depositCall![1]).toContain('588000uact')
    expect(depositCall![1]).toContain('--dseq')
    expect(depositCall![1]).toContain('100')
  })

  it('does NOT refill when estimated runway >= 1h', async () => {
    // funds = 10_000_000, transferred = 0, blocks elapsed = 100 → unsettled = 100_000
    // real balance = 9_900_000 → ~16.5h → plenty of runway.
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_100,
      listDeployments: [
        { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_000 },
      ],
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    const depositCall = execAsyncMock.mock.calls.find(
      c => c[1][0] === 'tx' && c[1][1] === 'escrow' && c[1][2] === 'deposit',
    )
    expect(depositCall).toBeUndefined()
  })

  it('computes real balance accounting for unsettled consumption (lazy settlement)', async () => {
    // This test proves we subtract (currentBlock - settledAt) * ppb from
    // (funds - transferred). Without that subtraction, a deployment with
    // settled funds=10m and transferred=0 would look like ~16h of runway,
    // but in reality 9_999 blocks have passed at ppb=1000 → 9.99m unsettled →
    // real balance = 10_000 → < 1h → refill required.
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_009_999,
      listDeployments: [
        { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_000 },
      ],
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    const depositCall = execAsyncMock.mock.calls.find(
      c => c[1][0] === 'tx' && c[1][1] === 'escrow' && c[1][2] === 'deposit',
    )
    expect(depositCall).toBeDefined()
  })

  it('closes and settles deployments missing from chain', async () => {
    // DB says ACTIVE but chain has no record → auto-close and settle.
    const prisma = buildPrisma([
      { id: 'a1', dseq: 999n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_000,
      listDeployments: [], // chain returns no deployments
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    expect(closeDeploymentMock).toHaveBeenCalledWith(999)
    expect(settleAkashEscrowToTimeMock).toHaveBeenCalledWith(
      prisma,
      'a1',
      expect.any(Date),
    )
    expect(refundEscrowMock).toHaveBeenCalledWith('a1')
    expect(prisma.akashDeployment.updateMany).toHaveBeenCalledWith({
      where: { id: 'a1', status: 'ACTIVE' },
      data: { status: 'CLOSED', closedAt: expect.any(Date) },
    })
  })

  it('closes and settles deployments explicitly closed on chain', async () => {
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_000,
      listDeployments: [
        {
          dseq: '100',
          fundsUact: 5_000_000,
          transferredUact: 0,
          settledAt: 1_000_000,
          closed: true,
        },
      ],
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    expect(closeDeploymentMock).toHaveBeenCalledWith(100)
    expect(refundEscrowMock).toHaveBeenCalledWith('a1')
  })

  it('prevents concurrent runs with the reentrancy guard', async () => {
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])

    // Make fetchAllEscrowBalances hang, forcing the first call to stay running.
    let resolveFirstList: (v: string) => void = () => {}
    const firstListPromise = new Promise<string>(resolve => {
      resolveFirstList = resolve
    })

    let listCallCount = 0
    execAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'query' && args[1] === 'deployment' && args[2] === 'list') {
        listCallCount++
        if (listCallCount === 1) return firstListPromise
        return Promise.resolve(JSON.stringify({ deployments: [] }))
      }
      if (args[0] === 'status') {
        return Promise.resolve(
          JSON.stringify({ sync_info: { latest_block_height: '1000000' } }),
        )
      }
      if (args[0] === 'keys') return Promise.resolve('akash1owner\n')
      if (args[0] === 'query' && args[1] === 'bank') {
        return Promise.resolve(
          JSON.stringify({ balances: [{ denom: 'uact', amount: '100000000' }] }),
        )
      }
      return Promise.resolve('{}')
    })

    const monitor = new EscrowHealthMonitor(prisma)
    const run1 = monitor.checkAndRefill()

    // Second call while the first is in flight → should bail out immediately.
    // findMany is called twice per cycle (once for ACTIVE, once for all-known
    // dseqs in the orphan exclusion set), so a single completed cycle = 2.
    await monitor.checkAndRefill()
    expect(prisma.akashDeployment.findMany).toHaveBeenCalledTimes(2)

    // Now release the first run.
    resolveFirstList(JSON.stringify({ deployments: [] }))
    await run1
  })

  it('alerts when deployer wallet balance is below threshold', async () => {
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_000,
      walletUactBalance: 1_000_000, // 1 ACT, below 5 ACT threshold
      listDeployments: [
        { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_000 },
      ],
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    const lowWalletAlert = opsAlertMock.mock.calls.find(
      c => c[0]?.key === 'deployer-wallet-low-balance',
    )
    expect(lowWalletAlert).toBeDefined()
    expect(lowWalletAlert![0].severity).toBe('critical')
  })

  it('does NOT alert when deployer wallet balance is healthy', async () => {
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_000,
      walletUactBalance: 50_000_000, // 50 ACT
      listDeployments: [
        { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_000 },
      ],
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    const lowWalletAlert = opsAlertMock.mock.calls.find(
      c => c[0]?.key === 'deployer-wallet-low-balance',
    )
    expect(lowWalletAlert).toBeUndefined()
  })

  it('alerts when a refill TX fails', async () => {
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    installAkashCli({
      blockHeight: 1_000_700,
      listDeployments: [
        { dseq: '100', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
      ],
      depositShouldFail: 'insufficient funds',
    })

    const monitor = new EscrowHealthMonitor(prisma)
    await monitor.checkAndRefill()

    const refillAlert = opsAlertMock.mock.calls.find(c =>
      (c[0]?.key ?? '').startsWith('escrow-refill-failed:'),
    )
    expect(refillAlert).toBeDefined()
    expect(refillAlert![0].severity).toBe('critical')
    expect(refillAlert![0].context?.dseq).toBe('100')
  })

  it('handles batch query failure gracefully (no crash, no refills)', async () => {
    const prisma = buildPrisma([
      { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
    ])
    execAsyncMock.mockReset()
    execAsyncMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'status') {
        return Promise.resolve(
          JSON.stringify({ sync_info: { latest_block_height: '1000000' } }),
        )
      }
      if (args[0] === 'keys') return Promise.resolve('akash1owner\n')
      if (args[0] === 'query' && args[1] === 'bank') {
        return Promise.resolve(
          JSON.stringify({ balances: [{ denom: 'uact', amount: '100000000' }] }),
        )
      }
      if (args[0] === 'query' && args[1] === 'deployment' && args[2] === 'list') {
        return Promise.reject(new Error('RPC unavailable'))
      }
      return Promise.resolve('{}')
    })

    const monitor = new EscrowHealthMonitor(prisma)

    // Must not throw; the empty chain map means all deployments look
    // "missing" → auto-close fires. That's a separate branch we cover
    // elsewhere; here we just care that the method completes cleanly.
    await expect(monitor.checkAndRefill()).resolves.not.toThrow()
  })

  describe('chain-orphan sweep', () => {
    it('SAFETY: skips destructive orphan sweep by default', async () => {
      const prisma = buildPrisma([])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).not.toHaveBeenCalled()
      const orphanAlert = opsAlertMock.mock.calls.find(
        c => (c[0]?.key ?? '').startsWith('chain-orphan-closed:'),
      )
      expect(orphanAlert).toBeUndefined()
    })

    it('closes a chain deployment that has no DB row and is older than the age threshold', async () => {
      enableChainOrphanSweep()
      // DB has dseq 100 ACTIVE; chain has 100 + 999. 999 is the orphan.
      // settledAt = 1_000_000, blockHeight = 1_000_700 → ageBlocks = 700 > 600 threshold.
      const prisma = buildPrisma([
        { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
      ])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_600 },
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      // Tracked dseq 100 must NOT be closed (it's healthy and in DB).
      expect(closeDeploymentMock).not.toHaveBeenCalledWith(100)
      // Orphan dseq 999 must be closed.
      expect(closeDeploymentMock).toHaveBeenCalledWith(999)

      // We must NOT settle billing for an orphan — there's no DB row /
      // user to settle against. settleAkashEscrowToTime takes a deploymentId
      // and would fail or charge the wrong account.
      expect(settleAkashEscrowToTimeMock).not.toHaveBeenCalled()
      expect(refundEscrowMock).not.toHaveBeenCalled()

      const orphanAlert = opsAlertMock.mock.calls.find(
        c => c[0]?.key === 'chain-orphan-closed:999',
      )
      expect(orphanAlert).toBeDefined()
      expect(orphanAlert![0].severity).toBe('warning')
    })

    it('skips chain deployments younger than the age threshold (race protection)', async () => {
      enableChainOrphanSweep()
      // settledAt = 1_000_500, blockHeight = 1_000_700 → ageBlocks = 200 < 600.
      // This is the case where a deployment was just created and the queue
      // worker hasn't written the DB row yet (or a probe-bid is mid-flight).
      const prisma = buildPrisma([
        { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
      ])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_600 },
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_500 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).not.toHaveBeenCalledWith(999)
      const orphanAlert = opsAlertMock.mock.calls.find(
        c => (c[0]?.key ?? '').startsWith('chain-orphan-closed:'),
      )
      expect(orphanAlert).toBeUndefined()
    })

    it('skips chain entries that are already closed on-chain', async () => {
      enableChainOrphanSweep()
      // Orphan that's already `closed: true` on chain — nothing to do, the
      // escrow is already being settled by the chain itself.
      const prisma = buildPrisma([
        { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
      ])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_600 },
          {
            dseq: '999',
            fundsUact: 1_000_000,
            transferredUact: 0,
            settledAt: 1_000_000,
            closed: true,
          },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).not.toHaveBeenCalledWith(999)
    })

    it('runs the sweep even when DB has zero ACTIVE rows (orphan-only case)', async () => {
      enableChainOrphanSweep()
      // This is the bug from the screenshot: production cloud-api had no
      // ACTIVE deployments in the DB but a chain orphan still existed.
      // The previous early-return-on-empty meant we never even queried chain.
      const prisma = buildPrisma([])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).toHaveBeenCalledWith(999)
    })

    it('does not close anything when chain matches DB exactly', async () => {
      enableChainOrphanSweep()
      const prisma = buildPrisma([
        { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1owner' },
        { id: 'a2', dseq: 200n, pricePerBlock: '1000', owner: 'akash1owner' },
      ])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '100', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_600 },
          { dseq: '200', fundsUact: 10_000_000, transferredUact: 0, settledAt: 1_000_600 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).not.toHaveBeenCalled()
      const orphanAlert = opsAlertMock.mock.calls.find(
        c => (c[0]?.key ?? '').startsWith('chain-orphan-closed:'),
      )
      expect(orphanAlert).toBeUndefined()
    })

    it('SAFETY: bails out on owner mismatch (DB corruption defense)', async () => {
      // If an ACTIVE row's `owner` differs from the deployer wallet that
      // `keys show -a` resolves to, the entire cycle (refill + sweep) must
      // skip — running the chain query against the wrong wallet would mean
      // either (a) closing nothing real (chain rejects unknown signer), or
      // (b) missing real orphans on our actual deployer wallet.
      const prisma = buildPrisma([
        { id: 'a1', dseq: 100n, pricePerBlock: '1000', owner: 'akash1corrupted' },
      ])
      installAkashCli({
        blockHeight: 1_000_700,
        walletAddress: 'akash1real',
        listDeployments: [
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).not.toHaveBeenCalled()

      const mismatchAlert = opsAlertMock.mock.calls.find(
        c => c[0]?.key === 'escrow-monitor-owner-mismatch',
      )
      expect(mismatchAlert).toBeDefined()
      expect(mismatchAlert![0].severity).toBe('critical')
      expect(mismatchAlert![0].context?.dbOwner).toBe('akash1corrupted')
      expect(mismatchAlert![0].context?.resolvedDeployerAddress).toBe('akash1real')
    })

    it('SAFETY: protects chain dseqs whose DB row is mid-flight (CREATING/WAITING_BIDS/…/DEPLOYING)', async () => {
      enableChainOrphanSweep()
      // The sweep MUST never close a row that's mid-flow on chain — closing
      // races the queue worker and would destroy a real user workload that
      // hasn't reached ACTIVE yet.
      const prisma = buildPrisma(
        [], // no ACTIVE rows
        [
          { id: 'r150', dseq: 150n, status: 'CREATING' },
          { id: 'r151', dseq: 151n, status: 'WAITING_BIDS' },
          { id: 'r152', dseq: 152n, status: 'SELECTING_BID' },
          { id: 'r153', dseq: 153n, status: 'CREATING_LEASE' },
          { id: 'r154', dseq: 154n, status: 'SENDING_MANIFEST' },
          { id: 'r155', dseq: 155n, status: 'DEPLOYING' },
        ],
      )

      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '150', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
          { dseq: '151', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
          { dseq: '152', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
          { dseq: '153', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
          { dseq: '154', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
          { dseq: '155', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
          // The actual orphan — proves the sweep DOES still fire when it should.
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      for (const protectedDseq of [150, 151, 152, 153, 154, 155]) {
        expect(closeDeploymentMock).not.toHaveBeenCalledWith(protectedDseq)
      }
      expect(closeDeploymentMock).toHaveBeenCalledWith(999)
      expect(closeDeploymentMock).toHaveBeenCalledTimes(1)
    })

    it('LEAK FIX: closes chain leases whose DB row is SUSPENDED (suspendOrgHandler chain-close failure)', async () => {
      enableChainOrphanSweep()
      // Reproduces the silent escrow burner: suspendOrgHandler tried to
      // close on-chain at suspend time, the chain close didn't take, but
      // the DB row was marked SUSPENDED anyway. Pre-fix the sweep skipped
      // these (because dseq was "known"); now we close them.
      const prisma = buildPrisma(
        [],
        [{ id: 'r1', dseq: 153n, status: 'SUSPENDED' }],
      )
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '153', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).toHaveBeenCalledWith(153)

      const alert = opsAlertMock.mock.calls.find(c => c[0]?.key === 'chain-orphan-closed:153')
      expect(alert).toBeDefined()
      expect(alert![0].context?.leakReason).toBe('db_suspended')
      expect(alert![0].context?.dbStatus).toBe('SUSPENDED')

      // Idempotent DB sync: SUSPENDED → CLOSED so the next pass doesn't
      // re-flag the same row.
      expect(prisma.akashDeployment.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'r1' }),
          data: expect.objectContaining({ status: 'CLOSED' }),
        }),
      )
    })

    it('LEAK FIX: closes chain leases whose DB row is CLOSE_FAILED (close-tx retry)', async () => {
      enableChainOrphanSweep()
      const prisma = buildPrisma(
        [],
        [{ id: 'r1', dseq: 154n, status: 'CLOSE_FAILED' }],
      )
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '154', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).toHaveBeenCalledWith(154)
      const alert = opsAlertMock.mock.calls.find(c => c[0]?.key === 'chain-orphan-closed:154')
      expect(alert).toBeDefined()
      expect(alert![0].context?.leakReason).toBe('db_terminal')
    })

    it('LEAK FIX: closes chain leases whose DB row is CLOSED but chain still open', async () => {
      enableChainOrphanSweep()
      // Pure mismatch: DB committed CLOSED but chain didn't receive / accept
      // the close. Pre-fix this leaked forever.
      const prisma = buildPrisma(
        [],
        [{ id: 'r1', dseq: 200n, status: 'CLOSED' }],
      )
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '200', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).toHaveBeenCalledWith(200)
      const alert = opsAlertMock.mock.calls.find(c => c[0]?.key === 'chain-orphan-closed:200')
      expect(alert).toBeDefined()
      expect(alert![0].context?.leakReason).toBe('db_terminal')
    })

    it('does not alert when on-chain close fails (will retry next cycle)', async () => {
      enableChainOrphanSweep()
      const prisma = buildPrisma([])
      installAkashCli({
        blockHeight: 1_000_700,
        listDeployments: [
          { dseq: '999', fundsUact: 1_000_000, transferredUact: 0, settledAt: 1_000_000 },
        ],
      })
      closeDeploymentMock.mockResolvedValueOnce({
        chainStatus: 'FAILED',
        error: 'rpc timeout',
      })

      const monitor = new EscrowHealthMonitor(prisma)
      await monitor.checkAndRefill()

      expect(closeDeploymentMock).toHaveBeenCalledWith(999)
      const orphanAlert = opsAlertMock.mock.calls.find(
        c => (c[0]?.key ?? '').startsWith('chain-orphan-closed:'),
      )
      expect(orphanAlert).toBeUndefined()
    })
  })
})
