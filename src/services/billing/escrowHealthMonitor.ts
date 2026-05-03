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

      // dseq → status map for every row we've ever recorded. The orphan
      // sweep below uses this to bucket chain leases into:
      //   • known + intermediate (CREATING / WAITING_BIDS / … / DEPLOYING /
      //     CLOSE_FAILED) → SKIP, the row is intentionally mid-flow on chain
      //     and racing it would destroy a real user workload.
      //   • known + ACTIVE  → SKIP, the upstream per-deployment loop already
      //     handles refill / chain-dead detection for these.
      //   • known + closed-from-our-perspective (SUSPENDED / CLOSED /
      //     PERMANENTLY_FAILED / FAILED) → CLOSE on chain. Chain still being
      //     open here is a consistency bug — it leaks escrow continuously
      //     because the user already considers the lease gone (suspendOrgHandler
      //     marked SUSPENDED *after* an on-chain close that must have
      //     subsequently regressed; or a manual close path skipped the chain
      //     close; or a SUSPENDED resume created a new lease without
      //     terminating the old one).
      //   • unknown (no DB row) → CLOSE on chain (the existing chain-orphan
      //     case, e.g. half-completed manual `akash` runs or probe-bid
      //     try/finally close failures).
      const allKnownRows = await this.prisma.akashDeployment.findMany({
        select: { dseq: true, status: true, id: true },
      })

      log.info(
        {
          activeCount: activeDeployments.length,
          knownDseqCount: allKnownRows.length,
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

      // ─── Concurrency contract ───
      // This monitor is leader-elected via `runWithLeadership('escrow-health-monitor', …)`
      // in `service-cloud-api/src/index.ts` — exactly one replica runs the
      // sweep at a time. Defence-in-depth still applies in case leadership
      // flips mid-cycle (lease lost between fetch and close):
      //   • orchestrator.closeDeployment is idempotent — a second close
      //     lands as ALREADY_CLOSED and is treated as success.
      //   • `chain-orphan-closed:<dseq>` opsAlert key dedupes per-process
      //     for 24h, so duplicate alerts collapse within each pod.
      // PRP §3.29 (covered by §3.11) is the historical entry that flagged
      // this before leader election shipped — keep it referenced here so
      // anyone auditing the runbook lands on the right code.

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

      // Phase 49b — mass-event guard. Previously this loop closed every
      // ACTIVE row whose dseq was missing from `chainEscrows`. A single
      // RPC blip that returned truncated data could nuke the fleet by
      // mis-attributing every present deployment as "gone on-chain". Now
      // we collect close candidates first, then refuse to act if a
      // disproportionate share of the fleet would close in one cycle.
      const closeCandidates: Array<{
        deploymentId: string
        dseq: string
        reason: 'closed' | 'missing'
      }> = []
      const eligibleForCloseCheck: string[] = []

      for (const dep of activeDeployments) {
        const dseq = dep.dseq.toString()
        if (!dseq || dseq === '0' || Number(dseq) < 0) continue
        eligibleForCloseCheck.push(dseq)

        const chain = chainEscrows.get(dseq)
        if (!chain || chain.closed) {
          closeCandidates.push({
            deploymentId: dep.id,
            dseq,
            reason: chain ? 'closed' : 'missing',
          })
        }
      }

      const massCloseAborted = await this.maybeAbortMassClose(
        closeCandidates,
        eligibleForCloseCheck.length,
      )

      for (const dep of activeDeployments) {
        const dseq = dep.dseq.toString()
        if (!dseq || dseq === '0' || Number(dseq) < 0) continue

        try {
          const chain = chainEscrows.get(dseq)

          // Deployment missing from chain or explicitly closed — settle billing
          if (!chain || chain.closed) {
            if (massCloseAborted) {
              // Mass-close abort: counters NOT advanced, no DB mutation.
              // Next cycle re-evaluates with fresh chain state. The opsAlert
              // inside maybeAbortMassClose covers operator visibility.
              continue
            }
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

      // Sweep deployments that exist on-chain but either have no DB row
      // OR whose DB row says the lease is supposed to be gone (SUSPENDED /
      // CLOSED / PERMANENTLY_FAILED / FAILED). Catches: half-completed
      // manual `akash` runs, probe-bid try/finally close failures, AND
      // SUSPENDED-LEAKs where the original on-chain close at suspend time
      // didn't take but the row got marked SUSPENDED anyway.
      const sweptOrphans = await this.sweepChainOrphans(
        allKnownRows,
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
   * Phase 49b mass-close guard for the per-deployment "chain says gone"
   * close path. Mirrors the staleDeploymentSweeper's reconciler guard.
   *
   * If a single chain query returns truncated data (RPC blip, gateway
   * partial response, owner-mismatch), every ACTIVE row could appear to be
   * "missing on chain" and the previous unguarded loop would close the
   * entire fleet. Trip threshold matches the sweeper: ratio ≥ 0.5 of all
   * eligible rows AND total ≥ 5.
   *
   * Returns `true` when the cycle should skip closing this pass (counters
   * are NOT advanced — a real chain death will still surface next cycle).
   */
  private async maybeAbortMassClose(
    closeCandidates: Array<{ deploymentId: string; dseq: string; reason: 'closed' | 'missing' }>,
    eligibleTotal: number,
  ): Promise<boolean> {
    const MASS_MIN_TOTAL = 5
    const MASS_RATIO = 0.5
    if (closeCandidates.length === 0 || eligibleTotal < MASS_MIN_TOTAL) return false
    const ratio = closeCandidates.length / eligibleTotal
    if (ratio < MASS_RATIO) return false

    const reasons = closeCandidates.reduce<Record<string, number>>((acc, c) => {
      acc[c.reason] = (acc[c.reason] ?? 0) + 1
      return acc
    }, {})

    log.error(
      {
        total: eligibleTotal,
        wouldClose: closeCandidates.length,
        ratio: +ratio.toFixed(2),
        reasons,
      },
      'Mass-close event detected in escrow monitor — refusing to close any rows this cycle (likely RPC truncation / chain blip)',
    )

    try {
      await opsAlert({
        key: 'escrow-monitor-mass-close',
        severity: 'critical',
        title: 'Escrow monitor aborted mass-close',
        message:
          `Escrow monitor would have closed ${closeCandidates.length}/${eligibleTotal} ` +
          `ACTIVE deployments in a single cycle (ratio ${(ratio * 100).toFixed(0)}%). ` +
          `Aborted to avoid nuking the fleet on a chain RPC truncation. ` +
          `Investigate \`akash query deployment list\` health; next cycle re-evaluates.`,
        context: {
          total: String(eligibleTotal),
          wouldClose: String(closeCandidates.length),
          ratio: ratio.toFixed(2),
          reasons: JSON.stringify(reasons),
          sampleDseqs: closeCandidates
            .slice(0, 10)
            .map((c) => c.dseq)
            .join(','),
        },
        suppressMs: 30 * 60 * 1000,
      })
    } catch (err) {
      log.warn({ err }, 'opsAlert failed during escrow-monitor mass-close abort')
    }
    return true
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
   * Close every chain deployment that either:
   *
   *   (a) has no matching DB row at all (true ORPHAN — bypassed the queue
   *       entirely, e.g. manual `akash tx deployment create`, probe-bid
   *       try/finally failure, queue worker crash before persisting), OR
   *
   *   (b) has a DB row whose status implies the lease should already be
   *       gone (SUSPENDED / CLOSED / PERMANENTLY_FAILED / FAILED /
   *       CLOSE_FAILED). The on-chain close at suspend / close time must
   *       have failed silently, OR a manual close path skipped the chain
   *       close, OR the resume path created a new lease without
   *       terminating the old one. Either way the chain is leaking escrow
   *       continuously — the row already represents "lease gone" to the
   *       user, so re-closing it on chain is the only correct outcome.
   *
   * Skipped (with reason logged):
   *
   *   • DB row in an INTERMEDIATE state (CREATING / WAITING_BIDS /
   *     SELECTING_BID / CREATING_LEASE / SENDING_MANIFEST / DEPLOYING):
   *     the row is intentionally mid-flow on chain — closing here races
   *     the queue worker and would destroy a real user workload.
   *   • DB row in ACTIVE state: handled by the per-deployment loop above
   *     (refill or chain-dead detection).
   *   • Anything younger than `ORPHAN_MIN_AGE_BLOCKS` blocks on chain:
   *     too young, may still be mid-flow even if no DB row exists yet.
   *   • Already-closed entries on chain.
   *
   * Returns the number of leases we successfully closed (orphans + leaks).
   */
  /**
   * Gate the destructive chain-orphan close path so only production
   * processes run it. Two fail-closed layers:
   *  1. Env: `AKASH_ALLOW_CHAIN_ORPHAN_SWEEP=1` must be set.
   *  2. Coverage: refuse if chain has ≥5 active escrows but local DB
   *     knows about fewer than half — protects against running against
   *     a stale or empty DB with the prod wallet.
   */
  private chainOrphanSweepEnabled(
    chainEscrowCount: number,
    knownDbCount: number,
  ): { ok: boolean; reason?: string } {
    if (process.env.AKASH_ALLOW_CHAIN_ORPHAN_SWEEP !== '1') {
      return {
        ok: false,
        reason: 'AKASH_ALLOW_CHAIN_ORPHAN_SWEEP not set — production-only',
      }
    }
    // Refuse if local DB knows about <50% of chain's active escrows —
    // catches running against a stale/empty DB with the prod wallet.
    if (chainEscrowCount >= 5 && knownDbCount * 2 < chainEscrowCount) {
      return {
        ok: false,
        reason:
          `coverage check failed: chain ${chainEscrowCount} active escrows, DB knows ${knownDbCount}`,
      }
    }
    return { ok: true }
  }

  private async sweepChainOrphans(
    allKnownRows: Array<{ dseq: bigint; status: string; id: string }>,
    chainEscrows: Map<string, ChainEscrowEntry>,
    currentBlockHeight: number,
  ): Promise<number> {
    // dseq → DB row info (status + row id, used for alert context)
    const dbByDseq = new Map<string, { status: string; id: string }>()
    for (const r of allKnownRows) {
      dbByDseq.set(r.dseq.toString(), { status: r.status, id: r.id })
    }

    // Gate the destructive close path — see chainOrphanSweepEnabled.
    const gate = this.chainOrphanSweepEnabled(chainEscrows.size, allKnownRows.length)
    if (!gate.ok) {
      log.warn(
        { reason: gate.reason, chainEscrowCount: chainEscrows.size, knownDbCount: allKnownRows.length },
        'chain-orphan sweep skipped — destructive close path gated',
      )
      // Loud opsAlert when the ratio check trips so a real prod incident
      // (not "operator forgot to set the env") gets a human looking at it.
      if (
        process.env.AKASH_ALLOW_CHAIN_ORPHAN_SWEEP === '1' &&
        chainEscrows.size >= 5 &&
        allKnownRows.length * 2 < chainEscrows.size
      ) {
        try {
          await opsAlert({
            key: 'chain-orphan-sweep-ratio-skip',
            severity: 'critical',
            title: 'Chain-orphan sweep refused — DB coverage too low',
            message:
              `Chain reports ${chainEscrows.size} active escrow accounts on the deployer ` +
              `wallet, but the local DB only knows about ${allKnownRows.length}. ` +
              `Refusing to sweep to avoid closing real production leases. Investigate ` +
              `DB drift / replication state immediately.`,
            context: {
              chainEscrowCount: chainEscrows.size,
              knownDbCount: allKnownRows.length,
            },
            suppressMs: 30 * 60 * 1000,
          })
        } catch {
          // best-effort
        }
      }
      return 0
    }

    // Statuses where the row is mid-flight on chain — closing races the
    // queue worker. NEVER close these.
    const INTERMEDIATE_SKIP = new Set([
      'CREATING',
      'WAITING_BIDS',
      'SELECTING_BID',
      'CREATING_LEASE',
      'SENDING_MANIFEST',
      'DEPLOYING',
    ])
    // Statuses where the user-facing row says the lease is already gone.
    // Chain-still-open here is a consistency bug → close.
    const SHOULD_BE_CLOSED = new Set([
      'SUSPENDED',
      'CLOSED',
      'PERMANENTLY_FAILED',
      'FAILED',
      'CLOSE_FAILED',
    ])

    let swept = 0

    for (const [dseq, entry] of chainEscrows) {
      if (entry.closed) continue

      const db = dbByDseq.get(dseq)
      let leakReason: 'no_db_row' | 'db_terminal' | 'db_suspended' | null = null

      if (!db) {
        leakReason = 'no_db_row'
      } else if (INTERMEDIATE_SKIP.has(db.status)) {
        log.debug(
          { dseq, dbStatus: db.status },
          'chain-orphan-sweep: row is mid-flight on chain — skipping',
        )
        continue
      } else if (db.status === 'ACTIVE') {
        // Handled by the per-deployment loop above.
        continue
      } else if (SHOULD_BE_CLOSED.has(db.status)) {
        leakReason = db.status === 'SUSPENDED' ? 'db_suspended' : 'db_terminal'
      } else {
        // Unknown status — log loudly, skip for safety.
        log.warn(
          { dseq, dbStatus: db.status },
          'chain-orphan-sweep: unknown DB status for chain-active dseq — skipping',
        )
        continue
      }

      // `settled_at` defaults to the deployment's create-block height for
      // never-touched escrows, so it doubles as an age proxy. Skip anything
      // younger than the threshold to avoid racing brand-new deployments
      // mid-flow that haven't yet been persisted.
      const ageBlocks = currentBlockHeight - entry.settledAtBlock
      if (leakReason === 'no_db_row' && ageBlocks < ORPHAN_MIN_AGE_BLOCKS) {
        log.info(
          { dseq, ageBlocks, threshold: ORPHAN_MIN_AGE_BLOCKS },
          'Chain-orphan candidate younger than threshold — skipping (likely deployment mid-flow)',
        )
        continue
      }

      log.warn(
        {
          dseq,
          leakReason,
          dbStatus: db?.status ?? 'NONE',
          dbDeploymentId: db?.id ?? null,
          ageBlocks,
          fundsUact: entry.fundsUact,
          settledAtBlock: entry.settledAtBlock,
        },
        'Chain lease leaking escrow — closing to reclaim',
      )

      try {
        const orchestrator = getAkashOrchestrator(this.prisma)
        const result = await orchestrator.closeDeployment(Number(dseq))
        if (result.chainStatus === 'FAILED') {
          log.error(
            { dseq, error: result.error },
            'Failed to close chain-leaking deployment (will retry next cycle)',
          )
          continue
        }
        swept++

        // If we have a DB row, advance any non-terminal status to CLOSED so
        // the next pass doesn't keep flagging it. The check is idempotent —
        // CLOSED rows are unaffected.
        if (db?.id) {
          try {
            await this.prisma.akashDeployment.updateMany({
              where: {
                id: db.id,
                NOT: { status: { in: ['CLOSED', 'PERMANENTLY_FAILED'] } },
              },
              data: {
                status: 'CLOSED',
                closedAt: new Date(),
                errorMessage:
                  `escrow-monitor: closed chain lease that DB had as ${db.status}; ` +
                  `synced ${new Date().toISOString()}`,
              },
            })
          } catch (dbErr) {
            log.warn(
              { dseq, dbId: db.id, err: (dbErr as Error).message },
              'Closed on chain but DB sync update failed (will reconcile on next pass)',
            )
          }
        }

        const reasonLabel =
          leakReason === 'no_db_row'
            ? 'no matching row in akash_deployment'
            : leakReason === 'db_suspended'
              ? `DB row was SUSPENDED (id=${db?.id})`
              : `DB row was ${db?.status} (id=${db?.id})`

        await opsAlert({
          key: `chain-orphan-closed:${dseq}`,
          severity: 'warning',
          title:
            leakReason === 'no_db_row'
              ? 'Auto-closed chain-orphan deployment'
              : 'Auto-closed leaking chain lease (DB/chain mismatch)',
          message:
            `Closed dseq ${dseq} on-chain — ${reasonLabel}. ` +
            `Reclaimed ~${(entry.fundsUact / 1_000_000).toFixed(2)} ACT to deployer wallet.`,
          context: {
            dseq,
            leakReason,
            dbStatus: db?.status ?? 'NONE',
            dbDeploymentId: db?.id ?? '',
            ageBlocks: String(ageBlocks),
            fundsUact: String(entry.fundsUact),
          },
          suppressMs: 24 * 60 * 60 * 1000,
        })
      } catch (err) {
        log.error(
          { dseq, error: (err as Error).message },
          'Error closing chain-leaking deployment (will retry next cycle)',
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
