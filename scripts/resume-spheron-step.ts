/**
 * One-off: resume the in-process step worker for any Spheron deployment
 * left in CREATING / STARTING with a live providerDeploymentId.
 *
 * This is needed when the cloud-api process is restarted (dev:reset, crash,
 * deploy) while a deployment was mid-loop — the in-process recursive
 * setTimeout chain dies with the process and the row stays STARTING
 * forever even though the VM upstream may already be running.
 *
 * Idempotent: each step handler short-circuits on terminal states and
 * checks `providerDeploymentId` / `ipAddress` to decide which step to
 * re-enter at.
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()

  const stuck = await prisma.spheronDeployment.findMany({
    where: {
      status: { in: ['CREATING', 'STARTING'] },
    },
    select: {
      id: true,
      status: true,
      providerDeploymentId: true,
      ipAddress: true,
      updatedAt: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  console.log(`Found ${stuck.length} stuck Spheron deployment(s):`)
  for (const d of stuck) console.log(`  - ${d.id} (${d.status}) provider=${d.providerDeploymentId ?? 'none'} ip=${d.ipAddress ?? 'none'}`)

  if (stuck.length === 0) {
    await prisma.$disconnect()
    return
  }

  // Lazy import so the prisma client is initialised before the queue layer
  // pulls in its own dependencies (logger, qstash client).
  const { initQueueHandler, handleSpheronStep } = await import('../src/services/queue/webhookHandler.js')
  initQueueHandler(prisma)

  for (const d of stuck) {
    if (!d.providerDeploymentId && d.status === 'CREATING') {
      console.log(`> ${d.id}: re-entering DEPLOY_VM`)
      await handleSpheronStep({ step: 'DEPLOY_VM', deploymentId: d.id } as never)
      continue
    }

    if (d.providerDeploymentId && !d.ipAddress) {
      console.log(`> ${d.id}: re-entering POLL_STATUS (attempt 1)`)
      await handleSpheronStep({ step: 'POLL_STATUS', deploymentId: d.id, attempt: 1 } as never)
      continue
    }

    if (d.providerDeploymentId && d.ipAddress) {
      console.log(`> ${d.id}: re-entering RUN_CLOUDINIT_PROBE (attempt 1)`)
      await handleSpheronStep({ step: 'RUN_CLOUDINIT_PROBE', deploymentId: d.id, attempt: 1 } as never)
      continue
    }

    console.log(`> ${d.id}: indeterminate state, re-entering POLL_STATUS`)
    await handleSpheronStep({ step: 'POLL_STATUS', deploymentId: d.id, attempt: 1 } as never)
  }

  await prisma.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
