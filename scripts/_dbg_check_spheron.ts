import { PrismaClient } from '@prisma/client'

async function main() {
  const prisma = new PrismaClient()
  const rows = await prisma.spheronDeployment.findMany({
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      name: true,
      status: true,
      provider: true,
      providerDeploymentId: true,
      region: true,
      gpuType: true,
      gpuCount: true,
      ipAddress: true,
      retryCount: true,
      parentDeploymentId: true,
      errorMessage: true,
      upstreamDeletedAt: true,
      createdAt: true,
      updatedAt: true,
      activeStartedAt: true,
      serviceId: true,
      qstashMessageId: true,
      service: { select: { name: true, slug: true } },
    },
  })
  console.log(JSON.stringify(rows, null, 2))
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
