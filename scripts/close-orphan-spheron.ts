/**
 * One-off: close any Spheron VM whose local row is FAILED/PERMANENTLY_FAILED
 * but we never successfully DELETE'd upstream (so we're still being billed).
 *
 * Lists candidates, then DELETEs each via the Spheron API. Idempotent — a
 * 404 from upstream is treated as success.
 */
import { PrismaClient } from '@prisma/client'
import { getSpheronClient, SpheronApiError } from '../src/services/spheron/client.js'

async function main() {
  const prisma = new PrismaClient()
  const client = getSpheronClient()
  if (!client) {
    console.error('Spheron client not configured (SPHERON_API_KEY missing)')
    process.exit(1)
  }

  const orphans = await prisma.spheronDeployment.findMany({
    where: {
      providerDeploymentId: { not: null },
      status: { in: ['FAILED', 'PERMANENTLY_FAILED'] },
      upstreamDeletedAt: null,
    },
    select: {
      id: true,
      providerDeploymentId: true,
      status: true,
      ipAddress: true,
      errorMessage: true,
    },
  })

  console.log(`Found ${orphans.length} orphan(s):`)
  for (const o of orphans) console.log(`  - ${o.id} → ${o.providerDeploymentId} (${o.status}) @ ${o.ipAddress ?? 'no-ip'}`)

  for (const o of orphans) {
    if (!o.providerDeploymentId) continue
    try {
      console.log(`Closing ${o.providerDeploymentId}…`)
      await client.deleteDeployment(o.providerDeploymentId)
      await prisma.spheronDeployment.update({
        where: { id: o.id },
        data: { upstreamDeletedAt: new Date() },
      })
      console.log(`  ✓ deleted upstream`)
    } catch (err) {
      if (err instanceof SpheronApiError && err.status === 404) {
        await prisma.spheronDeployment.update({
          where: { id: o.id },
          data: { upstreamDeletedAt: new Date() },
        })
        console.log(`  ✓ already gone (404)`)
      } else {
        console.error(`  ✗ failed:`, err instanceof Error ? err.message : err)
      }
    }
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
