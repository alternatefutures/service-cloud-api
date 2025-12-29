/**
 * Observability Services
 *
 * Multi-tenant APM platform for AlternateFutures customers.
 */

export {
  TelemetryIngestionService,
  getTelemetryIngestionService,
  type IngestionEvent,
  type TelemetryIngestionBuffer,
} from './telemetryIngestionService.js'

export {
  handleTelemetryWebhook,
  handleTelemetryStats,
} from './webhookHandler.js'

export {
  ClickHouseObservabilityClient,
  getClickHouseClient,
  type Span,
  type SpanEvent,
  type SpanLink,
  type Trace,
  type MetricDataPoint,
  type MetricSeries,
  type LogEntry,
  type ServiceStats,
  type TraceQueryInput,
  type MetricQueryInput,
  type LogQueryInput,
} from './clickhouseClient.js'
