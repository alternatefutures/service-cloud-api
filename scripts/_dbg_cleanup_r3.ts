import { PrismaClient } from '@prisma/client'

const TARGET_ID = 'cmp6rmnyt01bpiaadqf0cesbv'
const REASON = 'Permanently failed: Spheron RTX-A4000 stock exhausted (retried r0-r3, all 4 attempts hit "Not Enough Stock"). Stranded after retry chain dropped. Cleaned up manually.'

async function main() {
  const prisma = new PrismaClient()
  const row = await prisma.spheronDeployment.findUnique({
    where: { id: TARGET_ID },
    select: { id: true, status: true, providerDeploymentId: true },
  })
  if (!row) {
    console.error('row not found')
    process.exit(2)
  }
  if (row.status !== 'CREATING' && row.status !== 'STARTING') {
    console.log('Row not in CREATING/STARTING. Current status:', row.status, '— no action.')
    process.exit(0)
  }
  if (row.providerDeploymentId) {
    console.log('Row has providerDeploymentId — refusing to mark PERMANENTLY_FAILED without orchestrator close. Aborting.')
    process.exit(3)
  }
  const updated = await prisma.spheronDeployment.update({
    where: { id: TARGET_ID },
    data: { status: 'PERMANENTLY_FAILED', errorMessage: REASON },
  })
  console.log('Updated:', { id: updated.id, status: updated.status })
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
