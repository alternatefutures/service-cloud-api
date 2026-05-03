/**
 * Lease-Close Postmortem — read-only forensic report
 *
 * Buckets every AkashDeployment that was closed in the last N hours by
 * the cron path that almost certainly killed it. No writes, safe to point
 * at production.
 *
 * Five paths can close an ACTIVE lease without user action — see the
 * diagnosis in the latest handoff for the full list. This script
 * disambiguates them by combining:
 *
 *   1. AuditEvent rows where action='health.deployment_closed'
 *      → staleDeploymentSweeper.reconcileActiveDeployments (path 1)
 *      The audit payload carries `reason` (unhealthy / unknown_health /
 *      probe_exception) and `failures`.
 *
 *   2. AkashDeployment.errorMessage signatures:
 *      • "escrow-monitor: closed chain lease …"     → sweepChainOrphans (path 5)
 *      • "Stale deployment detected: stuck in …"     → sweepStaleDeployments
 *      • "Stale deployment swept but on-chain close failed …" → same, on-chain failed
 *      • "No bids in region …"                       → sweepAwaitingRegionResponse
 *      • "Escrow-monitor auto-close failed …"        → escrowHealthMonitor.closeAndSettleDeployment, FAILED branch
 *
 *   3. Mystery closes — status='CLOSED', errorMessage IS NULL, NO matching
 *      audit event. These are either:
 *        • escrowHealthMonitor.closeAndSettleDeployment success branch
 *          (path 4 — neither audit nor errorMessage written), OR
 *        • AkashProvider.autoCloseGhostDeployment (path 3 — same)
 *      Tie-breaker: if `closedAt` clusters within ±5 min of HH:30 UTC
 *      (escrow monitor cron `30 * * * *`) → path 4. Otherwise path 3.
 *
 *   4. Manual / orchestrator closes via `provider.close()` from a resolver
 *      → also leave no audit and no errorMessage. We separate them by
 *      checking for an AuditEvent with action='deployment.close.requested'
 *      or action='lease.close' from source != 'monitor' on the same dseq.
 *
 * Usage:
 *   pnpm tsx scripts/diagnose-lease-closes.ts                    # last 24h
 *   pnpm tsx scripts/diagnose-lease-closes.ts --hours=72         # custom window
 *   pnpm tsx scripts/diagnose-lease-closes.ts --json             # machine-readable
 *   pnpm tsx scripts/diagnose-lease-closes.ts --org=<orgId>      # filter to one org
 *   pnpm tsx scripts/diagnose-lease-closes.ts --dseq=<dseq>      # drill into one lease
 *
 * Point at prod by setting DATABASE_URL inline:
 *   DATABASE_URL="postgresql://…/alternatefutures?sslmode=require" \
 *     pnpm tsx scripts/diagnose-lease-closes.ts --hours=24
 *
 * Strictly read-only: no INSERT/UPDATE/DELETE, no on-chain calls.
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

interface Args {
  hours: number
  json: boolean
  org: string | null
  dseq: string | null
}

function parseArgs(argv: string[]): Args {
  const args: Args = { hours: 24, json: false, org: null, dseq: null }
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true
    else if (a.startsWith('--hours=')) args.hours = Math.max(1, parseInt(a.slice(8), 10) || 24)
    else if (a.startsWith('--org=')) args.org = a.slice(6) || null
    else if (a.startsWith('--dseq=')) args.dseq = a.slice(7) || null
  }
  return args
}

type Path =
  | 'sweeper.unhealthy'
  | 'sweeper.unknown'
  | 'sweeper.probe_exception'
  | 'sweeper.stale_intermediate'
  | 'sweeper.region_await'
  | 'escrow_monitor.chain_orphan'
  | 'escrow_monitor.close_failed'
  | 'mystery.escrow_or_ghost'   // see path 3 vs 4 disambiguation
  | 'mystery.likely_user_close' // matched a non-monitor close audit
  | 'mystery.unattributed'

interface CloseRow {
  deploymentId: string
  dseq: string
  serviceId: string
  serviceSlug: string | null
  serviceName: string | null
  organizationId: string | null
  status: string
  closedAt: Date | null
  updatedAt: Date
  errorMessage: string | null
  path: Path
  evidence: string
  failures?: number
  reason?: string
  auditTraceId?: string
  closeMinuteOfHour?: number  // for escrow-monitor cluster detection
}

interface AuditClose {
  traceId: string
  serviceId: string | null
  deploymentId: string | null
  reason: string | null
  failures: number | null
  source: string
  action: string
  status: string
  timestamp: Date
}

async function loadAuditCloses(prisma: PrismaClient, sinceDate: Date): Promise<AuditClose[]> {
  const rows = await prisma.auditEvent.findMany({
    where: {
      timestamp: { gte: sinceDate },
      OR: [
        { action: 'health.deployment_closed' },
        { action: 'failover.triggered' },
        { action: 'failover.skipped' },
        { action: { startsWith: 'deployment.close' } },
        { action: { startsWith: 'lease.close' } },
      ],
    },
    select: {
      traceId: true,
      serviceId: true,
      deploymentId: true,
      payload: true,
      source: true,
      action: true,
      status: true,
      timestamp: true,
    },
  })
  return rows.map(r => {
    const payload = (r.payload ?? {}) as Record<string, unknown>
    return {
      traceId: r.traceId,
      serviceId: r.serviceId,
      deploymentId: r.deploymentId,
      reason: typeof payload.reason === 'string' ? payload.reason : null,
      failures: typeof payload.failures === 'number' ? payload.failures : null,
      source: r.source,
      action: r.action,
      status: r.status,
      timestamp: r.timestamp,
    }
  })
}

function classify(
  d: {
    id: string
    dseq: bigint
    status: string
    closedAt: Date | null
    updatedAt: Date
    errorMessage: string | null
  },
  audits: AuditClose[]
): { path: Path; evidence: string; reason?: string; failures?: number; traceId?: string } {
  const sweeperAudit = audits.find(a => a.action === 'health.deployment_closed' && a.deploymentId === d.id)
  if (sweeperAudit) {
    const reason = sweeperAudit.reason ?? 'unhealthy'
    const path: Path =
      reason === 'unknown_health' ? 'sweeper.unknown'
      : reason === 'probe_exception' ? 'sweeper.probe_exception'
      : 'sweeper.unhealthy'
    return {
      path,
      evidence: `AuditEvent action=health.deployment_closed reason=${reason} failures=${sweeperAudit.failures ?? '?'}`,
      reason,
      failures: sweeperAudit.failures ?? undefined,
      traceId: sweeperAudit.traceId,
    }
  }

  const msg = d.errorMessage ?? ''
  if (/^escrow-monitor:/i.test(msg)) {
    return { path: 'escrow_monitor.chain_orphan', evidence: `errorMessage matches sweepChainOrphans signature` }
  }
  if (/^Escrow-monitor auto-close failed/i.test(msg)) {
    return { path: 'escrow_monitor.close_failed', evidence: `errorMessage matches closeAndSettleDeployment FAILED branch` }
  }
  if (/^Stale deployment/i.test(msg)) {
    return { path: 'sweeper.stale_intermediate', evidence: `errorMessage matches sweepStaleDeployments signature` }
  }
  if (/^No bids in region/i.test(msg)) {
    return { path: 'sweeper.region_await', evidence: `errorMessage matches sweepAwaitingRegionResponse signature` }
  }

  // Mystery — no audit, no errorMessage. Could be:
  //  (a) escrowHealthMonitor.closeAndSettleDeployment success path, or
  //  (b) autoCloseGhostDeployment (provider returned 404), or
  //  (c) a user-initiated close via the GraphQL/REST resolver.
  const userClose = audits.find(
    a =>
      a.deploymentId === d.id &&
      a.source !== 'monitor' &&
      (a.action.startsWith('deployment.close') || a.action.startsWith('lease.close')),
  )
  if (userClose) {
    return {
      path: 'mystery.likely_user_close',
      evidence: `Non-monitor audit action=${userClose.action} source=${userClose.source}`,
      traceId: userClose.traceId,
    }
  }

  if (d.closedAt) {
    const minute = d.closedAt.getUTCMinutes()
    const inEscrowWindow = minute >= 25 && minute <= 35
    if (inEscrowWindow) {
      return {
        path: 'mystery.escrow_or_ghost',
        evidence: `closedAt minute=${minute} ∈ [25..35] → likely escrowHealthMonitor.closeAndSettleDeployment (cron 30 * * * *)`,
      }
    }
    return {
      path: 'mystery.escrow_or_ghost',
      evidence: `closedAt minute=${minute} outside [25..35] → likely autoCloseGhostDeployment (provider returned 404)`,
    }
  }

  return { path: 'mystery.unattributed', evidence: 'no audit, no errorMessage, no closedAt' }
}

const PATH_DESCRIPTIONS: Record<Path, string> = {
  'sweeper.unhealthy':
    'staleDeploymentSweeper saw lease-status containers=[] (or "unhealthy") — UNHEALTHY_THRESHOLD=1, killed in 1 tick.',
  'sweeper.unknown':
    'staleDeploymentSweeper saw 3 consecutive "unknown" health probes (UNKNOWN_THRESHOLD=3).',
  'sweeper.probe_exception':
    'staleDeploymentSweeper getHealth() threw 3+ times consecutively (EXCEPTION_THRESHOLD=3).',
  'sweeper.stale_intermediate':
    'staleDeploymentSweeper.sweepStaleDeployments — row stuck in CREATING/WAITING_BIDS/etc for >25 min. Should NOT hit ACTIVE.',
  'sweeper.region_await':
    'staleDeploymentSweeper.sweepAwaitingRegionResponse — AWAITING_REGION_RESPONSE >5 min. Should NOT hit ACTIVE.',
  'escrow_monitor.chain_orphan':
    'escrowHealthMonitor.sweepChainOrphans — DB row was SUSPENDED/CLOSED/etc but chain still had a lease. Closed it.',
  'escrow_monitor.close_failed':
    'escrowHealthMonitor.closeAndSettleDeployment FAILED branch — chain query said gone, on-chain close TX failed → CLOSE_FAILED.',
  'mystery.escrow_or_ghost':
    'No audit, no errorMessage. Either escrowHealthMonitor.closeAndSettleDeployment success branch (cron :30) or AkashProvider.autoCloseGhostDeployment (404 → instant close).',
  'mystery.likely_user_close':
    'Non-monitor audit found nearby — most likely a user-initiated close via the resolver/CLI.',
  'mystery.unattributed':
    'CLOSED row with no audit, no errorMessage, no closedAt — investigate manually.',
}

async function main() {
  const args = parseArgs(process.argv)
  const sinceDate = new Date(Date.now() - args.hours * 60 * 60 * 1000)
  const prisma = new PrismaClient()

  try {
    // We want every row whose lease was terminated in the window.
    // `closedAt` is set by every close path (sweeper, escrow monitor,
    // autoCloseGhostDeployment, manual). Rows without `closedAt` are
    // either still ACTIVE or ended pre-chain (negative dseq) — neither
    // is interesting for this postmortem.
    const where: Record<string, unknown> = {
      closedAt: { gte: sinceDate },
    }

    if (args.dseq) {
      where.dseq = BigInt(args.dseq)
    }
    if (args.org) {
      where.service = { project: { organizationId: args.org } }
    }

    const closed = await prisma.akashDeployment.findMany({
      where,
      orderBy: [{ closedAt: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true,
        dseq: true,
        status: true,
        closedAt: true,
        updatedAt: true,
        errorMessage: true,
        serviceId: true,
        service: {
          select: {
            slug: true,
            name: true,
            project: { select: { organizationId: true } },
          },
        },
      },
    })

    const audits = await loadAuditCloses(prisma, sinceDate)

    const rows: CloseRow[] = closed
      .filter(d => d.dseq && d.dseq > 0n)
      .map(d => {
        const verdict = classify(
          {
            id: d.id,
            dseq: d.dseq,
            status: d.status,
            closedAt: d.closedAt,
            updatedAt: d.updatedAt,
            errorMessage: d.errorMessage,
          },
          audits,
        )
        return {
          deploymentId: d.id,
          dseq: d.dseq.toString(),
          serviceId: d.serviceId,
          serviceSlug: d.service?.slug ?? null,
          serviceName: d.service?.name ?? null,
          organizationId: d.service?.project?.organizationId ?? null,
          status: d.status,
          closedAt: d.closedAt,
          updatedAt: d.updatedAt,
          errorMessage: d.errorMessage,
          path: verdict.path,
          evidence: verdict.evidence,
          reason: verdict.reason,
          failures: verdict.failures,
          auditTraceId: verdict.traceId,
          closeMinuteOfHour: d.closedAt?.getUTCMinutes(),
        }
      })

    const summary: Record<Path, number> = {
      'sweeper.unhealthy': 0,
      'sweeper.unknown': 0,
      'sweeper.probe_exception': 0,
      'sweeper.stale_intermediate': 0,
      'sweeper.region_await': 0,
      'escrow_monitor.chain_orphan': 0,
      'escrow_monitor.close_failed': 0,
      'mystery.escrow_or_ghost': 0,
      'mystery.likely_user_close': 0,
      'mystery.unattributed': 0,
    }
    for (const r of rows) summary[r.path]++

    const stillActive = await prisma.akashDeployment.count({ where: { status: 'ACTIVE' } })
    const totalKnown = await prisma.akashDeployment.count()

    if (args.json) {
      console.log(JSON.stringify({
        windowHours: args.hours,
        sinceDate: sinceDate.toISOString(),
        databaseUrlHost: maskDbHost(process.env.DATABASE_URL),
        totals: { stillActive, totalKnown, closedInWindow: rows.length },
        summary,
        rows,
      }, null, 2))
      return
    }

    console.log(`╔══════════════════════════════════════════════════════════════════════════╗`)
    console.log(`║  Lease-Close Postmortem`)
    console.log(`║  DB host:        ${maskDbHost(process.env.DATABASE_URL)}`)
    console.log(`║  Window:         last ${args.hours}h (since ${sinceDate.toISOString()})`)
    if (args.org) console.log(`║  Filter org:     ${args.org}`)
    if (args.dseq) console.log(`║  Filter dseq:    ${args.dseq}`)
    console.log(`║  Closed in win:  ${rows.length}`)
    console.log(`║  Still ACTIVE:   ${stillActive} (of ${totalKnown} total)`)
    console.log(`║  Audit rows:     ${audits.length}`)
    console.log(`╚══════════════════════════════════════════════════════════════════════════╝`)
    console.log()
    console.log(`Closes by path:`)
    const sorted = (Object.entries(summary) as Array<[Path, number]>)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
    if (sorted.length === 0) {
      console.log(`  (none — no rows matched the window)`)
    } else {
      for (const [path, n] of sorted) {
        console.log(`  ${n.toString().padStart(4)} × ${path}`)
        console.log(`           ${PATH_DESCRIPTIONS[path]}`)
      }
    }
    console.log()

    const offenders: Array<[Path, number]> = sorted.filter(([p]) => p.startsWith('sweeper.') || p.startsWith('escrow_monitor.') || p.startsWith('mystery.'))
    if (offenders.length > 0) {
      console.log(`Top closures (most recent first, max 30):`)
      console.log()
      const display = rows.slice(0, 30)
      for (const r of display) {
        const ts = r.closedAt?.toISOString() ?? r.updatedAt.toISOString()
        const slug = r.serviceSlug ?? '?'
        console.log(`  [${ts}] dseq=${r.dseq} svc=${slug} status=${r.status}`)
        console.log(`     PATH:     ${r.path}`)
        console.log(`     EVIDENCE: ${r.evidence}`)
        if (r.organizationId) console.log(`     org:      ${r.organizationId}`)
        if (r.auditTraceId) console.log(`     trace:    ${r.auditTraceId}`)
        if (r.errorMessage) console.log(`     errorMsg: ${r.errorMessage.slice(0, 160)}`)
        console.log()
      }
      if (rows.length > 30) {
        console.log(`  … and ${rows.length - 30} more. Re-run with --json for the full list.`)
        console.log()
      }
    }

    // Headline diagnosis
    const sweeperKills = summary['sweeper.unhealthy'] + summary['sweeper.unknown'] + summary['sweeper.probe_exception']
    const escrowKills = summary['escrow_monitor.chain_orphan'] + summary['escrow_monitor.close_failed']
    const mysteryKills = summary['mystery.escrow_or_ghost'] + summary['mystery.unattributed']
    const userKills = summary['mystery.likely_user_close']

    console.log(`──────────────────────────────────────────────────────────────────────────`)
    console.log(`Headline diagnosis:`)
    console.log(`  Sweeper closes:          ${sweeperKills}  (path 1 — UNHEALTHY_THRESHOLD=1 problem)`)
    console.log(`  Escrow-monitor closes:   ${escrowKills}  (paths 4–5 — chain query / orphan sweep)`)
    console.log(`  Mystery (no audit):      ${mysteryKills}  (paths 3–4 — autoCloseGhost OR escrow success branch)`)
    console.log(`  User-initiated closes:   ${userKills}`)
    if (sweeperKills > 0 && sweeperKills >= escrowKills && sweeperKills >= mysteryKills) {
      console.log()
      console.log(`  ⇒ STRONGLY suggests staleDeploymentSweeper.reconcileActiveDeployments`)
      console.log(`    is the killer. Fix in service-cloud-api/src/services/queue/staleDeploymentSweeper.ts:192`)
      console.log(`    (UNHEALTHY_THRESHOLD = 1) and akashProvider.ts:243-250 (empty containers → 'unhealthy').`)
    } else if (mysteryKills > sweeperKills && mysteryKills > escrowKills) {
      console.log()
      console.log(`  ⇒ STRONGLY suggests autoCloseGhostDeployment (akashProvider.ts:262-268)`)
      console.log(`    or escrowHealthMonitor.closeAndSettleDeployment success branch.`)
      console.log(`    Look at the closeMinuteOfHour distribution above — clusters at 25-35 = escrow monitor.`)
    } else if (escrowKills > sweeperKills) {
      console.log()
      console.log(`  ⇒ STRONGLY suggests escrowHealthMonitor (escrowHealthMonitor.ts).`)
      console.log(`    Check fetchAllEscrowBalances output for partial responses.`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

function maskDbHost(url?: string): string {
  if (!url) return '(unset)'
  try {
    const u = new URL(url)
    return `${u.hostname}:${u.port || '5432'}/${u.pathname.slice(1)}`
  } catch {
    return '(unparseable)'
  }
}

main().catch(err => {
  console.error('diagnose-lease-closes failed:', err)
  process.exit(1)
})
