/**
 * GPU bid-probe runner + rollup.
 *
 * Posts a tiny SDL targeting one GPU model, collects every open bid that
 * comes back over a 60-90s window, persists the bids to
 * `gpu_bid_observation`, then closes the deployment without leasing.
 * Repeats for every GPU model the registry knows about, then rolls the
 * recent observations into `gpu_price_summary` percentiles for the UI.
 *
 * Design:
 *   - Mirrors the `tx deployment create` → `query market bid list` →
 *     `tx deployment close` flow from `providerVerification.ts`, minus
 *     lease/manifest/lease-status (we never serve the workload).
 *   - All TX calls go through `withWalletLock` so we never race the
 *     billing cron / escrow monitor / user-initiated deploys.
 *   - `execCli` is injectable so tests can stub the chain entirely.
 *   - Probe close lives in `finally` so a thrown bid-poll never leaks
 *     escrow. The chain-orphan sweep in `escrowHealthMonitor` is the
 *     final safety net if even the close fails.
 *
 * Cost: ~$0.0015/probe × ~15 GPU models × 4 runs/day ≈ $0.09/day.
 * MIN_ACT_BALANCE_UACT keeps us safely above probe spend.
 */

import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { PrismaClient } from '@prisma/client'
import { getAkashEnv as getAkashEnvBase } from '../../lib/akashEnv.js'
import { withWalletLock } from '../akash/walletMutex.js'
import { DEFAULT_DEPOSIT_UACT } from '../akash/orchestrator.js'
import { createLogger } from '../../lib/logger.js'
import { buildProbeSdl, PROBE_PRICING_CEILING_UACT, type GpuVendor } from './probeBidSdl.js'
import { checkBalance, type WalletBalance } from './providerVerification.js'

const log = createLogger('gpu-bid-probe')

// ── Constants ──────────────────────────────────────────────────────────

const CLI_TIMEOUT_MS = 120_000
const TX_RETRIES = 3
const TX_SEQ_RETRY_DELAY_MS = 8_000
const BID_POLL_MAX = 9
const BID_POLL_DELAY_MS = 10_000
const BID_INITIAL_WAIT_MS = 30_000
/**
 * Inter-probe wait — gives the chain time to settle the previous probe's
 * close TX before the next one queries account sequence. Same rationale
 * as `INTER_TEMPLATE_DELAY_MS` in `providerVerification.ts`.
 */
const INTER_PROBE_DELAY_MS = 8_000

/**
 * Hard rollup ceiling. Any observation at-or-above this price is dropped
 * before percentiles are computed — protects against a malicious
 * provider bidding the SDL ceiling itself to skew our reported max.
 * 50_000 uact/block ≈ $18/hr — far above any honest GPU price as of
 * 2026-04.
 */
export const MAX_PROBE_BID_UACT = 50_000n

// ── Types ──────────────────────────────────────────────────────────────

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs: number
}

export type ExecCli = (
  bin: string,
  args: string[],
  timeoutMs?: number,
) => Promise<ExecResult>

export interface ProbeRunnerDeps {
  /** Override the CLI shell-out (used by tests). */
  execCli?: ExecCli
  /** Override `withWalletLock` for tests that don't need real serialization. */
  withWalletLock?: <T>(fn: () => Promise<T>) => Promise<T>
  /** Override `sleep` so tests don't actually wait 30+ seconds. */
  sleep?: (ms: number) => Promise<void>
}

export interface ProbeOneResult {
  gpuModel: string
  vendor: GpuVendor
  dseq?: number
  owner?: string
  bidsReceived: number
  providersBidding: number
  durationMs: number
  error?: string
}

export interface ProbeCycleSummary {
  runId: string
  modelsProbed: number
  totalBids: number
  uniqueProviders: number
  durationMs: number
  results: ProbeOneResult[]
}

// ── Helpers ────────────────────────────────────────────────────────────

function getAkashEnv() {
  // Use sync broadcast (default). The probe is non-critical — we don't
  // need block-mode confirmation; the bid-poll loop establishes whether
  // the deployment is live on-chain.
  return getAkashEnvBase()
}

const defaultExecCli: ExecCli = (bin, args, timeoutMs = CLI_TIMEOUT_MS) => {
  const env = getAkashEnv()
  const start = Date.now()
  return new Promise(res => {
    execFile(
      bin,
      args,
      { encoding: 'utf-8', env, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const durationMs = Date.now() - start
        const exitCode = err ? ((err as NodeJS.ErrnoException).code as unknown as number) ?? 1 : 0
        res({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode, durationMs })
      }
    )
  })
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim()
  try { return JSON.parse(trimmed) } catch { /* continue */ }
  const objIdx = trimmed.indexOf('{')
  const arrIdx = trimmed.indexOf('[')
  const startIdx = objIdx === -1 ? arrIdx : arrIdx === -1 ? objIdx : Math.min(objIdx, arrIdx)
  if (startIdx === -1) throw new SyntaxError(`No JSON in output: ${trimmed.slice(0, 200)}`)
  return JSON.parse(trimmed.slice(startIdx))
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function vendorFor(model: string): GpuVendor {
  // Mirrors web-app/.../akash-gpu-availability/route.ts so the same
  // (lowercase model → vendor) mapping is used everywhere.
  const lower = model.toLowerCase()
  if (lower.startsWith('rx') || lower.startsWith('mi')) return 'amd'
  return 'nvidia'
}

function extractDseqFromTxJson(txJson: any): number | undefined {
  const logs = txJson?.logs as any[] | undefined
  if (logs) {
    for (const l of logs) {
      for (const event of l.events || []) {
        const attr = event.attributes?.find((a: any) => a.key === 'dseq')
        if (attr) {
          const dseq = parseInt(attr.value, 10)
          if (!Number.isNaN(dseq) && dseq > 0) return dseq
        }
      }
    }
  }
  return undefined
}

// ── Single-model probe ─────────────────────────────────────────────────

/**
 * Probe one GPU model: submit deployment → poll bids → close (in finally).
 * Persists every received bid to `gpu_bid_observation` keyed by `runId`.
 *
 * Returns a result describing the outcome. Never throws on chain errors —
 * those are folded into `result.error` so the cycle can keep probing the
 * remaining models.
 */
export async function probeOneGpuModel(
  prisma: PrismaClient,
  model: string,
  vendor: GpuVendor,
  runId: string,
  deps: ProbeRunnerDeps = {},
): Promise<ProbeOneResult> {
  const execCli = deps.execCli ?? defaultExecCli
  const lock = deps.withWalletLock ?? withWalletLock
  const sleep = deps.sleep ?? defaultSleep

  const start = Date.now()
  const result: ProbeOneResult = {
    gpuModel: model,
    vendor,
    bidsReceived: 0,
    providersBidding: 0,
    durationMs: 0,
  }

  if (!process.env.AKASH_MNEMONIC) {
    result.error = 'AKASH_MNEMONIC not set'
    result.durationMs = Date.now() - start
    return result
  }

  let sdl: string
  try {
    sdl = buildProbeSdl(model, vendor)
  } catch (err) {
    result.error = `Bad probe SDL: ${err instanceof Error ? err.message : String(err)}`
    result.durationMs = Date.now() - start
    return result
  }

  const workDir = mkdtempSync(join(tmpdir(), 'af-gpu-probe-'))
  const sdlPath = join(workDir, 'probe.yaml')
  writeFileSync(sdlPath, sdl)

  let dseq: number | undefined

  try {
    // Resolve wallet address (needed for `query market bid list --owner`).
    const addrRes = await execCli(
      'akash',
      ['keys', 'show', process.env.AKASH_KEY_NAME || 'default', '-a'],
      15_000,
    )
    if (addrRes.exitCode !== 0) {
      result.error = `Cannot get wallet address: ${addrRes.stderr.trim().slice(0, 200)}`
      return result
    }
    const owner = addrRes.stdout.trim()
    result.owner = owner

    // Submit deployment-create with sequence-mismatch retry. Same shape
    // as providerVerification.ts so behaviour matches.
    let txJson: any = {}
    let txAccepted = false
    for (let attempt = 1; attempt <= TX_RETRIES; attempt++) {
      const txRes = await lock(() =>
        execCli('akash', [
          'tx', 'deployment', 'create', sdlPath,
          '--deposit', `${DEFAULT_DEPOSIT_UACT}uact`,
          '-o', 'json', '-y',
        ])
      )
      if (txRes.exitCode !== 0) {
        result.error = `tx create failed: ${txRes.stderr.trim().slice(0, 200)}`
        return result
      }
      try { txJson = extractJson(txRes.stdout) as any } catch { txJson = {} }
      const code =
        typeof txJson.code === 'number'
          ? txJson.code
          : parseInt(txJson.code ?? '0', 10)
      if (code === 32 && attempt < TX_RETRIES) {
        await sleep(TX_SEQ_RETRY_DELAY_MS)
        continue
      }
      if (code !== 0) {
        result.error = `tx rejected (code ${code}): ${(txJson.raw_log || '').slice(0, 200)}`
        return result
      }
      txAccepted = true
      break
    }
    if (!txAccepted) {
      result.error = 'tx not accepted after retries'
      return result
    }

    dseq = extractDseqFromTxJson(txJson)

    // Fallback: query the txhash if logs didn't carry the dseq attribute
    // (sync broadcast can return before logs are populated).
    if (!dseq && txJson.txhash) {
      for (const delay of [6000, 6000, 8000]) {
        await sleep(delay)
        const qr = await execCli('akash', ['query', 'tx', txJson.txhash, '-o', 'json'], 60_000)
        if (qr.exitCode !== 0) continue
        try {
          const qj = extractJson(qr.stdout) as any
          dseq = extractDseqFromTxJson(qj)
          if (!dseq) {
            const msgDseq = qj?.tx?.body?.messages?.[0]?.id?.dseq
            if (msgDseq) {
              const parsed = parseInt(String(msgDseq), 10)
              if (!Number.isNaN(parsed) && parsed > 0) dseq = parsed
            }
          }
          if (dseq) break
        } catch { /* retry */ }
      }
    }

    if (!dseq) {
      result.error = 'Could not extract dseq from tx'
      return result
    }

    result.dseq = dseq
    log.info({ dseq, model, vendor, runId }, 'Probe deployment created')

    // Poll for bids. We collect every distinct provider bid we see — one
    // bid per provider per dseq is the chain semantic, so dedupe by
    // provider address.
    const bidsByProvider = new Map<string, { amount: bigint; denom: string }>()

    await sleep(BID_INITIAL_WAIT_MS)
    for (let attempt = 1; attempt <= BID_POLL_MAX; attempt++) {
      const bidRes = await execCli('akash', [
        'query', 'market', 'bid', 'list',
        '--owner', owner,
        '--dseq', String(dseq),
        '-o', 'json',
      ])
      if (bidRes.exitCode === 0) {
        try {
          const bidJson = extractJson(bidRes.stdout) as any
          const rawBids = bidJson.bids || []
          for (const b of rawBids) {
            const bid = b.bid || b
            const id = bid.bid_id || bid.id || {}
            const price = bid.price || {}
            const provider = String(id.provider || '')
            const state = bid.state
            if (!provider || state !== 'open') continue
            const denom = String(price.denom || 'uact')
            // Skip uakt bids — post-BME the chain only mints uact for
            // new leases; any uakt bid here is a misconfigured provider
            // and would corrupt the percentile if mixed with uact.
            if (denom !== 'uact') continue
            // Bid prices come back from `query market bid list` as cosmos
            // SDK Dec strings (fixed-point, 18 decimals — e.g.
            // "1957.925980000000000000"). BigInt rejects the decimal
            // point outright (SyntaxError), so we have to truncate the
            // fractional part before parsing. Sub-uact precision is below
            // any meaningful price granularity (uact is already 1e-6 ACT),
            // so flooring to whole uact loses no signal.
            let amount: bigint
            try {
              const rawAmount = String(price.amount ?? '0')
              const intPart = rawAmount.split('.')[0]
              amount = BigInt(intPart)
            } catch { continue }
            if (amount <= 0n) continue
            // Keep the lowest bid per provider — providers occasionally
            // re-bid; we want the most generous offer they made.
            const prev = bidsByProvider.get(provider)
            if (!prev || amount < prev.amount) {
              bidsByProvider.set(provider, { amount, denom })
            }
          }
        } catch { /* parse error → next poll */ }
      }
      if (bidsByProvider.size > 0 && attempt >= 3) break
      if (attempt < BID_POLL_MAX) await sleep(BID_POLL_DELAY_MS)
    }

    if (bidsByProvider.size === 0) {
      result.error = 'No bids received within timeout'
      // not a thrown failure — every probe still records its outcome
    } else {
      // Persist. Use createMany — duplicates can't happen because runId
      // is unique-per-cycle and we dedupe per provider above.
      await prisma.gpuBidObservation.createMany({
        data: Array.from(bidsByProvider.entries()).map(([providerAddr, b]) => ({
          probeRunId: runId,
          gpuModel: model,
          vendor,
          providerAddr,
          pricePerBlock: b.amount,
          dseq: BigInt(dseq!),
        })),
      })
      result.bidsReceived = bidsByProvider.size
      result.providersBidding = bidsByProvider.size
      log.info(
        { dseq, model, runId, bids: bidsByProvider.size },
        'Probe bids recorded',
      )
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  } finally {
    if (dseq) {
      try {
        await lock(() =>
          execCli('akash', [
            'tx', 'deployment', 'close',
            '--dseq', String(dseq),
            '-o', 'json', '-y',
          ])
        )
        log.info({ dseq, model }, 'Probe deployment closed')
      } catch (closeErr) {
        // Best-effort. The chain-orphan sweep in escrowHealthMonitor
        // catches any deployment that survives this close failure.
        log.warn(
          { dseq, model, err: closeErr instanceof Error ? closeErr.message : closeErr },
          'Probe close failed — orphan sweep will reclaim it'
        )
      }
    }
    try { rmSync(workDir, { recursive: true }) } catch { /* ignore */ }
    result.durationMs = Date.now() - start
  }

  return result
}

// ── Full cycle (all models) ────────────────────────────────────────────

export async function runGpuBidProbeCycle(
  prisma: PrismaClient,
  deps: ProbeRunnerDeps = {},
): Promise<ProbeCycleSummary> {
  const runId = randomUUID()
  const start = Date.now()
  const sleep = deps.sleep ?? defaultSleep

  // Snapshot wallet before we start so we can attribute the cycle's
  // on-chain spend (gas, deposits not refunded) to this GpuProbeRun row.
  // Failure here is non-fatal — we still want the cycle to run, we just
  // record cost = 0 for it.
  let balanceBefore: WalletBalance | null = null
  try { balanceBefore = await checkBalance() } catch { /* non-fatal */ }

  // Track the run so the admin dashboard can answer "how many cycles
  // ran, what did they cost, what came out of them" without having to
  // re-derive run counts from `gpu_bid_observation`. Best-effort: a DB
  // outage here must not stop the actual probe cycle.
  let runRecordId: string | null = null
  try {
    const created = await prisma.gpuProbeRun.create({
      data: {
        probeRunId: runId,
        startedAt: new Date(start),
        status: 'running',
      },
      select: { id: true },
    })
    runRecordId = created.id
  } catch (err) {
    log.warn(
      { runId, err: err instanceof Error ? err.message : err },
      'Could not create GpuProbeRun record — continuing without admin telemetry'
    )
  }

  // Source of truth for "what GPUs do we know exist on Akash?" is the
  // ProviderRegistryScheduler's hourly scan into `compute_provider`.
  // We probe every distinct model offered by a verified provider with
  // GPU capacity right now — no point probing a GPU nobody serves.
  const providers = await prisma.computeProvider.findMany({
    where: {
      providerType: 'AKASH',
      verified: true,
      gpuTotal: { gt: 0 },
    },
    select: { gpuModels: true },
  })

  const models = new Map<string, GpuVendor>()
  for (const p of providers) {
    for (const raw of p.gpuModels) {
      const m = raw.toLowerCase().trim()
      if (!m) continue
      if (!models.has(m)) models.set(m, vendorFor(m))
    }
  }

  log.info(
    { runId, modelCount: models.size, providerCount: providers.length },
    'Starting GPU bid probe cycle'
  )

  const results: ProbeOneResult[] = []
  const seenProviders = new Set<string>()
  let cycleError: string | undefined
  // Cost is captured outside try/finally so the finaliser can write
  // the partial-cycle spend even if rollup or the bid read-back throws.
  let costUact = BigInt(0)
  let costUakt = BigInt(0)
  let totalBids = 0

  try {
    try {
      // Materialise the entries once — re-iterating a Map mid-loop and computing
      // .keys().at(-1) on every step is O(n²) for no benefit.
      const entries = Array.from(models.entries())
      for (let i = 0; i < entries.length; i++) {
        const [model, vendor] = entries[i]
        const r = await probeOneGpuModel(prisma, model, vendor, runId, deps)
        results.push(r)
        // Inter-probe wait so back-to-back tx don't race the wallet sequence.
        if (i < entries.length - 1) {
          await sleep(INTER_PROBE_DELAY_MS)
        }
      }

      // After all probes, refresh the rollup.
      try {
        await rollupGpuPrices(prisma)
      } catch (err) {
        log.error(
          { runId, err: err instanceof Error ? err.message : err },
          'rollupGpuPrices failed — gpu_price_summary may be stale'
        )
      }
    } catch (err) {
      cycleError = err instanceof Error ? err.message : String(err)
      log.error({ runId, err: cycleError }, 'Probe cycle threw mid-loop')
    }

    // Compute summary stats from the rows we just inserted (read-back
    // avoids double-counting if probeOne short-circuited).
    try {
      const fresh = await prisma.gpuBidObservation.findMany({
        where: { probeRunId: runId },
        select: { providerAddr: true },
      })
      for (const row of fresh) seenProviders.add(row.providerAddr)
      totalBids = fresh.length
    } catch (err) {
      log.warn(
        { runId, err: err instanceof Error ? err.message : err },
        'bid read-back failed — bidsCollected/uniqueProviders will be 0',
      )
    }

    // Snapshot wallet after the cycle and compute spend. Floor at 0 — a
    // wallet refill mid-cycle would otherwise produce a negative cost.
    if (balanceBefore) {
      try {
        const balanceAfter = await checkBalance()
        costUact = BigInt(Math.max(0, balanceBefore.uact - balanceAfter.uact))
        costUakt = BigInt(Math.max(0, balanceBefore.uakt - balanceAfter.uakt))
      } catch (err) {
        log.warn(
          { runId, err: err instanceof Error ? err.message : err },
          'Post-cycle balance snapshot failed — recording cost = 0'
        )
      }
    }
  } finally {
    // Finalise the run record. ALWAYS runs — even if read-back or
    // balance snapshot threw — so the dashboard never sees a stranded
    // `running` row from an in-process failure. Out-of-process kills
    // are still cleaned up by markStaleProbeRuns at the next scheduler
    // startup.
    if (runRecordId) {
      try {
        await prisma.gpuProbeRun.update({
          where: { id: runRecordId },
          data: {
            completedAt: new Date(),
            modelsProbed: results.length,
            bidsCollected: totalBids,
            uniqueProviders: seenProviders.size,
            costUact,
            costUakt,
            status: cycleError ? 'failed' : 'completed',
            error: cycleError ? cycleError.slice(0, 1000) : null,
          },
        })
      } catch (err) {
        log.warn(
          { runId, err: err instanceof Error ? err.message : err },
          'Could not finalise GpuProbeRun record — startup recovery will sweep it'
        )
      }
    }
  }

  const summary: ProbeCycleSummary = {
    runId,
    modelsProbed: results.length,
    totalBids,
    uniqueProviders: seenProviders.size,
    durationMs: Date.now() - start,
    results,
  }

  log.info({ ...summary, costUact: costUact.toString() }, 'GPU bid probe cycle complete')
  if (cycleError) {
    // Surface the partial-cycle error to the scheduler so it can fire
    // gpu-probe-failed without losing the bids that DID land.
    throw new Error(cycleError)
  }
  return summary
}

// ── Rollup ─────────────────────────────────────────────────────────────

/**
 * Compute min / p50 / p90 / max from a sorted bigint array. Caller must
 * pre-sort ascending. Returns null on an empty input.
 *
 * Linear interpolation is intentionally NOT used — at the sample sizes
 * we'll have (10s-100s per model per week), nearest-rank percentiles
 * are easier to reason about and good enough for a UI display value.
 */
export function quantiles(sorted: bigint[]): {
  min: bigint
  p50: bigint
  p90: bigint
  max: bigint
} | null {
  if (sorted.length === 0) return null
  const n = sorted.length
  const idx = (q: number) => {
    // nearest-rank percentile, 1-indexed: ceil(q × n) − 1 in 0-indexed terms,
    // clamped into bounds.
    const rank = Math.max(1, Math.ceil(q * n))
    return Math.min(n, rank) - 1
  }
  return {
    min: sorted[0],
    p50: sorted[idx(0.5)],
    p90: sorted[idx(0.9)],
    max: sorted[n - 1],
  }
}

/**
 * Recompute `gpu_price_summary` from the last `windowDays` of
 * `gpu_bid_observation`. Drops bids ≥ MAX_PROBE_BID_UACT before
 * percentile calc (defensive against ceiling-bidding attacks).
 *
 * Idempotent — safe to run any time. Models that have zero in-window
 * observations are NOT deleted; the previous summary row stays so the
 * UI keeps showing the last-known price during a transient outage.
 */
export async function rollupGpuPrices(
  prisma: PrismaClient,
  windowDays = 7,
): Promise<{ modelsUpdated: number; modelsSkipped: number }> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)

  const rows = await prisma.gpuBidObservation.findMany({
    where: { observedAt: { gte: since } },
    select: {
      gpuModel: true,
      vendor: true,
      providerAddr: true,
      pricePerBlock: true,
    },
  })

  // Group by model.
  type Group = { vendor: string; values: bigint[]; providers: Set<string> }
  const byModel = new Map<string, Group>()
  for (const r of rows) {
    if (r.pricePerBlock >= MAX_PROBE_BID_UACT) continue
    const g = byModel.get(r.gpuModel) ?? {
      vendor: r.vendor,
      values: [] as bigint[],
      providers: new Set<string>(),
    }
    g.values.push(r.pricePerBlock)
    g.providers.add(r.providerAddr)
    byModel.set(r.gpuModel, g)
  }

  const refreshedAt = new Date()
  let updated = 0
  let skipped = 0

  for (const [gpuModel, group] of byModel) {
    group.values.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const q = quantiles(group.values)
    if (!q) {
      skipped++
      continue
    }
    await prisma.gpuPriceSummary.upsert({
      where: { gpuModel },
      create: {
        gpuModel,
        vendor: group.vendor,
        minPricePerBlock: q.min,
        p50PricePerBlock: q.p50,
        p90PricePerBlock: q.p90,
        maxPricePerBlock: q.max,
        sampleCount: group.values.length,
        uniqueProviderCount: group.providers.size,
        windowDays,
        refreshedAt,
      },
      update: {
        vendor: group.vendor,
        minPricePerBlock: q.min,
        p50PricePerBlock: q.p50,
        p90PricePerBlock: q.p90,
        maxPricePerBlock: q.max,
        sampleCount: group.values.length,
        uniqueProviderCount: group.providers.size,
        windowDays,
        refreshedAt,
      },
    })
    updated++
  }

  log.info({ windowDays, modelsUpdated: updated, modelsSkipped: skipped }, 'Rollup complete')
  return { modelsUpdated: updated, modelsSkipped: skipped }
}

// Re-export the SDL ceiling so scheduler / docs consumers don't have to
// reach into the SDL module to size pre-flight balance checks.
export { PROBE_PRICING_CEILING_UACT }
