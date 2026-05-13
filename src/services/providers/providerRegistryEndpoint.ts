/**
 * Internal endpoint: GET /internal/provider-registry
 *
 * Returns the full provider registry data for consumption by the web-app
 * and other internal services. Secured by INTERNAL_AUTH_TOKEN.
 *
 * Query params:
 *   ?type=AKASH           — filter by provider type (default: all)
 *   ?verified=true        — only verified providers
 *   ?gpu=true             — only providers with GPU capacity
 *   ?templateId=gpu-instance — include template results for a specific template
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('provider-registry-endpoint')

export async function handleProviderRegistryRequest(
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
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const typeFilter = url.searchParams.get('type')?.toUpperCase()
    const verifiedOnly = url.searchParams.get('verified') === 'true'
    const gpuOnly = url.searchParams.get('gpu') === 'true'
    const templateId = url.searchParams.get('templateId')

    const where: Record<string, unknown> = {}
    if (typeFilter === 'AKASH' || typeFilter === 'PHALA') {
      where.providerType = typeFilter
    }
    if (verifiedOnly) {
      where.verified = true
    }
    if (gpuOnly) {
      where.gpuTotal = { gt: 0 }
    }

    const providers = await prisma.computeProvider.findMany({
      where,
      include: {
        templateResults: templateId
          ? { where: { templateId } }
          : { orderBy: { testedAt: 'desc' } },
      },
      orderBy: [{ verified: 'desc' }, { gpuAvailable: 'desc' }],
    })

    const response = {
      generatedAt: new Date().toISOString(),
      count: providers.length,
      providers: providers.map(p => ({
        id: p.id,
        address: p.address,
        providerType: p.providerType,
        name: p.name,
        verified: p.verified,
        blocked: p.blocked,
        blockReason: p.blockReason,
        isOnline: p.isOnline,
        lastSeenOnlineAt: p.lastSeenOnlineAt?.toISOString() ?? null,
        lastTestedAt: p.lastTestedAt?.toISOString() ?? null,
        gpuModels: p.gpuModels,
        gpuAvailable: p.gpuAvailable,
        gpuTotal: p.gpuTotal,
        gpuRam: p.gpuRam ?? null,
        gpuInterface: p.gpuInterface ?? null,
        // Phase 46 region taxonomy. Required by the BFF region-aware GPU
        // dropdown in the web-app — without it the route can't tally
        // per-region availability without a second DB read.
        region: p.region ?? null,
        country: p.country ?? null,
        minPriceUact: p.minPriceUact?.toString() ?? null,
        maxPriceUact: p.maxPriceUact?.toString() ?? null,
        templateResults: p.templateResults.map(tr => ({
          templateId: tr.templateId,
          passed: tr.passed,
          priceUact: tr.priceUact?.toString() ?? null,
          durationMs: tr.durationMs,
          errorMessage: tr.errorMessage,
          testedAt: tr.testedAt.toISOString(),
        })),
      })),
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'Provider registry endpoint failed'
    )
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}
