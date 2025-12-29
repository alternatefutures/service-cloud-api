/**
 * Telemetry Ingestion Webhook Handler
 *
 * Receives ingestion events from OTEL Collector and records them for billing.
 * Internal endpoint - not exposed to the public.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { PrismaClient } from '@prisma/client'
import {
  getTelemetryIngestionService,
  type IngestionEvent,
} from './telemetryIngestionService.js'

interface OTLPMetric {
  name: string
  attributes?: Record<string, string>
  value?: number
  count?: number
}

interface OTLPPayload {
  resourceMetrics?: Array<{
    resource?: {
      attributes?: Array<{
        key: string
        value: { stringValue?: string; intValue?: number }
      }>
    }
    scopeMetrics?: Array<{
      metrics?: OTLPMetric[]
    }>
  }>
}

/**
 * Handle telemetry ingestion webhook from OTEL Collector
 * Expects OTLP JSON format from the count connector
 */
export async function handleTelemetryWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
): Promise<void> {
  // Verify internal auth token
  const authToken = req.headers['x-internal-auth']
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN

  if (expectedToken && authToken !== expectedToken) {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  // Only accept POST requests
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Method not allowed' }))
    return
  }

  try {
    // Read request body
    const body = await readBody(req)
    const payload = JSON.parse(body) as OTLPPayload

    const service = getTelemetryIngestionService(prisma)
    const events = parseOTLPPayload(payload)

    // Record all events
    for (const event of events) {
      service.recordIngestion(event)
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        success: true,
        eventsRecorded: events.length,
      })
    )
  } catch (error) {
    console.error('[TelemetryWebhook] Error processing webhook:', error)

    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error',
      })
    )
  }
}

/**
 * Read request body as string
 */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''

    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
    })

    req.on('end', () => {
      resolve(body)
    })

    req.on('error', err => {
      reject(err)
    })
  })
}

/**
 * Parse OTLP metrics payload from count connector into ingestion events
 */
function parseOTLPPayload(payload: OTLPPayload): IngestionEvent[] {
  const events: Map<string, IngestionEvent> = new Map()

  if (!payload.resourceMetrics) {
    return []
  }

  for (const resourceMetric of payload.resourceMetrics) {
    // Extract project ID from resource attributes
    let projectId: string | undefined
    let projectSlug: string | undefined

    if (resourceMetric.resource?.attributes) {
      for (const attr of resourceMetric.resource.attributes) {
        if (attr.key === 'af.project.id') {
          projectId = attr.value.stringValue
        } else if (attr.key === 'af.project.slug') {
          projectSlug = attr.value.stringValue
        }
      }
    }

    if (!projectId) {
      continue // Skip metrics without project ID
    }

    // Get or create event for this project
    let event = events.get(projectId)
    if (!event) {
      event = {
        projectId,
        projectSlug,
        spansCount: 0,
        metricsCount: 0,
        logsCount: 0,
        bytesEstimate: 0,
      }
      events.set(projectId, event)
    }

    // Parse metrics from count connector
    if (resourceMetric.scopeMetrics) {
      for (const scopeMetric of resourceMetric.scopeMetrics) {
        if (scopeMetric.metrics) {
          for (const metric of scopeMetric.metrics) {
            // Count connector metrics have names like af.ingestion.spans, af.ingestion.metrics, etc.
            const count = metric.count ?? metric.value ?? 0

            if (metric.name === 'af.ingestion.spans') {
              event.spansCount = (event.spansCount ?? 0) + count
              // Rough estimate: 500 bytes per span on average
              event.bytesEstimate = (event.bytesEstimate ?? 0) + count * 500
            } else if (metric.name === 'af.ingestion.metrics') {
              event.metricsCount = (event.metricsCount ?? 0) + count
              // Rough estimate: 100 bytes per metric point
              event.bytesEstimate = (event.bytesEstimate ?? 0) + count * 100
            } else if (metric.name === 'af.ingestion.logs') {
              event.logsCount = (event.logsCount ?? 0) + count
              // Rough estimate: 1KB per log entry on average
              event.bytesEstimate = (event.bytesEstimate ?? 0) + count * 1024
            }
          }
        }
      }
    }
  }

  return Array.from(events.values())
}

/**
 * Get buffer stats endpoint for monitoring
 */
export async function handleTelemetryStats(
  req: IncomingMessage,
  res: ServerResponse,
  prisma: PrismaClient
): Promise<void> {
  // Verify internal auth token
  const authToken = req.headers['x-internal-auth']
  const expectedToken = process.env.INTERNAL_AUTH_TOKEN

  if (expectedToken && authToken !== expectedToken) {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Unauthorized' }))
    return
  }

  try {
    const service = getTelemetryIngestionService(prisma)
    const stats = service.getStats()

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        ...stats,
        totalBytes: stats.totalBytes.toString(), // BigInt to string for JSON
      })
    )
  } catch (error) {
    console.error('[TelemetryStats] Error:', error)

    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json')
    res.end(
      JSON.stringify({
        error: 'Internal server error',
      })
    )
  }
}
