# OpenTelemetry Implementation Guide

## Overview

This deployment includes a full OpenTelemetry observability stack:

- **Jaeger** - Distributed tracing UI and storage
- **OpenTelemetry Collector** - Telemetry ingestion and processing
- **Auto-instrumentation** - For API and Auth services

## Architecture

```
┌─────────┐     ┌─────────┐
│   API   │────▶│  Auth   │
└────┬────┘     └────┬────┘
     │               │
     │ OTLP/HTTP    │ OTLP/HTTP
     │ :4318        │ :4318
     ▼               ▼
┌──────────────────────────┐
│  OTEL Collector :4318    │
│  - Receives traces       │
│  - Processes & batches   │
│  - Exports to Jaeger     │
└────────┬─────────────────┘
         │ OTLP/gRPC :4317
         ▼
┌──────────────────────────┐
│  Jaeger All-in-One       │
│  - Storage (BadgerDB)    │
│  - Query API             │
│  - UI :16686             │
└──────────────────────────┘
```

## Services

### Jaeger (jaeger.alternatefutures.ai)

- **UI**: https://jaeger.alternatefutures.ai
- **Purpose**: View distributed traces, analyze performance
- **Storage**: BadgerDB (embedded, 10Gi persistent)
- **Resources**: 1 CPU, 1.5Gi RAM

### OpenTelemetry Collector (otel-metrics.alternatefutures.ai)

- **Metrics**: https://otel-metrics.alternatefutures.ai (Prometheus format)
- **Purpose**: Receive, process, and forward telemetry
- **Resources**: 0.5 CPU, 512Mi RAM

## Application Instrumentation

### Auto-Instrumentation (Node.js)

Both API and Auth services are pre-configured via environment variables:

```yaml
env:
  - OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318
  - OTEL_SERVICE_NAME=alternatefutures-api # or alternatefutures-auth
  - OTEL_TRACES_SAMPLER=always_on
  - OTEL_METRICS_EXPORTER=otlp
  - OTEL_LOGS_EXPORTER=otlp
```

### Code Integration

Add to your `package.json`:

```json
{
  "dependencies": {
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-node": "^0.52.0",
    "@opentelemetry/auto-instrumentations-node": "^0.47.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.52.0",
    "@opentelemetry/exporter-metrics-otlp-http": "^0.52.0"
  }
}
```

Create `src/instrumentation.ts`:

```typescript
import { NodeSDK } from '@opentelemetry/sdk-node'
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { Resource } from '@opentelemetry/resources'
import { SEMRESATTRS_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]:
      process.env.OTEL_SERVICE_NAME || 'unknown-service',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
  }),
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/metrics`,
    }),
  }),
  instrumentations: [getNodeAutoInstrumentations()],
})

sdk.start()

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => console.log('Tracing terminated'))
    .catch(error => console.log('Error terminating tracing', error))
    .finally(() => process.exit(0))
})

export default sdk
```

Import at the **very top** of your `src/index.ts`:

```typescript
import './instrumentation' // MUST be first!
import express from 'express'
// ... rest of your imports
```

## Building Custom OTEL Collector Image

The OTEL Collector uses a custom configuration. To build and push:

```bash
cd docker/otel-collector
docker build -t ghcr.io/alternatefutures/otel-collector:latest .
docker push ghcr.io/alternatefutures/otel-collector:latest
```

Or trigger the GitHub Actions workflow:

```bash
gh workflow run build-otel-collector.yml
```

## DNS Configuration

The deployment automatically configures:

- `jaeger.alternatefutures.ai` → Jaeger UI
- `otel-metrics.alternatefutures.ai` → Prometheus metrics

## Usage

### Viewing Traces

1. Open https://jaeger.alternatefutures.ai
2. Select service: `alternatefutures-api` or `alternatefutures-auth`
3. Click "Find Traces"
4. Click on any trace to see detailed spans

### Common Queries

**Find slow API requests:**

- Service: `alternatefutures-api`
- Min Duration: `500ms`

**Find errors:**

- Tags: `error=true`

**Trace specific user request:**

- Tags: `user.id=<user_id>`

## Performance Impact

- **Trace overhead**: ~5-10% CPU, <50MB RAM per service
- **Collector**: 0.5 CPU, 512Mi RAM
- **Jaeger**: 1 CPU, 1.5Gi RAM (includes UI and storage)
- **Total additional cost**: ~$20/month

## Cost Breakdown

```
Previous total: ~$105/month (3 YB nodes @ 1 CPU each, API, Auth, IPFS)
OTEL addition:  ~$20/month (Jaeger + Collector)
New total:      ~$125/month

Breakdown:
- YugabyteDB (3 nodes × 1 CPU):  ~$50/month
- API (1 CPU):                   ~$15/month
- Auth (0.5 CPU):                ~$10/month
- IPFS (2 CPU):                  ~$30/month
- Jaeger (1 CPU):                ~$15/month
- OTEL Collector (0.5 CPU):      ~$5/month
```

## Troubleshooting

### No traces appearing in Jaeger

1. **Check collector is running:**

   ```bash
   curl https://otel-metrics.alternatefutures.ai
   ```

2. **Check application is sending traces:**
   - Look for OTEL SDK initialization logs
   - Verify `OTEL_EXPORTER_OTLP_ENDPOINT` is set correctly

3. **Check Jaeger is receiving:**
   - Open Jaeger UI
   - Check "System Architecture" tab

### High memory usage

- Reduce sampling rate in OTEL config
- Increase batch timeout to reduce frequency

## Next Steps

1. ✅ Deploy with OpenTelemetry enabled
2. ⏳ Add custom spans for business logic
3. ⏳ Set up alerts based on trace data
4. ⏳ Integrate with error tracking
5. ⏳ Add service dependency graph

## References

- [OpenTelemetry Docs](https://opentelemetry.io/docs/)
- [Jaeger Docs](https://www.jaegertracing.io/docs/)
- [OTEL Node.js](https://opentelemetry.io/docs/languages/js/)
