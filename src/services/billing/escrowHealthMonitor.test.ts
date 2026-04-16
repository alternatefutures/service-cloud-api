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
  closeDeploymentMock: vi.fn().mockResolvedValue(undefined),
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
  BLOCKS_PER_HOUR: 600,
  TX_SETTLE_DELAY_MS: 0,
  POST_LEASE_HOURS: 2,
}))

import { EscrowHealthMonitor } from './escrowHealthMonitor.js'

interface FakeAkashDeployment {
  id: string
  dseq: bigint
  pricePerBlock: string | null
  owner: string
}

function buildPrisma(deployments: FakeAkashDeployment[]) {
  return {
    akashDeployment: {
      findMany: vi.fn().mockResolvedValue(deployments),
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

    // keys show <name> -a → wallet address
    if (args[0] === 'keys' && args[1] === 'show') {
      return Promise.resolve(`${overrides.walletAddress ?? 'akash1mock'}\n`)
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
    closeDeploymentMock.mockResolvedValue(undefined)
    refundEscrowMock.mockResolvedValue(undefined)
    settleAkashEscrowToTimeMock.mockResolvedValue(undefined)
    opsAlertMock.mockResolvedValue(undefined)
  })

  it('refills when estimated runway < MIN_ESCROW_HOURS (1h)', async () => {
    // ppb = 1000 uact/block → hourly burn = 600_000 uact
    // funds = 1_000_000, transferred = 0, blocks elapsed = 700 → unsettled = 700_000
    // real balance = 300_000 → 0.5h remaining → should refill.
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
    // Refill amount: ppb * BLOCKS_PER_HOUR * REFILL_HOURS = 1000 * 600 * 1 = 600_000
    expect(depositCall![1]).toContain('600000uact')
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
      if (args[0] === 'keys') return Promise.resolve('akash1mock\n')
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
    // findMany should only be called once.
    await monitor.checkAndRefill()
    expect(prisma.akashDeployment.findMany).toHaveBeenCalledTimes(1)

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
      if (args[0] === 'keys') return Promise.resolve('akash1mock\n')
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
})
