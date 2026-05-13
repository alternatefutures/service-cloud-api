/**
 * Deployment Health Resolver
 *
 * Fetches live per-container health from the active deployment's
 * provider via the registry helper. Each provider's adapter
 * implements `getHealth` against its own native API (Akash:
 * lease-status, Phala: cvms-get, Spheron: REST + SSH probe).
 *
 * Companion services resolve to the parent's deployment.
 */

import type { Context } from './types.js'
import { requireAuth, assertProjectAccess } from '../utils/authorization.js'
import { findActiveOrPendingDeploymentForService } from '../services/providers/registry.js'

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

    const found = await findActiveOrPendingDeploymentForService(
      context.prisma,
      deploymentServiceId,
    )
    if (!found) return null

    if (!found.provider.getHealth) return null
    return found.provider.getHealth(found.deployment.id)
  },
}
