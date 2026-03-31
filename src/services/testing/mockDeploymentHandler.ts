/**
 * Mock Deployment Handler — DEV/TEST ONLY
 *
 * Creates fake ACTIVE AkashDeployment records for integration testing.
 * Avoids needing real chain interaction to test the billing/trial lifecycle.
 *
 * Guarded by NODE_ENV !== 'production' AND introspection secret.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('mock-deployment-handler')

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

interface MockDeploymentRequest {
  userId: string
  organizationId: string
  serviceName?: string
}

export async function handleMockDeployment(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
) {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Disabled in production' }))
    return
  }

  const secret = process.env.AUTH_INTROSPECTION_SECRET
  const provided = req.headers['x-af-introspection-secret'] as string
  if (secret && (!provided || !safeCompare(provided, secret))) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  let body: MockDeploymentRequest
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  const { userId, organizationId, serviceName = 'e2e-test-service' } = body

  if (!userId || !organizationId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'userId and organizationId are required' }))
    return
  }

  try {
    // Ensure user exists in cloud DB
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId },
    })

    // Ensure organization + membership exist
    await prisma.organization.upsert({
      where: { id: organizationId },
      update: {},
      create: { id: organizationId },
    })
    await prisma.organizationMember.upsert({
      where: {
        organizationId_userId: { organizationId, userId },
      },
      update: {},
      create: {
        organizationId,
        userId,
        role: 'OWNER',
      },
    })

    // Create project
    const projectSlug = `e2e-test-${Date.now().toString(36)}`
    const project = await prisma.project.create({
      data: {
        name: 'E2E Lifecycle Test',
        slug: projectSlug,
        userId,
        organizationId,
      },
    })

    // Create service
    const serviceSlug = `${serviceName}-${Date.now().toString(36)}`
    const service = await prisma.service.create({
      data: {
        type: 'VM',
        name: serviceName,
        slug: serviceSlug,
        projectId: project.id,
        createdByUserId: userId,
      },
    })

    // Create fake ACTIVE AkashDeployment (negative dseq = synthetic, not on-chain)
    const fakeDseq = BigInt(-Date.now())
    const deployment = await prisma.akashDeployment.create({
      data: {
        owner: 'akash1e2etest000000000000000000000000000000',
        dseq: fakeDseq,
        status: 'ACTIVE',
        sdlContent: '---\nversion: "2.0"\nservices:\n  web:\n    image: nginx:latest\n',
        serviceId: service.id,
        deployedAt: new Date(),
        dailyRateCentsRaw: 100,
        dailyRateCentsCharged: 125,
        pricePerBlock: '1.0',
      },
    })

    log.info(
      { userId, organizationId, deploymentId: deployment.id },
      'Created mock ACTIVE deployment for e2e test'
    )

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        projectId: project.id,
        projectSlug: project.slug,
        serviceId: service.id,
        serviceSlug: service.slug,
        deploymentId: deployment.id,
        dseq: fakeDseq.toString(),
      })
    )
  } catch (error) {
    log.error(error, 'Failed to create mock deployment')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    )
  }
}

/**
 * Cleans up test data from the cloud DB.
 */
export async function handleMockCleanup(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
) {
  if (process.env.NODE_ENV === 'production' && process.env.ENABLE_TEST_ENDPOINTS !== 'true') {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Disabled in production' }))
    return
  }

  const secret = process.env.AUTH_INTROSPECTION_SECRET
  const provided = req.headers['x-af-introspection-secret'] as string
  if (secret && (!provided || !safeCompare(provided, secret))) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  let body: { userId: string }
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }
    body = JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Invalid JSON body' }))
    return
  }

  if (!body.userId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'userId required' }))
    return
  }

  try {
    // Find all e2e projects for this user and cascade delete
    const projects = await prisma.project.findMany({
      where: {
        userId: body.userId,
        slug: { startsWith: 'e2e-test-' },
      },
      select: { id: true },
    })

    for (const project of projects) {
      await prisma.project.delete({ where: { id: project.id } })
    }

    // Clean up org memberships, orgs, and user created by handleMockDeployment
    await prisma.organizationMember.deleteMany({ where: { userId: body.userId } })

    const orgs = await prisma.organization.findMany({
      where: { members: { none: {} } },
      select: { id: true },
    })
    for (const org of orgs) {
      await prisma.organization.delete({ where: { id: org.id } }).catch(() => {})
    }

    await prisma.user.delete({ where: { id: body.userId } }).catch(() => {})

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        deletedProjects: projects.length,
      })
    )
  } catch (error) {
    log.error(error, 'Failed to clean up mock data')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    )
  }
}
