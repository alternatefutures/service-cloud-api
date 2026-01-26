/**
 * Backfill Service registry for legacy Site/AFFunction rows.
 *
 * Why this exists:
 * - Some environments may already have `Service` + `serviceId` columns (from manual SQL),
 *   but historical `Site` / `AFFunction` rows may have `serviceId = NULL`.
 * - The Service registry is the canonical list of workloads; subtype rows should always point to it.
 *
 * Usage:
 *   pnpm -C service-cloud-api db:generate
 *   pnpm -C service-cloud-api exec tsx scripts/backfill-service-registry.ts
 *
 * Notes on migrations / drift:
 * - If your DB already has the `Service` table + `serviceId` columns, you can run this script directly.
 * - If your DB is missing them (fresh environment), apply the repo's SQL intent first:
 *     service-cloud-api/prisma/_migration_add_org_and_services.sql
 *   (or otherwise create the equivalent schema), then run this script.
 *
 * Idempotency guarantees:
 * - Rows with an existing `serviceId` are skipped.
 * - If a matching Service exists for (type, slug) and the same project, it is reused.
 * - If a matching Service exists for (type, slug) but a different project, this is treated
 *   as a data conflict: the row is skipped and the script exits non-zero.
 */

import { PrismaClient, ServiceType } from '@prisma/client'

const prisma = new PrismaClient()

type Conflict = {
  kind: 'SITE' | 'FUNCTION'
  resourceId: string
  slug: string
  resourceProjectId: string
  existingServiceProjectId: string
}

async function backfillSites(conflicts: Conflict[]) {
  const sites = await prisma.site.findMany({
    where: { serviceId: null },
    select: {
      id: true,
      name: true,
      slug: true,
      projectId: true,
      project: { select: { userId: true } },
    },
  })

  let created = 0
  let reused = 0

  for (const site of sites) {
    const existing = await prisma.service.findUnique({
      where: { type_slug: { type: ServiceType.SITE, slug: site.slug } },
    })

    if (existing) {
      if (existing.projectId !== site.projectId) {
        conflicts.push({
          kind: 'SITE',
          resourceId: site.id,
          slug: site.slug,
          resourceProjectId: site.projectId,
          existingServiceProjectId: existing.projectId,
        })
        continue
      }

      await prisma.site.update({
        where: { id: site.id },
        data: { serviceId: existing.id },
      })
      reused++
      continue
    }

    const service = await prisma.service.create({
      data: {
        type: ServiceType.SITE,
        name: site.name,
        slug: site.slug,
        projectId: site.projectId,
        createdByUserId: site.project?.userId ?? null,
      },
    })

    await prisma.site.update({
      where: { id: site.id },
      data: { serviceId: service.id },
    })

    created++
  }

  return { total: sites.length, created, reused }
}

async function backfillFunctions(conflicts: Conflict[]) {
  const funcs = await prisma.aFFunction.findMany({
    where: { serviceId: null },
    select: {
      id: true,
      name: true,
      slug: true,
      projectId: true,
      project: { select: { userId: true } },
    },
  })

  let created = 0
  let reused = 0

  for (const fn of funcs) {
    const existing = await prisma.service.findUnique({
      where: { type_slug: { type: ServiceType.FUNCTION, slug: fn.slug } },
    })

    if (existing) {
      if (existing.projectId !== fn.projectId) {
        conflicts.push({
          kind: 'FUNCTION',
          resourceId: fn.id,
          slug: fn.slug,
          resourceProjectId: fn.projectId,
          existingServiceProjectId: existing.projectId,
        })
        continue
      }

      await prisma.aFFunction.update({
        where: { id: fn.id },
        data: { serviceId: existing.id },
      })
      reused++
      continue
    }

    const service = await prisma.service.create({
      data: {
        type: ServiceType.FUNCTION,
        name: fn.name,
        slug: fn.slug,
        projectId: fn.projectId,
        createdByUserId: fn.project?.userId ?? null,
      },
    })

    await prisma.aFFunction.update({
      where: { id: fn.id },
      data: { serviceId: service.id },
    })

    created++
  }

  return { total: funcs.length, created, reused }
}

async function main() {
  const conflicts: Conflict[] = []

  console.log('Backfilling Service registry...')

  const siteResult = await backfillSites(conflicts)
  console.log(
    `Sites: scanned=${siteResult.total} created=${siteResult.created} reused=${siteResult.reused}`
  )

  const fnResult = await backfillFunctions(conflicts)
  console.log(
    `Functions: scanned=${fnResult.total} created=${fnResult.created} reused=${fnResult.reused}`
  )

  if (conflicts.length > 0) {
    console.error('\nData conflicts detected (type+slug exists in another project):')
    for (const c of conflicts) {
      console.error(
        `- ${c.kind} ${c.resourceId} slug=${c.slug} resourceProject=${c.resourceProjectId} serviceProject=${c.existingServiceProjectId}`
      )
    }
    process.exitCode = 1
  } else {
    console.log('\nDone (no conflicts).')
  }
}

main()
  .catch(err => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

