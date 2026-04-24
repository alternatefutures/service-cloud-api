import 'dotenv/config'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const SCREENSHOT_DSEQS = [
  '26524713', '26524708', '26524606', '26524603', '26524589',
  '26516228', '26511357', '26501405', '26492875', '26475389',
]

async function main() {
  console.log('Probing DB for the dseqs visible in the screenshot …\n')

  for (const dseq of SCREENSHOT_DSEQS) {
    const rows = await prisma.akashDeployment.findMany({
      where: { dseq: BigInt(dseq) },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        status: true,
        createdAt: true,
        deployedAt: true,
        closedAt: true,
        provider: true,
        parentDeploymentId: true,
        failoverParentId: true,
        resumedFromId: true,
        errorMessage: true,
        service: { select: { name: true, slug: true, project: { select: { organizationId: true } } } },
      },
    })
    if (rows.length === 0) {
      console.log(`dseq=${dseq}  TRUE ORPHAN — not in DB at all`)
      continue
    }
    for (const r of rows) {
      console.log(
        `dseq=${dseq}  status=${r.status.padEnd(20)}  ` +
          `service=${r.service?.slug ?? '?'}  org=${r.service?.project?.organizationId ?? '?'}  ` +
          `provider=${r.provider?.slice(0, 40) ?? 'null'}  ` +
          `created=${r.createdAt.toISOString()}  ` +
          `deployed=${r.deployedAt?.toISOString() ?? 'null'}  ` +
          `closed=${r.closedAt?.toISOString() ?? 'null'}  ` +
          `links=[parent=${r.parentDeploymentId ?? '·'}, failover=${r.failoverParentId ?? '·'}, resume=${r.resumedFromId ?? '·'}]`,
      )
      if (r.errorMessage) console.log(`           err: ${r.errorMessage.slice(0, 120)}`)
    }
  }

  console.log('\nAll DB rows currently flagged ACTIVE on Akash:')
  const active = await prisma.akashDeployment.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { deployedAt: 'asc' },
    select: {
      id: true,
      dseq: true,
      deployedAt: true,
      provider: true,
      parentDeploymentId: true,
      failoverParentId: true,
      resumedFromId: true,
      service: { select: { slug: true } },
    },
  })
  for (const a of active) {
    console.log(
      `  dseq=${a.dseq}  service=${a.service?.slug ?? '?'}  ` +
        `provider=${a.provider?.slice(0, 40) ?? 'null'}  ` +
        `deployed=${a.deployedAt?.toISOString() ?? 'null'}  ` +
        `links=[parent=${a.parentDeploymentId ?? '·'}, failover=${a.failoverParentId ?? '·'}, resume=${a.resumedFromId ?? '·'}]`,
    )
  }

  console.log(`\nTotal ACTIVE in DB: ${active.length}`)

  console.log('\nDB rows in SUSPENDED status (these are the prime suspects for SUSPENDED-LEAK):')
  const suspended = await prisma.akashDeployment.findMany({
    where: { status: 'SUSPENDED' },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, dseq: true, updatedAt: true, errorMessage: true, service: { select: { slug: true } } },
  })
  for (const s of suspended) {
    console.log(
      `  dseq=${s.dseq}  service=${s.service?.slug ?? '?'}  updated=${s.updatedAt.toISOString()}  err=${s.errorMessage?.slice(0, 80) ?? '·'}`,
    )
  }

  console.log('\nDB rows in CLOSE_FAILED status (chain close threw at suspend/close time):')
  const closeFailed = await prisma.akashDeployment.findMany({
    where: { status: 'CLOSE_FAILED' },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, dseq: true, updatedAt: true, errorMessage: true, service: { select: { slug: true } } },
  })
  for (const s of closeFailed) {
    console.log(
      `  dseq=${s.dseq}  service=${s.service?.slug ?? '?'}  updated=${s.updatedAt.toISOString()}  err=${s.errorMessage?.slice(0, 80) ?? '·'}`,
    )
  }
}

main().catch(console.error).finally(() => prisma.$disconnect())
