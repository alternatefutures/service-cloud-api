/**
 * One-shot: flip a STARTING Spheron row to ACTIVE when the upstream VM
 * is verified up but our cloud-init probe never resumed (e.g. cloud-api
 * was restarted before resumeStuckDeployments could fire, or the cloud-init
 * runcmd-before-writeFiles bug stranded the boot script).
 *
 * Usage: pnpm tsx scripts/fix-stuck-spheron.ts <localId>
 */
import { PrismaClient } from '@prisma/client'

async function main() {
  const localId = process.argv[2]
  if (!localId) {
    console.error('Usage: pnpm tsx scripts/fix-stuck-spheron.ts <localId>')
    process.exit(1)
  }
  const p = new PrismaClient()
  const before = await p.spheronDeployment.findUnique({ where: { id: localId } })
  if (!before) {
    console.error(`No SpheronDeployment with id=${localId}`)
    process.exit(1)
  }
  console.log('Before:', JSON.stringify({ id: before.id, status: before.status, activeStartedAt: before.activeStartedAt }, null, 2))
  const now = new Date()
  const updated = await p.spheronDeployment.update({
    where: { id: localId },
    data: {
      status: 'ACTIVE',
      activeStartedAt: now,
      lastBilledAt: now,
    },
  })
  console.log('After:', JSON.stringify({ id: updated.id, status: updated.status, activeStartedAt: updated.activeStartedAt, lastBilledAt: updated.lastBilledAt }, null, 2))
  await p.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
