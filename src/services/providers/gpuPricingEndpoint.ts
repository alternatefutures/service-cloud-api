/**
 * Internal endpoint: GET /internal/gpu-pricing
 *
 * Returns the rolled-up per-GPU pricing summary computed by the
 * GpuBidProbeScheduler, plus the live blocks-per-day estimate from the
 * Akash console-api so the web-app can convert price-per-block into a
 * USD-per-day cost label without re-doing the math itself.
 *
 * Auth: shared INTERNAL_AUTH_TOKEN via x-internal-auth header (same
 * pattern as /internal/provider-registry).
 *
 * Response shape (the web-app's akash-gpu-availability route consumes
 * this directly — be careful with breaking changes):
 *   {
 *     refreshedAt: ISO,
 *     blocksPerDay: 14124,
 *     blocksSource: 'akash-console-api' | 'cache' | 'static-fallback',
 *     models: [
 *       { gpuModel, vendor,
 *         minUact, p50Uact, p90Uact, maxUact,
 *         sampleCount, providerCount, windowDays, refreshedAt }
 *     ]
 *   }
 *
 * `*Uact` fields are stringified BigInts so JSON consumers don't lose
 * precision. The web-app converts them back to BigInt for comparison
 * and to USD for display.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import { createLogger } from '../../lib/logger.js'
import { getAkashChainGeometry } from '../../config/pricing.js'

const log = createLogger('gpu-pricing-endpoint')

export async function handleGpuPricingRequest(
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
    const summaries = await prisma.gpuPriceSummary.findMany({
      orderBy: { gpuModel: 'asc' },
    })

    // Resolve chain geometry concurrently with the DB read so the
    // endpoint stays sub-100ms when the cache is cold. Failure of the
    // live source falls back to the static constant inside
    // `getAkashChainGeometry` — never throws. Pass `prisma` so a fresh
    // pod can hydrate the in-memory cache from `chain_stats` instead of
    // serving the static fallback on its first request.
    const geometry = await getAkashChainGeometry(prisma)

    const response = {
      generatedAt: new Date().toISOString(),
      blocksPerDay: geometry.blocksPerDay,
      blocksPerHour: geometry.blocksPerHour,
      secondsPerBlock: geometry.secondsPerBlock,
      blocksSource: geometry.source,
      models: summaries.map(s => ({
        gpuModel: s.gpuModel,
        vendor: s.vendor,
        minUact: s.minPricePerBlock.toString(),
        p50Uact: s.p50PricePerBlock.toString(),
        p90Uact: s.p90PricePerBlock.toString(),
        maxUact: s.maxPricePerBlock.toString(),
        sampleCount: s.sampleCount,
        providerCount: s.uniqueProviderCount,
        windowDays: s.windowDays,
        refreshedAt: s.refreshedAt.toISOString(),
      })),
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(response))
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'GPU pricing endpoint failed'
    )
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}
