import { PrismaClient } from '@prisma/client'

async function main() {
  const p = new PrismaClient()

  const totalCount = await p.spheronDeployment.count()
  console.log(`Total SpheronDeployment rows in DB: ${totalCount}`)

  const allRows = await p.spheronDeployment.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      status: true,
      providerDeploymentId: true,
      upstreamDeletedAt: true,
      ipAddress: true,
      createdAt: true,
      updatedAt: true,
      activeStartedAt: true,
      serviceId: true,
      retryCount: true,
      errorMessage: true,
    },
  })
  console.log('\nALL Spheron rows (oldest to newest):')
  console.log(JSON.stringify(allRows.reverse(), null, 2))

  const byVm = await p.spheronDeployment.findFirst({
    where: { providerDeploymentId: { startsWith: '6a04dc0a' } },
  })
  console.log('\nLookup by providerDeploymentId starting "6a04dc0a":')
  console.log(JSON.stringify(byVm, null, 2))

  const services = await p.service.findMany({
    where: { slug: { contains: 'quantum-meteor' } },
    select: { id: true, slug: true, name: true, projectId: true, type: true, dockerImage: true },
  })
  console.log('\nServices matching "quantum-meteor":')
  console.log(JSON.stringify(services, null, 2))

  await p.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
