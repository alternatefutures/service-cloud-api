/**
 * Internal endpoint: GET /internal/admin/deployment-stats
 *
 * Returns per-user deployment statistics (project count, active/total deployments).
 * Secured by INTERNAL_AUTH_TOKEN (same pattern as provider-registry).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('admin-deployment-stats')

export async function handleAdminDeploymentStats(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']

  if (!expectedToken || authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const stats = await prisma.$queryRaw<Array<{
      user_id: string
      project_count: bigint
      active_akash: bigint
      total_akash: bigint
      active_phala: bigint
      total_phala: bigint
      active_spheron: bigint
      total_spheron: bigint
    }>>`
      SELECT
        p."userId" as user_id,
        COUNT(DISTINCT p.id)::bigint as project_count,
        COUNT(DISTINCT CASE WHEN ad.status = 'ACTIVE' THEN ad.id END)::bigint as active_akash,
        COUNT(DISTINCT ad.id)::bigint as total_akash,
        COUNT(DISTINCT CASE WHEN pd.status = 'ACTIVE' THEN pd.id END)::bigint as active_phala,
        COUNT(DISTINCT pd.id)::bigint as total_phala,
        COUNT(DISTINCT CASE WHEN sd.status = 'ACTIVE' THEN sd.id END)::bigint as active_spheron,
        COUNT(DISTINCT sd.id)::bigint as total_spheron
      FROM "Project" p
      LEFT JOIN "Service" s ON s."projectId" = p.id
      LEFT JOIN "AkashDeployment" ad ON ad."serviceId" = s.id
      LEFT JOIN "PhalaDeployment" pd ON pd."serviceId" = s.id
      LEFT JOIN "SpheronDeployment" sd ON sd."serviceId" = s.id
      GROUP BY p."userId"
    `

    const result = stats.map((row) => ({
      userId: row.user_id,
      projectCount: Number(row.project_count),
      activeAkash: Number(row.active_akash),
      totalAkash: Number(row.total_akash),
      activePhala: Number(row.active_phala),
      totalPhala: Number(row.total_phala),
      activeSpheron: Number(row.active_spheron),
      totalSpheron: Number(row.total_spheron),
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ stats: result }))
  } catch (err) {
    log.error({ err }, 'Failed to fetch deployment stats')
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}
