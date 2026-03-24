/**
 * OpenTelemetry SDK instrumentation for service-cloud-api.
 *
 * Must be imported BEFORE any other application code so the SDK can
 * monkey-patch http, graphql, and prisma modules at load time.
 *
 * Exports to Jaeger via OTLP gRPC (OTEL_EXPORTER_OTLP_ENDPOINT env var,
 * defaults to http://localhost:4317 for local dev).
 *
 * In production, the K8s ConfigMap sets:
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4317
 */

import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions'

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4317'

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'service-cloud-api',
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version || '0.1.2',
    ['deployment.environment']: process.env.NODE_ENV || 'development',
  }),
  traceExporter: new OTLPTraceExporter({ url: otlpEndpoint }),
  instrumentations: [
    getNodeAutoInstrumentations({
      // fs instrumentation is extremely noisy and not useful
      '@opentelemetry/instrumentation-fs': { enabled: false },
      // dns instrumentation adds noise with minimal value
      '@opentelemetry/instrumentation-dns': { enabled: false },
    }),
  ],
})

sdk.start()

const shutdown = async () => {
  try {
    await sdk.shutdown()
  } catch {
    // best-effort; process is exiting anyway
  }
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

export { sdk }
