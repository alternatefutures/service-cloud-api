import { PrismaClient } from '@prisma/client'

async function main() {
  const p = new PrismaClient()
  const rows = await p.spheronDeployment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      status: true,
      providerDeploymentId: true,
      ipAddress: true,
      sshUser: true,
      sshPort: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      activeStartedAt: true,
      retryCount: true,
    },
  })
  console.log(JSON.stringify(rows, null, 2))
  await p.$disconnect()
}
main().catch((e) => { console.error(e); process.exit(1) })
