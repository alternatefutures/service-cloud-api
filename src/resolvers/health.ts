/**
 * Deployment Health Resolver
 *
 * Fetches live per-container health from the active deployment's provider.
 * Akash: calls lease-status for replica counts per service.
 * Phala: calls cvms get for CVM status.
 *
 * Handles companion services by resolving to the parent's deployment.
 */

import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'

export const healthQueries = {
  deploymentHealth: async (
    _: unknown,
    { serviceId }: { serviceId: string },
    context: Context,
  ) => {
    requireAuth(context)

    const svc = await context.prisma.service.findUnique({
      where: { id: serviceId },
      include: { project: { select: { userId: true, organizationId: true } } },
    })
    if (!svc) return null

    const p = (svc as any).project
    if (p) {
      assertProjectAccess(context, p, 'Not authorized to view health for this service')
    }

    const deploymentServiceId = svc.parentServiceId || serviceId

    const akashDeployment = await context.prisma.akashDeployment.findFirst({
      where: { serviceId: deploymentServiceId },
      orderBy: { createdAt: 'desc' },
    })

    if (akashDeployment) {
      const { getProvider } = await import('../services/providers/registry.js')
      const akash = getProvider('akash')
      if (akash.getHealth) {
        return akash.getHealth(akashDeployment.id)
      }
    }

    const phalaDeployment = await context.prisma.phalaDeployment.findFirst({
      where: { serviceId: deploymentServiceId },
      orderBy: { createdAt: 'desc' },
    })

    if (phalaDeployment) {
      const { getProvider } = await import('../services/providers/registry.js')
      const phala = getProvider('phala')
      if (phala.getHealth) {
        return phala.getHealth(phalaDeployment.id)
      }
    }

    // Phase 50 added Spheron-backed deployments. Without this branch the
    // resolver returned null for every Spheron service → the UI's
    // Provider Health card stayed blank even when the VM was running.
    // Match the live Spheron statuses (`activeSpheronDeployment` returns
    // CREATING/STARTING/ACTIVE) so health appears as soon as the VM is
    // requested, not only after it goes ACTIVE.
    const spheronDeployment = await context.prisma.spheronDeployment.findFirst({
      where: {
        serviceId: deploymentServiceId,
        status: { in: ['CREATING', 'STARTING', 'ACTIVE'] },
      },
      orderBy: { createdAt: 'desc' },
    })

    if (spheronDeployment) {
      const { getProvider } = await import('../services/providers/registry.js')
      const spheron = getProvider('spheron')
      if (spheron.getHealth) {
        return spheron.getHealth(spheronDeployment.id)
      }
    }

    return null
  },
}
