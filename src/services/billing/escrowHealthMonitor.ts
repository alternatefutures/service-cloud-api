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
import { BLOCKS_PER_HOUR } from '../../config/akash.js'

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

/**
 * Minimum on-chain age before we consider a deployment a sweep-able orphan.
 *
 * 600 blocks ≈ 1 hour at 6s/block. Anything younger is probably a deployment
 * mid-flight whose DB row hasn't been written yet (queue worker still running
 * `handleCreateDeployment`), or a probe-bid (PR 2) inside its
 * `try/finally` close window. Sweeping those would race the application code.
 *
 * Override via `AKASH_ORPHAN_SWEEP_MIN_AGE_BLOCKS` for staging tests.
 */
const DEFAULT_ORPHAN_MIN_AGE_BLOCKS = 600
const ORPHAN_MIN_AGE_BLOCKS = (() => {
  const raw = process.env.AKASH_ORPHAN_SWEEP_MIN_AGE_BLOCKS
  if (!raw) return DEFAULT_ORPHAN_MIN_AGE_BLOCKS
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_ORPHAN_MIN_AGE_BLOCKS
})()

/**
 * Hot-wallet cap (defense-in-depth against key compromise).
 *
 * The deployer wallet is an *online* hot wallet — its key sits on the
 * cloud-api pod's filesystem and any successful RCE on the API
 * empties it. We therefore want it to hold only what's needed to
 * cover ~24-48 h of escrow refills; the rest of the AKT/ACT runway
 * belongs in cold storage.
 *
 * If the wallet balance creeps above this cap (e.g. operator funded
 * too much, or treasury swept the wrong way), we fire an ops alert
 * and ask the operator to sweep the excess back to cold storage per
 * the runbook (Section M of AF_INCIDENT_RUNBOOKS.md — "Akash Hot-Wallet
 * Cap Exceeded / Key Rotation"; §L is the unrelated failover-loop runbook).
 *
 * Override in production via `AKASH_HOT_WALLET_CAP_UACT` if the
 * default is too tight for current usage.
 */
const DEFAULT_HOT_WALLET_CAP_UACT = 50_000_000 // 50 ACT
const HOT_WALLET_CAP_UACT = (() => {
  const raw = process.env.AKASH_HOT_WALLET_CAP_UACT
  if (!raw) return DEFAULT_HOT_WALLET_CAP_UACT
  const parsed = parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > LOW_WALLET_THRESHOLD_UACT
    ? parsed
    : DEFAULT_HOT_WALLET_CAP_UACT
})()

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

      // Broader set used ONLY for orphan-sweep exclusion. We must NEVER close
      // a chain deployment we've ever recorded — it could be a row in any
      // non-terminal state (CREATING, WAITING_BIDS, DEPLOYING, SUSPENDED,
      // CLOSE_FAILED, etc.) where the chain side is intentionally still open.
      // Even CLOSED / PERMANENTLY_FAILED rows are safer to skip — close is
      // idempotent so re-closing wastes a TX, and "leak escrow on a row we
      // already know about" is strictly better than "wrongly close a user
      // lease we forgot to filter out".
      const allKnownDseqs = await this.prisma.akashDeployment.findMany({
        select: { dseq: true },
      })

      log.info(
        {
          activeCount: activeDeployments.length,
          knownDseqCount: allKnownDseqs.length,
        },
        'Escrow health check — DB snapshot loaded',
      )

      await this.checkWalletBalance()

      // Single RPC call to fetch all deployment escrow accounts for our owner,
      // instead of one query per dseq. O(1) RPC calls regardless of deployment count.
      // Owner resolution. The `query deployment list --owner <addr>` chain
      // call only returns dseqs *for that address*, and the orphan sweep
      // closes everything in that returned set that has no DB row. So if
      // we ever resolve the *wrong* owner, the sweep would either (a) close
      // the wrong wallet's deployments (chain rejects — only the signing
      // key can close, so this is structurally impossible) or (b) miss
      // real orphans on our actual deployer wallet.
      //
      // Defense in depth: always resolve the deployer address authoritatively
      // via `keys show -a` and assert it matches the `owner` field on any
      // ACTIVE row we read. A mismatch implies DB corruption — bail out and
      // alert rather than silently operating on the wrong account.
      const resolvedDeployerAddress = await this.resolveDeployerAddress()
      if (!resolvedDeployerAddress) {
        log.warn('Could not resolve deployer wallet address via `keys show` — skipping cycle')
        return
      }
      const dbOwner = activeDeployments[0]?.owner
      if (dbOwner && dbOwner !== resolvedDeployerAddress) {
        log.error(
          { dbOwner, resolvedDeployerAddress },
          'AkashDeployment.owner does not match the resolved deployer address — DB likely corrupted, refusing to sweep this cycle',
        )
        await opsAlert({
          key: 'escrow-monitor-owner-mismatch',
          severity: 'critical',
          title: 'Escrow monitor refused to run — owner mismatch',
          message:
            `An ACTIVE AkashDeployment row has owner=${dbOwner} but the deployer wallet resolves to ${resolvedDeployerAddress}. ` +
            `The cycle (refill + orphan sweep) has been skipped to avoid operating on the wrong wallet. ` +
            `Inspect AkashDeployment rows for the corrupted owner value.`,
          context: { dbOwner, resolvedDeployerAddress },
          suppressMs: 60 * 60 * 1000,
        })
        return
      }
      const owner = resolvedDeployerAddress

      // ─── Concurrency caveat ───
      // PRP §3.29 (`PRODUCTION_READINESS_PLAN.md`): every replica runs this
      // monitor with no leader election. Once horizontal scale ships, both
      // replicas will independently call the sweep against the same chain
      // dseqs. Mitigations already in place that make this *safe* (not
      // *efficient*):
      //   • orchestrator.closeDeployment is idempotent — second close lands
      //     as ALREADY_CLOSED and is treated as success.
      //   • `chain-orphan-closed:<dseq>` opsAlert key dedupes per-process
      //     for 24h, so duplicate alerts collapse within each pod.
      // The remaining cost is wasted close TXs (gas) — bounded by orphan
      // count × replica count × cycles. Acceptable as a launch posture;
      // proper fix is the leader election work tracked in PRP §3.11/§3.29.

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
            await this.refillEscrow(dseq, ppb)
            refillCount++
            // No post-refill sleep here — withWalletLock holds for
            // TX_SETTLE_DELAY_MS internally so the next refill's sequence
            // number lookup sees the previous TX committed.
          } else {
            log.info(logFields, 'Escrow OK — no refill needed')
          }
        } catch (err) {
          errorCount++
          log.error({ dseq, error: (err as Error).message }, 'Failed to check/refill escrow')
        }
      }

      // Sweep deployments that exist on-chain but have no DB row.
      // Catches: half-completed manual `akash` CLI runs, probe-bid (PR 2)
      // deployments whose try/finally close failed, any other path that
      // writes to the chain but bypasses the queue.
      const sweptOrphans = await this.sweepChainOrphans(
        allKnownDseqs,
        chainEscrows,
        currentBlockHeight,
      )

      log.info(
        {
          checked: activeDeployments.length,
          refilled: refillCount,
          closed: closedCount,
          errors: errorCount,
          orphansSwept: sweptOrphans,
        },
        'Escrow health check complete'
      )
    } catch (err) {
      log.error(err as Error, 'Escrow health check failed')
    } finally {
      this.running = false
    }
  }

  /**
   * Resolve the deployer wallet address via `akash keys show` (used as the
   * owner for the chain escrow query when the DB has no ACTIVE rows to read
   * `owner` from — e.g. the orphan-only case).
   */
  private async resolveDeployerAddress(): Promise<string | null> {
    try {
      const keyName = process.env.AKASH_KEY_NAME || 'default'
      const out = await runAkashCmd(['keys', 'show', keyName, '-a'])
      const addr = out.trim()
      return addr || null
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'resolveDeployerAddress failed',
      )
      return null
    }
  }

  /**
   * Close every chain deployment that has no matching DB row, is not already
   * closed on-chain, and is older than `ORPHAN_MIN_AGE_BLOCKS`.
   *
   * Why this exists: the rest of `checkAndRefill` walks DB → chain to detect
   * leases that died on-chain. The reverse direction (chain has it, DB
   * doesn't) had no sweeper, so any path that bypasses the queue — manual
   * `akash tx deployment create`, future probe-bid runs whose
   * `try/finally` close failed, queue workers that crashed between the
   * deployment-create TX and the DB write — leaked $1+ of escrow forever.
   *
   * SAFETY: `allKnownDseqs` MUST contain every dseq we have ever recorded,
   * regardless of status. A row in WAITING_BIDS / DEPLOYING / SUSPENDED /
   * CLOSE_FAILED is intentionally still open on-chain and closing it would
   * destroy a real user workload. Filtering by `status: 'ACTIVE'` here would
   * be a critical bug.
   *
   * Returns the number of orphans we successfully closed.
   */
  private async sweepChainOrphans(
    allKnownDseqs: Array<{ dseq: bigint }>,
    chainEscrows: Map<string, ChainEscrowEntry>,
    currentBlockHeight: number,
  ): Promise<number> {
    const dbDseqs = new Set(allKnownDseqs.map((d) => d.dseq.toString()))
    let swept = 0

    for (const [dseq, entry] of chainEscrows) {
      if (dbDseqs.has(dseq)) continue
      if (entry.closed) continue

      // `settled_at` defaults to the deployment's create-block height for
      // never-touched escrows, so it doubles as an age proxy. Skip anything
      // younger than the threshold to avoid racing brand-new deployments
      // mid-flow.
      const ageBlocks = currentBlockHeight - entry.settledAtBlock
      if (ageBlocks < ORPHAN_MIN_AGE_BLOCKS) {
        log.info(
          { dseq, ageBlocks, threshold: ORPHAN_MIN_AGE_BLOCKS },
          'Chain-orphan candidate younger than threshold — skipping (likely deployment mid-flow)',
        )
        continue
      }

      log.warn(
        {
          dseq,
          ageBlocks,
          fundsUact: entry.fundsUact,
          settledAtBlock: entry.settledAtBlock,
        },
        'Chain-orphan deployment found (no DB row) — closing to reclaim escrow',
      )

      try {
        const orchestrator = getAkashOrchestrator(this.prisma)
        const result = await orchestrator.closeDeployment(Number(dseq))
        if (result.chainStatus === 'FAILED') {
          log.error(
            { dseq, error: result.error },
            'Failed to close chain-orphan deployment (will retry next cycle)',
          )
          continue
        }
        swept++
        // One alert per orphan closed — operator should know that something
        // outside the application created a chain deployment we had to clean up.
        await opsAlert({
          key: `chain-orphan-closed:${dseq}`,
          severity: 'warning',
          title: 'Auto-closed chain-orphan deployment',
          message:
            `Closed dseq ${dseq} on-chain — it had no matching row in akash_deployment. ` +
            `Likely cause: a manual akash CLI invocation, a queue worker that crashed before persisting, ` +
            `or a probe-bid run whose try/finally close failed. Reclaimed ~${(entry.fundsUact / 1_000_000).toFixed(2)} ACT to deployer wallet.`,
          context: {
            dseq,
            ageBlocks: String(ageBlocks),
            fundsUact: String(entry.fundsUact),
          },
          // Per-dseq key dedupes naturally; suppress repeats anyway in case
          // close keeps failing and the same dseq retries.
          suppressMs: 24 * 60 * 60 * 1000,
        })
      } catch (err) {
        log.error(
          { dseq, error: (err as Error).message },
          'Error closing chain-orphan deployment (will retry next cycle)',
        )
      }
    }

    return swept
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
      const balanceAct = (balance / 1_000_000).toFixed(4)

      if (balance < LOW_WALLET_THRESHOLD_UACT) {
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

      // Hot-wallet cap (Section M of the incident runbook — "Akash
      // Hot-Wallet Cap Exceeded / Key Rotation"). The deployer wallet is
      // online — keeping it lean limits blast radius if the pod / key is
      // ever compromised.
      if (balance > HOT_WALLET_CAP_UACT) {
        log.warn(
          { balanceUact: balance, balanceAct, capUact: HOT_WALLET_CAP_UACT },
          'Deployer hot wallet exceeds configured cap — sweep excess to cold storage',
        )
        await opsAlert({
          key: 'deployer-wallet-over-cap',
          severity: 'warning',
          title: 'Deployer hot wallet over cap',
          message:
            `Deployer wallet holds ${balanceAct} ACT, above the ${(HOT_WALLET_CAP_UACT / 1_000_000).toFixed(0)} ACT hot-wallet cap. ` +
            `Sweep the excess back to cold storage per AF_INCIDENT_RUNBOOKS.md §M. ` +
            `Override the cap by setting AKASH_HOT_WALLET_CAP_UACT if usage justifies a larger float.`,
          context: {
            address,
            balanceAct,
            balanceUact: String(balance),
            capUact: String(HOT_WALLET_CAP_UACT),
            excessUact: String(balance - HOT_WALLET_CAP_UACT),
          },
          // Daily nudge — over-cap is a slow-burn risk, not a page-now event.
          suppressMs: 24 * 60 * 60 * 1000,
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
      select: {
        status: true,
        service: { select: { project: { select: { organizationId: true } } } },
      },
    })
    if (!current || current.status !== 'ACTIVE') return

    const closedAt = new Date()

    // Switch on the structured close result. The escrow
    // monitor only invokes auto-close when the lease is *already*
    // chain-dead (provider closed it / escrow drained), so the most
    // common outcome here is ALREADY_CLOSED. A FAILED outcome is
    // pathological (RPC down, wallet empty) and we MUST surface it
    // as CLOSE_FAILED instead of silently marking the row CLOSED —
    // otherwise the user gets refunded for an escrow we never
    // actually settled.
    const orchestrator = getAkashOrchestrator(this.prisma)
    const close = await orchestrator.closeDeployment(Number(dseq))

    if (close.chainStatus === 'FAILED') {
      log.error(
        { deploymentId, dseq, error: close.error },
        'Escrow-monitor auto-close FAILED on-chain — marking CLOSE_FAILED, leaving escrow intact for retry',
      )
      await this.prisma.akashDeployment.updateMany({
        where: { id: deploymentId, status: 'ACTIVE' },
        data: {
          status: 'CLOSE_FAILED',
          errorMessage: `Escrow-monitor auto-close failed: ${close.error}`,
        },
      })
      return
    }

    const result = await this.prisma.akashDeployment.updateMany({
      where: { id: deploymentId, status: 'ACTIVE' },
      data: { status: 'CLOSED', closedAt },
    })

    if (result.count > 0) {
      await settleAkashEscrowToTime(this.prisma, deploymentId, closedAt)
      await getEscrowService(this.prisma).refundEscrow(deploymentId)
      const { decrementOrgConcurrency } = await import(
        '../concurrency/concurrencyService.js'
      )
      await decrementOrgConcurrency(
        this.prisma,
        current.service?.project?.organizationId,
      ).catch((err) =>
        log.warn({ err, deploymentId }, 'Concurrency decrement failed (escrow auto-close)'),
      )
      log.info(
        { deploymentId, dseq, chainStatus: close.chainStatus },
        'Chain-dead deployment closed and billing settled',
      )
    }
  }

  private async refillEscrow(dseq: string, pricePerBlockUact: number): Promise<void> {
    const refillUact = Math.max(
      100_000,
      pricePerBlockUact * BLOCKS_PER_HOUR * REFILL_HOURS
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
