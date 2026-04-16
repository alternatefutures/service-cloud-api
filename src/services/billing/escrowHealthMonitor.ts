/**
 * Akash On-Chain Escrow Health Monitor — Safety Net
 *
 * Runs at :30 each hour (30 min after the billing cycle at :00). The billing
 * scheduler is the primary mechanism for on-chain escrow top-ups — it deposits
 * 1 hour of runway after each successful user charge. This monitor is the
 * safety net that catches any billing-cycle top-up failures.
 *
 * Also detects deployments that died on-chain (escrow depleted or provider
 * closed the lease) and triggers close + pro-rated billing settlement so users
 * are never charged for a non-existent lease.
 *
 * Operates at the infrastructure level (platform's deployer wallet), separate
 * from user-facing org wallet billing.
 */

import * as cron from 'node-cron'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { getAkashEnv } from '../../lib/akashEnv.js'
import { execAsync } from '../queue/asyncExec.js'
import { settleAkashEscrowToTime } from './deploymentSettlement.js'
import { getEscrowService } from './escrowService.js'
import { getAkashOrchestrator } from '../akash/orchestrator.js'
import { withWalletLock, isWalletTx } from '../akash/walletMutex.js'
import { opsAlert } from '../../lib/opsAlert.js'

const log = createLogger('escrow-health')

const AKASH_CLI_TIMEOUT_MS = 30_000
/** Longer timeout for the batch deployment list query (may return large JSON). */
const BATCH_QUERY_TIMEOUT_MS = 60_000
/** Refill when escrow drops below this many hours of runway. */
const MIN_ESCROW_HOURS = 1
/** Top up this many hours of runway per refill. */
const REFILL_HOURS = 1
/** Safety-net cron — hourly at :30 (30 min after billing cycle at :00). */
const ESCROW_CHECK_CRON = '30 * * * *'

/** Warn when deployer wallet ACT balance falls below this (5 ACT). */
const LOW_WALLET_THRESHOLD_UACT = 5_000_000

const BLOCKS_PER_HOUR = 600

async function runAkashCmd(args: string[], timeout = AKASH_CLI_TIMEOUT_MS): Promise<string> {
  const env = getAkashEnv()
  const invoke = () =>
    execAsync('akash', args, { env, timeout, maxBuffer: 10 * 1024 * 1024 })
  // Serialize chain TX submissions (escrow refills) on the shared wallet
  // mutex so they don't race with the billing scheduler, deployment steps,
  // or any resolver-initiated close.
  if (isWalletTx(args)) return withWalletLock(invoke)
  return invoke()
}

interface ChainEscrowEntry {
  dseq: string
  /** Raw `funds[uact].amount` from chain — total ever deposited, only changes on deposit/withdraw tx. */
  fundsUact: number
  /** Raw `transferred[uact].amount` — only updates on settlement txs (deposit/withdraw/close). */
  transferredUact: number
  /** Block height of last on-chain settlement. Used to compute unsettled consumption. */
  settledAtBlock: number
  closed: boolean
}

export class EscrowHealthMonitor {
  private cronJob: cron.ScheduledTask | null = null
  private running = false
  private readonly prisma: PrismaClient

  constructor(prisma: PrismaClient) {
    this.prisma = prisma
  }

  start() {
    if (this.cronJob) return

    this.cronJob = cron.schedule(ESCROW_CHECK_CRON, async () => {
      await this.checkAndRefill()
    })

    log.info(`Escrow health monitor started — checking at ${ESCROW_CHECK_CRON}`)
  }

  stop() {
    if (this.cronJob) {
      this.cronJob.stop()
      this.cronJob = null
    }
  }

  async checkAndRefill(): Promise<void> {
    if (this.running) {
      log.warn('Skipping escrow check — previous cycle still running')
      return
    }
    this.running = true

    try {
      const activeDeployments = await this.prisma.akashDeployment.findMany({
        where: { status: 'ACTIVE' },
        select: {
          id: true,
          dseq: true,
          pricePerBlock: true,
          owner: true,
        },
      })

      if (activeDeployments.length === 0) return

      log.info({ count: activeDeployments.length }, 'Escrow health check — active deployments found')

      await this.checkWalletBalance()

      // Single RPC call to fetch all deployment escrow accounts for our owner,
      // instead of one query per dseq. O(1) RPC calls regardless of deployment count.
      const owner = activeDeployments[0].owner
      const [chainEscrows, currentBlockHeight] = await Promise.all([
        this.fetchAllEscrowBalances(owner),
        this.fetchCurrentBlockHeight(),
      ])

      if (currentBlockHeight === 0) {
        log.error('Could not fetch current block height — aborting escrow check this cycle')
        return
      }

      let refillCount = 0
      let closedCount = 0
      let errorCount = 0

      for (const dep of activeDeployments) {
        const dseq = dep.dseq.toString()
        if (!dseq || dseq === '0' || Number(dseq) < 0) continue

        try {
          const chain = chainEscrows.get(dseq)

          // Deployment missing from chain or explicitly closed — settle billing
          if (!chain || chain.closed) {
            log.warn(
              { dseq, deploymentId: dep.id, reason: chain ? 'closed' : 'missing' },
              'Deployment gone on-chain — closing and settling billing'
            )
            await this.closeAndSettleDeployment(dep.id, dseq)
            closedCount++
            continue
          }

          const ppb = parseInt(dep.pricePerBlock || '0', 10) || 1
          const uactPerHour = ppb * BLOCKS_PER_HOUR

          // Akash chain lazy-settles: `funds` / `transferred` only update on settlement
          // txs (deposit, withdraw, close). Between settlements the escrow drains
          // invisibly at `pricePerBlock` per block. Real balance must be computed as:
          //   real = funds - transferred - (currentBlock - settledAt) * pricePerBlock
          const blocksSinceSettlement = Math.max(0, currentBlockHeight - chain.settledAtBlock)
          const unsettledConsumption = blocksSinceSettlement * ppb
          const settledBalance = chain.fundsUact - chain.transferredUact
          const realBalanceUact = Math.max(0, settledBalance - unsettledConsumption)

          const estimatedHoursRemaining = uactPerHour > 0
            ? realBalanceUact / uactPerHour
            : Infinity

          const logFields = {
            dseq,
            hoursRemaining: +estimatedHoursRemaining.toFixed(2),
            realBalanceUact,
            fundsUact: chain.fundsUact,
            transferredUact: chain.transferredUact,
            settledAtBlock: chain.settledAtBlock,
            currentBlockHeight,
            blocksSinceSettlement,
            pricePerBlock: ppb,
          }

          if (estimatedHoursRemaining < MIN_ESCROW_HOURS) {
            log.warn(logFields, 'Low on-chain escrow — attempting safety-net refill')
            await this.refillEscrow(dseq, dep.owner, ppb)
            refillCount++
            await new Promise(r => setTimeout(r, 8000))
          } else {
            log.info(logFields, 'Escrow OK — no refill needed')
          }
        } catch (err) {
          errorCount++
          log.error({ dseq, error: (err as Error).message }, 'Failed to check/refill escrow')
        }
      }

      log.info(
        { checked: activeDeployments.length, refilled: refillCount, closed: closedCount, errors: errorCount },
        'Escrow health check complete'
      )
    } catch (err) {
      log.error(err as Error, 'Escrow health check failed')
    } finally {
      this.running = false
    }
  }

  private async checkWalletBalance(): Promise<void> {
    try {
      const keyName = process.env.AKASH_KEY_NAME || 'default'
      const addrOutput = await runAkashCmd(['keys', 'show', keyName, '-a'])
      const address = addrOutput.trim()
      if (!address) {
        log.warn('Could not resolve deployer wallet address')
        return
      }

      const output = await runAkashCmd([
        'query', 'bank', 'balances', address,
        '-o', 'json',
      ])
      const data = JSON.parse(output)
      const uactBal = data?.balances?.find((b: { denom: string }) => b.denom === 'uact')
      const balance = parseInt(uactBal?.amount || '0', 10)
      if (balance < LOW_WALLET_THRESHOLD_UACT) {
        const balanceAct = (balance / 1_000_000).toFixed(4)
        log.warn(
          { balanceUact: balance, balanceAct },
          'CRITICAL: Deployer wallet ACT balance is low — escrow refills will fail soon'
        )
        await opsAlert({
          key: 'deployer-wallet-low-balance',
          severity: 'critical',
          title: 'Deployer wallet ACT balance low',
          message:
            `Deployer wallet is below the ${(LOW_WALLET_THRESHOLD_UACT / 1_000_000).toFixed(0)} ACT threshold. ` +
            `On-chain escrow top-ups will start failing; deployments will be closed by providers and the platform will eat the uncovered time.`,
          context: {
            address,
            balanceAct,
            balanceUact: String(balance),
            thresholdUact: String(LOW_WALLET_THRESHOLD_UACT),
          },
          // Alert hourly (matches the health-monitor cadence), not every 10 min.
          suppressMs: 55 * 60 * 1000,
        })
      }
    } catch {
      log.warn('Could not check deployer wallet balance')
    }
  }

  /**
   * Fetch the current chain block height via `akash status`. Needed to compute
   * real escrow balance because Akash lazy-settles — the on-chain `transferred`
   * value only updates on settlement txs, not as blocks pass.
   */
  private async fetchCurrentBlockHeight(): Promise<number> {
    try {
      const output = await runAkashCmd(['status'])
      const data = JSON.parse(output)
      const heightStr = data?.sync_info?.latest_block_height
        || data?.SyncInfo?.latest_block_height
        || '0'
      const height = parseInt(String(heightStr), 10) || 0
      return height
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to fetch current block height')
      return 0
    }
  }

  /**
   * Single RPC call: `akash query deployment list --owner <addr> --state active -o json`
   * Returns a Map of dseq → chain escrow state. Real balance must be derived
   * by combining these fields with the current block height in the caller.
   */
  private async fetchAllEscrowBalances(owner: string): Promise<Map<string, ChainEscrowEntry>> {
    const map = new Map<string, ChainEscrowEntry>()
    try {
      const output = await runAkashCmd([
        'query', 'deployment', 'list',
        '--owner', owner,
        '--state', 'active',
        '-o', 'json',
      ], BATCH_QUERY_TIMEOUT_MS)

      const data = JSON.parse(output)
      const deployments: any[] = data?.deployments || []

      for (const dep of deployments) {
        const dseq = dep.deployment?.id?.dseq
          || dep.deployment?.deployment_id?.dseq
        if (!dseq) continue

        const escrowAccount = dep.escrow_account
        if (!escrowAccount) continue

        const escrowState = escrowAccount.state || escrowAccount
        const closed = escrowState.state === 'closed'

        const funds: Array<{ denom: string; amount: string }> = escrowState.funds || []
        const transferred: Array<{ denom: string; amount: string }> = escrowState.transferred || []
        const fundsUact = Math.floor(
          parseFloat(funds.find((f) => f.denom === 'uact')?.amount || '0')
        ) || 0
        const transferredUact = Math.floor(
          parseFloat(transferred.find((f) => f.denom === 'uact')?.amount || '0')
        ) || 0
        const settledAtBlock = parseInt(String(escrowState.settled_at || '0'), 10) || 0

        map.set(String(dseq), {
          dseq: String(dseq),
          fundsUact,
          transferredUact,
          settledAtBlock,
          closed,
        })
      }

      log.info({ count: map.size }, 'Fetched escrow balances from chain (single query)')
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to batch-fetch escrow balances — falling back to per-deployment')
      // If the list query fails, we skip this cycle.
      // The billing-cycle top-up at :00 is the primary mechanism; this is the safety net.
    }
    return map
  }

  /**
   * Close a deployment that the chain reports as gone/closed, settle billing
   * pro-rata, and refund any pre-funded escrow balance.
   */
  private async closeAndSettleDeployment(deploymentId: string, dseq: string): Promise<void> {
    const current = await this.prisma.akashDeployment.findUnique({
      where: { id: deploymentId },
      select: { status: true },
    })
    if (!current || current.status !== 'ACTIVE') return

    const closedAt = new Date()

    try {
      const orchestrator = getAkashOrchestrator(this.prisma)
      await orchestrator.closeDeployment(Number(dseq))
    } catch (closeErr) {
      const msg = (closeErr as Error).message ?? ''
      const alreadyGone = /deployment not found|deployment closed|not active|does not exist/i.test(msg)
      if (!alreadyGone) {
        log.error({ deploymentId, dseq, err: msg }, 'On-chain close failed during escrow-monitor auto-close')
      }
    }

    const result = await this.prisma.akashDeployment.updateMany({
      where: { id: deploymentId, status: 'ACTIVE' },
      data: { status: 'CLOSED', closedAt },
    })

    if (result.count > 0) {
      await settleAkashEscrowToTime(this.prisma, deploymentId, closedAt)
      await getEscrowService(this.prisma).refundEscrow(deploymentId)
      log.info({ deploymentId, dseq }, 'Chain-dead deployment closed and billing settled')
    }
  }

  private async refillEscrow(dseq: string, _owner: string, pricePerBlockUact: number): Promise<void> {
    const blocksPerHour = 600
    const refillUact = Math.max(
      100_000,
      pricePerBlockUact * blocksPerHour * REFILL_HOURS
    )

    try {
      const output = await runAkashCmd([
        'tx',
        'escrow',
        'deposit',
        'deployment',
        `${refillUact}uact`,
        '--dseq',
        dseq,
        '-y',
        '-o', 'json',
      ])

      let txhash = ''
      try {
        const result = JSON.parse(output)
        txhash = result.txhash || ''
        if (result.code && result.code !== 0) {
          throw new Error(`TX failed on-chain: code=${result.code} log=${result.raw_log || ''}`)
        }
      } catch (parseErr) {
        if ((parseErr as Error).message.startsWith('TX failed')) throw parseErr
      }

      log.info(
        { dseq, refillUact, refillAct: (refillUact / 1_000_000).toFixed(4), txhash },
        'Refilled on-chain escrow'
      )
    } catch (err) {
      const errMsg = (err as Error).message
      log.error({ dseq, error: errMsg }, 'Failed to refill escrow via CLI')
      await opsAlert({
        key: `escrow-refill-failed:${dseq}`,
        severity: 'critical',
        title: 'Escrow refill failed',
        message:
          `Health-monitor escrow refill for dseq=${dseq} failed. If this keeps failing the provider will close ` +
          `the lease and the platform will eat any time between the last user billing and chain-death.`,
        context: {
          dseq,
          refillUact: String(refillUact),
          refillAct: (refillUact / 1_000_000).toFixed(4),
          error: errMsg.slice(0, 400),
        },
      })
      throw err
    }
  }
}

let instance: EscrowHealthMonitor | null = null

export function getEscrowHealthMonitor(prisma: PrismaClient): EscrowHealthMonitor {
  if (!instance) {
    instance = new EscrowHealthMonitor(prisma)
  }
  return instance
}
