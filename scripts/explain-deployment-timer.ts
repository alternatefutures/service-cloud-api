/**
 * Explain why a service's "Running for Xh" timer shows what it shows.
 *
 * Walks the AkashDeployment / PhalaDeployment chain (failoverParentId →
 * resumedFromId → parentDeploymentId) for the most recent ACTIVE deployment
 * of the given service and prints:
 *
 *   - the chain root (the row whose `deployedAt` becomes "Running since")
 *   - every link in the chain with timestamps and the reason it was created
 *     (queue retry / failover / resume)
 *   - related AuditEvent rows in the same window (lease.closed,
 *     deployment.submitted, failover.triggered, billing.suspend,
 *     billing.resume) so a human can correlate timer resets to billing or
 *     provider events
 *
 * Usage:
 *   pnpm tsx scripts/explain-deployment-timer.ts <serviceIdOrSlug>
 *   pnpm tsx scripts/explain-deployment-timer.ts <serviceSlug> --hours=72
 *   pnpm tsx scripts/explain-deployment-timer.ts dseq:26511357
 */

import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

interface ChainNode {
  id: string
  status: string
  createdAt: Date
  deployedAt: Date | null
  closedAt: Date | null
  dseq: bigint
  provider: string | null
  failoverParentId: string | null
  resumedFromId: string | null
  parentDeploymentId: string | null
  errorMessage: string | null
}

async function loadAkashChain(headId: string): Promise<ChainNode[]> {
  const chain: ChainNode[] = []
  const seen = new Set<string>()
  let cursorId: string | null = headId
  while (cursorId && !seen.has(cursorId) && chain.length < 100) {
    seen.add(cursorId)
    const row = await prisma.akashDeployment.findUnique({
      where: { id: cursorId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        deployedAt: true,
        closedAt: true,
        dseq: true,
        provider: true,
        failoverParentId: true,
        resumedFromId: true,
        parentDeploymentId: true,
        errorMessage: true,
      },
    })
    if (!row) break
    chain.push(row)
    cursorId =
      row.failoverParentId ?? row.resumedFromId ?? row.parentDeploymentId
  }
  return chain
}

interface PhalaChainNode {
  id: string
  status: string
  createdAt: Date
  activeStartedAt: Date | null
  appId: string
  resumedFromId: string | null
  parentDeploymentId: string | null
  errorMessage: string | null
}

async function loadPhalaChain(headId: string): Promise<PhalaChainNode[]> {
  const chain: PhalaChainNode[] = []
  const seen = new Set<string>()
  let cursorId: string | null = headId
  while (cursorId && !seen.has(cursorId) && chain.length < 100) {
    seen.add(cursorId)
    const row = await prisma.phalaDeployment.findUnique({
      where: { id: cursorId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        activeStartedAt: true,
        appId: true,
        resumedFromId: true,
        parentDeploymentId: true,
        errorMessage: true,
      },
    })
    if (!row) break
    chain.push(row)
    cursorId = row.resumedFromId ?? row.parentDeploymentId
  }
  return chain
}

function chainReason(prev: ChainNode | undefined, curr: ChainNode): string {
  if (!prev) return 'head'
  if (prev.failoverParentId === curr.id) return 'failover'
  if (prev.resumedFromId === curr.id) return 'resume'
  if (prev.parentDeploymentId === curr.id) return 'queue-retry'
  return 'unknown'
}

function phalaChainReason(prev: PhalaChainNode | undefined, curr: PhalaChainNode): string {
  if (!prev) return 'head'
  if (prev.resumedFromId === curr.id) return 'resume'
  if (prev.parentDeploymentId === curr.id) return 'queue-retry'
  return 'unknown'
}

function fmtAge(d: Date): string {
  const ms = Date.now() - d.getTime()
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  return `${h}h ${m}m ago`
}

async function explain(serviceArg: string, hours: number) {
  // Resolve the service. Accept id, slug, or dseq:<n>.
  let service: { id: string; name: string; slug: string } | null = null
  if (serviceArg.startsWith('dseq:')) {
    const dseq = BigInt(serviceArg.slice(5))
    const dep = await prisma.akashDeployment.findFirst({
      where: { dseq },
      select: { service: { select: { id: true, name: true, slug: true } } },
    })
    service = dep?.service ?? null
  } else {
    service =
      (await prisma.service.findUnique({
        where: { id: serviceArg },
        select: { id: true, name: true, slug: true },
      })) ??
      (await prisma.service.findFirst({
        where: { slug: serviceArg },
        select: { id: true, name: true, slug: true },
      }))
  }

  if (!service) {
    console.error(`Could not resolve service: ${serviceArg}`)
    process.exit(1)
  }

  console.log(`\nService: ${service.name} (slug=${service.slug}, id=${service.id})`)

  // Most-recent deployments of each kind
  const headAkash = await prisma.akashDeployment.findFirst({
    where: { serviceId: service.id, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  })
  const headPhala = await prisma.phalaDeployment.findFirst({
    where: { serviceId: service.id, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  })

  if (headAkash) {
    console.log(`\n=== Akash chain (head: ${headAkash.id}, dseq=${headAkash.dseq}) ===`)
    const chain = await loadAkashChain(headAkash.id)
    let firstDeployedAt: Date | null = null
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i]!
      const reason = chainReason(chain[i - 1], node)
      if (node.deployedAt && (!firstDeployedAt || node.deployedAt < firstDeployedAt)) {
        firstDeployedAt = node.deployedAt
      }
      console.log(
        `  [${String(i).padStart(2, '0')}] ${node.id}  ${reason.padEnd(12)} ` +
          `dseq=${node.dseq}  status=${node.status.padEnd(20)} ` +
          `created=${node.createdAt.toISOString()}  deployedAt=${node.deployedAt?.toISOString() ?? '-'}` +
          (node.closedAt ? `  closedAt=${node.closedAt.toISOString()}` : '') +
          (node.errorMessage ? `  err=${node.errorMessage.slice(0, 80)}` : ''),
      )
    }
    console.log(`\n  Computed activeSince: ${firstDeployedAt?.toISOString() ?? 'null'}`)
    if (firstDeployedAt) console.log(`  → "Running for ${fmtAge(firstDeployedAt)}"`)
  } else {
    console.log(`\nNo ACTIVE Akash deployment for this service.`)
  }

  if (headPhala) {
    console.log(`\n=== Phala chain (head: ${headPhala.id}) ===`)
    const chain = await loadPhalaChain(headPhala.id)
    let firstActive: Date | null = null
    for (let i = 0; i < chain.length; i++) {
      const node = chain[i]!
      const reason = phalaChainReason(chain[i - 1], node)
      if (node.activeStartedAt && (!firstActive || node.activeStartedAt < firstActive)) {
        firstActive = node.activeStartedAt
      }
      console.log(
        `  [${String(i).padStart(2, '0')}] ${node.id}  ${reason.padEnd(12)} ` +
          `appId=${node.appId.slice(0, 12)}…  status=${node.status.padEnd(20)} ` +
          `created=${node.createdAt.toISOString()}  activeStartedAt=${node.activeStartedAt?.toISOString() ?? '-'}` +
          (node.errorMessage ? `  err=${node.errorMessage.slice(0, 80)}` : ''),
      )
    }
    console.log(`\n  Computed activeSince: ${firstActive?.toISOString() ?? 'null'}`)
    if (firstActive) console.log(`  → "Running for ${fmtAge(firstActive)}"`)
  } else {
    console.log(`\nNo ACTIVE Phala deployment for this service.`)
  }

  // Pull related audit events from the requested window so the operator can
  // confirm WHICH event reset the timer (suspend/resume vs failover vs
  // queue retry).
  const since = new Date(Date.now() - hours * 3_600_000)
  console.log(`\n=== Audit events for service in last ${hours}h ===`)
  const events = await prisma.auditEvent.findMany({
    where: {
      serviceId: service.id,
      timestamp: { gte: since },
      action: {
        in: [
          'lease.closed',
          'deployment.submitted',
          'deployment.requested',
          'failover.triggered',
          'failover.skipped',
          'billing.suspend',
          'billing.resume',
          'billing.suspended',
          'billing.resumed',
          'health.deployment_closed',
        ],
      },
    },
    orderBy: { timestamp: 'asc' },
    select: { timestamp: true, action: true, status: true, deploymentId: true, payload: true },
  })

  if (events.length === 0) {
    console.log(`  (no relevant audit events in window)`)
  } else {
    for (const e of events) {
      console.log(
        `  ${e.timestamp.toISOString()}  ${e.action.padEnd(30)}  ${e.status.padEnd(5)} ` +
          `dep=${(e.deploymentId ?? '-').slice(0, 8)}  ` +
          `payload=${JSON.stringify(e.payload).slice(0, 140)}`,
      )
    }
  }

  console.log(``)
}

async function main() {
  const args = process.argv.slice(2)
  const positional = args.filter((a) => !a.startsWith('--'))
  if (positional.length === 0) {
    console.error('Usage: pnpm tsx scripts/explain-deployment-timer.ts <serviceIdOrSlug|dseq:N> [--hours=72]')
    process.exit(1)
  }
  const hoursArg = args.find((a) => a.startsWith('--hours='))
  const hours = hoursArg ? parseInt(hoursArg.split('=')[1] ?? '72', 10) : 72
  for (const arg of positional) {
    await explain(arg, hours)
  }
  await prisma.$disconnect()
}

main().catch(async (err) => {
  console.error(err)
  await prisma.$disconnect()
  process.exit(1)
})
