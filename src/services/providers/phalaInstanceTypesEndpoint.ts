/**
 * Internal endpoint: GET /internal/phala-instance-types
 *
 * Returns live Phala instance type data (GPU and CPU) for the web-app
 * GPU availability UI. Secured by INTERNAL_AUTH_TOKEN.
 *
 * Query params:
 *   ?gpu=true  — only GPU instance types (default: all)
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { listPhalaInstanceTypes, inferGpuCountFromId } from '../phala/instanceTypes.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('phala-instance-types-endpoint')

export async function handlePhalaInstanceTypesRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN
  const authToken = req.headers['x-internal-auth']

  if (expectedToken && authToken !== expectedToken) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    const gpuOnly = url.searchParams.get('gpu') === 'true'

    const allTypes = await listPhalaInstanceTypes()

    const filtered = gpuOnly
      ? allTypes.filter(t => t.requires_gpu)
      : allTypes

    const instances = filtered.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description ?? null,
      vcpu: t.vcpu,
      memoryMb: t.memory_mb,
      hourlyRate: t.hourly_rate,
      requiresGpu: t.requires_gpu,
      family: t.family,
      gpuCount: t.requires_gpu ? inferGpuCountFromId(t.id) : 0,
    }))

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: instances.length,
      instances,
    }))
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : err },
      'Phala instance types endpoint failed'
    )
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Internal server error' }))
  }
}
