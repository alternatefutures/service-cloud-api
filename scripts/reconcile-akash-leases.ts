/**
 * Akash Lease ↔ DB Reconciler
 *
 * Compares the live set of ACTIVE deployments on the Akash chain with the
 * AkashDeployment rows in the local database and reports:
 *
 *   • ORPHANS   — chain says ACTIVE, DB has no row for this dseq at all.
 *                 These leak escrow forever (the per-dseq age threshold in
 *                 `escrowHealthMonitor.sweepChainOrphans` skips chain-mid-flow
 *                 candidates, but persistent orphans should be 0).
 *
 *   • SUSPENDED-LEAK
 *                 chain says ACTIVE, DB row is SUSPENDED / CLOSED /
 *                 PERMANENTLY_FAILED. The on-chain close FAILED at suspend
 *                 time (or was never attempted). Escrow is still draining —
 *                 the existing `sweepChainOrphans` helper deliberately
 *                 SKIPS dseqs the DB knows about, so these never get
 *                 cleaned up automatically. This script closes them.
 *
 *   • ZOMBIES   — DB says ACTIVE, chain has no entry. The sweeper's
 *                 hourly billing pass marks these CLOSED, but if you're
 *                 hunting "DB shows active, console shows nothing" this
 *                 is your list.
 *
 *   • MISMATCH  — chain says CLOSED but DB still says ACTIVE. Same
 *                 fix path as ZOMBIES (DB needs to be updated).
 *
 * Usage:
 *   pnpm tsx scripts/reconcile-akash-leases.ts                 # dry-run report
 *   pnpm tsx scripts/reconcile-akash-leases.ts --close-orphans # close ORPHAN + SUSPENDED-LEAK on chain
 *   pnpm tsx scripts/reconcile-akash-leases.ts --fix-zombies   # mark ZOMBIE/MISMATCH rows CLOSED in DB
 *   pnpm tsx scripts/reconcile-akash-leases.ts --json          # machine-readable output
 *
 * Pulls the deployer wallet address from `akash keys show` (NEVER from the
 * DB owner column — see escrowHealthMonitor's defense-in-depth comment).
 */

import 'dotenv/config'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PrismaClient } from '@prisma/client'
import { getAkashEnv } from '../src/lib/akashEnv'
import { getAkashOrchestrator } from '../src/services/akash/orchestrator'

const execFileAsync = promisify(execFile)

const AKASH_CLI = process.env.AKASH_CLI_PATH || 'akash'
const QUERY_TIMEOUT_MS = 90_000

interface ChainEscrow {
  dseq: string
  fundsUact: number
  transferredUact: number
  settledAtBlock: number
  state: 'open' | 'closed' | string
}

interface DbRow {
  id: string
  dseq: bigint
  status: string
  serviceId: string
  serviceName: string | null
  serviceSlug: string | null
  organizationId: string | null
  createdAt: Date
  updatedAt: Date
  closedAt: Date | null
  errorMessage: string | null
  pricePerBlock: string | null
}

async function runAkash(args: string[]): Promise<string> {
  const env = getAkashEnv({ skipMnemonicCheck: true })
  const { stdout } = await execFileAsync(AKASH_CLI, args, {
    env,
    timeout: QUERY_TIMEOUT_MS,
    maxBuffer: 20 * 1024 * 1024,
  })
  return stdout
}

async function resolveDeployerAddress(): Promise<string> {
  const keyName = process.env.AKASH_KEY_NAME || 'default'
  const out = await runAkash(['keys', 'show', keyName, '-a'])
  const addr = out.trim()
  if (!addr) throw new Error('Could not resolve deployer wallet address via `akash keys show`')
  return addr
}

async function fetchChainEscrows(owner: string, state?: 'active' | 'closed'): Promise<Map<string, ChainEscrow>> {
  const args = ['query', 'deployment', 'list', '--owner', owner, '-o', 'json']
  if (state) args.push('--state', state)
  const out = await runAkash(args)
  const data = JSON.parse(out)
  const map = new Map<string, ChainEscrow>()
  const deployments: any[] = data?.deployments || []

  for (const d of deployments) {
    const dseq = d?.deployment?.id?.dseq || d?.deployment?.deployment_id?.dseq
    if (!dseq) continue
    const escrowState = d?.escrow_account?.state || d?.escrow_account || {}
    const state = escrowState.state ?? 'open'
    const funds: Array<{ denom: string; amount: string }> = escrowState.funds || []
    const transferred: Array<{ denom: string; amount: string }> = escrowState.transferred || []
    const fundsUact = Math.floor(parseFloat(funds.find((f) => f.denom === 'uact')?.amount || '0')) || 0
    const transferredUact = Math.floor(parseFloat(transferred.find((f) => f.denom === 'uact')?.amount || '0')) || 0
    const settledAtBlock = parseInt(String(escrowState.settled_at || '0'), 10) || 0

    map.set(String(dseq), {
      dseq: String(dseq),
      fundsUact,
      transferredUact,
      settledAtBlock,
      state,
    })
  }
  return map
}

async function loadDbRows(prisma: PrismaClient): Promise<Map<string, DbRow>> {
  const rows = await prisma.akashDeployment.findMany({
    select: {
      id: true,
      dseq: true,
      status: true,
      serviceId: true,
      createdAt: true,
      updatedAt: true,
      closedAt: true,
      errorMessage: true,
      pricePerBlock: true,
      service: {
        select: {
          name: true,
          slug: true,
          project: { select: { organizationId: true } },
        },
      },
    },
  })
  const map = new Map<string, DbRow>()
  for (const r of rows) {
    if (!r.dseq || r.dseq <= 0n) continue // skip negative-dseq placeholders (pre-chain failures)
    map.set(r.dseq.toString(), {
      id: r.id,
      dseq: r.dseq,
      status: r.status,
      serviceId: r.serviceId,
      serviceName: r.service?.name ?? null,
      serviceSlug: r.service?.slug ?? null,
      organizationId: r.service?.project?.organizationId ?? null,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      closedAt: r.closedAt,
      errorMessage: r.errorMessage,
      pricePerBlock: r.pricePerBlock,
    })
  }
  return map
}

interface ReconciliationReport {
  chainActive: number
  dbTotal: number
  orphans: Array<{ dseq: string; fundsUact: number; settledAtBlock: number }>
  suspendedLeaks: Array<{ dseq: string; dbStatus: string; serviceSlug: string | null; orgId: string | null; updatedAt: string }>
  zombies: Array<{ dseq: string; serviceSlug: string | null; updatedAt: string; pricePerBlock: string | null }>
  mismatches: Array<{ dseq: string; serviceSlug: string | null; dbStatus: string; chainState: string }>
  active: Array<{ dseq: string; serviceSlug: string | null; updatedAt: string }>
}

async function buildReport(prisma: PrismaClient, owner: string): Promise<ReconciliationReport> {
  console.error(`Owner: ${owner}`)
  console.error('Fetching chain escrows (active state) …')
  const chainActive = await fetchChainEscrows(owner, 'active')
  console.error(`  ${chainActive.size} active dseqs on chain`)

  console.error('Loading DB rows …')
  const dbRows = await loadDbRows(prisma)
  console.error(`  ${dbRows.size} dseqs in DB`)

  const TERMINAL = new Set(['CLOSED', 'PERMANENTLY_FAILED', 'FAILED'])
  const NEEDS_CHAIN_OPEN = new Set(['SUSPENDED']) // intentionally chain-closed, DB-paused

  const orphans: ReconciliationReport['orphans'] = []
  const suspendedLeaks: ReconciliationReport['suspendedLeaks'] = []
  const zombies: ReconciliationReport['zombies'] = []
  const mismatches: ReconciliationReport['mismatches'] = []
  const active: ReconciliationReport['active'] = []

  for (const [dseq, chain] of chainActive) {
    const db = dbRows.get(dseq)
    if (!db) {
      orphans.push({ dseq, fundsUact: chain.fundsUact, settledAtBlock: chain.settledAtBlock })
      continue
    }
    if (db.status === 'ACTIVE') {
      active.push({ dseq, serviceSlug: db.serviceSlug, updatedAt: db.updatedAt.toISOString() })
      continue
    }
    if (TERMINAL.has(db.status) || NEEDS_CHAIN_OPEN.has(db.status)) {
      suspendedLeaks.push({
        dseq,
        dbStatus: db.status,
        serviceSlug: db.serviceSlug,
        orgId: db.organizationId,
        updatedAt: db.updatedAt.toISOString(),
      })
    }
  }

  for (const [dseq, db] of dbRows) {
    if (db.status !== 'ACTIVE') continue
    const chain = chainActive.get(dseq)
    if (!chain) {
      zombies.push({
        dseq,
        serviceSlug: db.serviceSlug,
        updatedAt: db.updatedAt.toISOString(),
        pricePerBlock: db.pricePerBlock,
      })
    } else if (chain.state !== 'open') {
      mismatches.push({
        dseq,
        serviceSlug: db.serviceSlug,
        dbStatus: db.status,
        chainState: chain.state,
      })
    }
  }

  return {
    chainActive: chainActive.size,
    dbTotal: dbRows.size,
    orphans,
    suspendedLeaks,
    zombies,
    mismatches,
    active,
  }
}

function printHumanReport(r: ReconciliationReport, owner: string) {
  const fmt = (n: number) => n.toLocaleString()
  console.log(`\n=== Akash Lease Reconciliation Report ===`)
  console.log(`Wallet : ${owner}`)
  console.log(`Chain  : ${fmt(r.chainActive)} active deployment(s)`)
  console.log(`DB     : ${fmt(r.dbTotal)} dseqs ever recorded`)
  console.log(``)
  console.log(`SUMMARY`)
  console.log(`  ✔ healthy active (chain + DB align) : ${fmt(r.active.length)}`)
  console.log(`  ⚠ ORPHANS        (chain only)       : ${fmt(r.orphans.length)}`)
  console.log(`  ⚠ SUSPENDED-LEAK (chain ACTIVE,     : ${fmt(r.suspendedLeaks.length)}`)
  console.log(`                    DB SUSPENDED/CLOSED)`)
  console.log(`  ⚠ ZOMBIES        (DB ACTIVE,        : ${fmt(r.zombies.length)}`)
  console.log(`                    chain missing)`)
  console.log(`  ⚠ MISMATCH       (DB ACTIVE,        : ${fmt(r.mismatches.length)}`)
  console.log(`                    chain CLOSED)`)

  if (r.orphans.length) {
    console.log(`\nORPHANS (close with --close-orphans):`)
    for (const o of r.orphans) {
      const act = (o.fundsUact / 1_000_000).toFixed(4)
      console.log(`  dseq=${o.dseq.padEnd(10)}  funds=${act} ACT  settledAtBlock=${o.settledAtBlock}`)
    }
  }

  if (r.suspendedLeaks.length) {
    console.log(`\nSUSPENDED-LEAK (close with --close-orphans):`)
    for (const s of r.suspendedLeaks) {
      console.log(
        `  dseq=${s.dseq.padEnd(10)}  status=${s.dbStatus.padEnd(20)} ` +
          `service=${s.serviceSlug ?? '?'}  org=${s.orgId ?? '?'}  updatedAt=${s.updatedAt}`,
      )
    }
  }

  if (r.zombies.length) {
    console.log(`\nZOMBIES (mark CLOSED with --fix-zombies):`)
    for (const z of r.zombies) {
      console.log(`  dseq=${z.dseq.padEnd(10)}  service=${z.serviceSlug ?? '?'}  updatedAt=${z.updatedAt}`)
    }
  }

  if (r.mismatches.length) {
    console.log(`\nMISMATCH (mark CLOSED with --fix-zombies):`)
    for (const m of r.mismatches) {
      console.log(`  dseq=${m.dseq.padEnd(10)}  service=${m.serviceSlug ?? '?'}  dbStatus=${m.dbStatus}  chainState=${m.chainState}`)
    }
  }

  if (!r.orphans.length && !r.suspendedLeaks.length && !r.zombies.length && !r.mismatches.length) {
    console.log(`\nAll clear — chain and DB agree.`)
  }
}

async function closeOnChain(prisma: PrismaClient, dseqs: string[], dryRun: boolean): Promise<void> {
  if (!dseqs.length) return
  console.log(`\n${dryRun ? '[DRY-RUN] Would close' : 'Closing'} ${dseqs.length} dseq(s) on-chain …`)
  if (dryRun) return

  const orchestrator = getAkashOrchestrator(prisma)
  for (const dseq of dseqs) {
    try {
      const result = await orchestrator.closeDeployment(Number(dseq))
      if (result.chainStatus === 'FAILED') {
        console.error(`  ✗ dseq=${dseq}  FAILED  ${result.error}`)
        continue
      }
      console.log(`  ✓ dseq=${dseq}  ${result.chainStatus}`)
      // Best-effort DB sync: if a row exists in any non-terminal state, mark CLOSED.
      await prisma.akashDeployment.updateMany({
        where: { dseq: BigInt(dseq), NOT: { status: { in: ['CLOSED', 'PERMANENTLY_FAILED'] } } },
        data: { status: 'CLOSED', closedAt: new Date() },
      })
    } catch (err) {
      console.error(`  ✗ dseq=${dseq}  threw  ${(err as Error).message}`)
    }
  }
}

async function fixZombies(
  prisma: PrismaClient,
  rows: Array<{ dseq: string; serviceSlug: string | null }>,
  reason: string,
  dryRun: boolean,
): Promise<void> {
  if (!rows.length) return
  console.log(`\n${dryRun ? '[DRY-RUN] Would mark' : 'Marking'} ${rows.length} DB row(s) CLOSED (${reason}) …`)
  if (dryRun) return
  for (const z of rows) {
    const r = await prisma.akashDeployment.updateMany({
      where: { dseq: BigInt(z.dseq), status: 'ACTIVE' },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        errorMessage: `reconciler: ${reason} (synced ${new Date().toISOString()})`,
      },
    })
    console.log(`  ${r.count > 0 ? '✓' : '·'} dseq=${z.dseq.padEnd(10)} service=${z.serviceSlug ?? '?'}  count=${r.count}`)
  }
}

async function main() {
  const args = process.argv.slice(2)
  const closeOrphansFlag = args.includes('--close-orphans')
  const fixZombiesFlag = args.includes('--fix-zombies')
  const jsonOnly = args.includes('--json')

  const prisma = new PrismaClient()
  try {
    const owner = await resolveDeployerAddress()
    const report = await buildReport(prisma, owner)

    if (jsonOnly) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      printHumanReport(report, owner)
    }

    if (closeOrphansFlag) {
      const targets = [
        ...report.orphans.map((o) => o.dseq),
        ...report.suspendedLeaks.map((s) => s.dseq),
      ]
      await closeOnChain(prisma, targets, false)
    } else if (report.orphans.length || report.suspendedLeaks.length) {
      console.log(`\nRe-run with --close-orphans to close on-chain.`)
    }

    if (fixZombiesFlag) {
      await fixZombies(prisma, report.zombies, 'chain reports no entry for this dseq', false)
      await fixZombies(prisma, report.mismatches, 'chain reports CLOSED but DB still ACTIVE', false)
    } else if (report.zombies.length || report.mismatches.length) {
      console.log(`\nRe-run with --fix-zombies to mark stale DB rows CLOSED.`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
