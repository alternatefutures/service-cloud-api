/**
 * One-shot: list every active Spheron upstream deployment for our team
 * and cross-reference against the local DB. Anything upstream that has
 * no local row OR has a local row already marked DELETED is a true
 * orphan from a dev:reset / failed-write window.
 *
 * Pass --dry-run (default) to only list. Pass --delete to actually
 * DELETE the orphans (will respect Spheron's 20-min minimum-runtime
 * floor and report which ones are still inside the window).
 */
import { PrismaClient } from '@prisma/client'
import { getSpheronClient, SpheronApiError } from '../src/services/spheron/client.js'

async function main() {
  const dryRun = !process.argv.includes('--delete')
  const prisma = new PrismaClient()
  const client = getSpheronClient()
  if (!client) {
    console.error('Spheron client not configured (SPHERON_API_KEY missing)')
    process.exit(1)
  }

  console.log(`Mode: ${dryRun ? 'DRY-RUN (pass --delete to actually delete)' : 'DELETE'}`)
  console.log('Listing active upstream Spheron deployments…')
  const upstream = await client.listDeployments({ status: 'active' })
  console.log(`  ${upstream.length} active upstream`)

  const localRows = await prisma.spheronDeployment.findMany({
    select: { id: true, providerDeploymentId: true, status: true, upstreamDeletedAt: true },
  })
  const localById = new Map(
    localRows
      .filter((r) => r.providerDeploymentId)
      .map((r) => [r.providerDeploymentId as string, r]),
  )

  console.log('\n--- Cross-reference ---')
  const orphans: typeof upstream = []
  for (const u of upstream) {
    const local = localById.get(u.id)
    const tag = local
      ? local.upstreamDeletedAt
        ? 'GHOST (local says upstream-deleted but it isn\'t)'
        : `LOCAL ${local.status}`
      : 'ORPHAN (no local row)'
    console.log(`  ${u.id}  name=${u.name ?? '?'}  status=${u.status ?? '?'}  ip=${u.ipAddress ?? '?'}  → ${tag}`)
    if (!local || local.upstreamDeletedAt) orphans.push(u)
  }

  if (orphans.length === 0) {
    console.log('\nNo orphans. Done.')
    await prisma.$disconnect()
    return
  }

  console.log(`\nFound ${orphans.length} orphan(s) to clean.`)

  if (dryRun) {
    console.log('Dry run — re-run with --delete to actually delete.')
    await prisma.$disconnect()
    return
  }

  for (const o of orphans) {
    console.log(`Closing ${o.id}…`)
    try {
      await client.deleteDeployment(o.id)
      console.log('  deleted')
    } catch (err) {
      if (err instanceof SpheronApiError) {
        if (err.isAlreadyGone()) {
          console.log('  already gone')
          continue
        }
        const min = err.isMinimumRuntimeNotMet?.()
        if (min) {
          console.log(`  blocked by 20-min floor — ${min.timeRemainingMinutes}m remaining`)
          continue
        }
      }
      console.error('  failed:', err instanceof Error ? err.message : err)
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
