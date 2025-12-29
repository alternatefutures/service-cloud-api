/**
 * ClickHouse Observability Client
 *
 * Provides query methods for traces, metrics, and logs stored in ClickHouse.
 * All queries are project-scoped for multi-tenant isolation.
 */

import { createClient, type ClickHouseClient } from '@clickhouse/client'

// ============================================
// Types
// ============================================

export interface Span {
  timestamp: Date
  traceId: string
  spanId: string
  parentSpanId: string | null
  traceState: string | null
  spanName: string
  spanKind: string
  serviceName: string
  resourceAttributes: Record<string, string>
  scopeName: string | null
  scopeVersion: string | null
  spanAttributes: Record<string, string>
  durationNs: bigint
  durationMs: number
  statusCode: string
  statusMessage: string | null
  events: SpanEvent[]
  links: SpanLink[]
}

export interface SpanEvent {
  timestamp: Date
  name: string
  attributes: Record<string, string>
}

export interface SpanLink {
  traceId: string
  spanId: string
  traceState: string | null
  attributes: Record<string, string>
}

export interface Trace {
  traceId: string
  rootSpan: Span | null
  spans: Span[]
  serviceName: string
  startTime: Date
  endTime: Date
  durationMs: number
  spanCount: number
  hasError: boolean
}

export interface MetricDataPoint {
  timestamp: Date
  metricName: string
  metricDescription: string | null
  metricUnit: string | null
  metricType: string
  value: number | null
  histogramCount: number | null
  histogramSum: number | null
  histogramBuckets: number[] | null
  histogramBucketCounts: number[] | null
  attributes: Record<string, string>
  resourceAttributes: Record<string, string>
}

export interface MetricSeries {
  metricName: string
  metricUnit: string | null
  metricType: string
  dataPoints: MetricDataPoint[]
}

export interface LogEntry {
  timestamp: Date
  traceId: string | null
  spanId: string | null
  severityText: string
  severityNumber: number
  body: string
  resourceAttributes: Record<string, string>
  logAttributes: Record<string, string>
}

export interface ServiceStats {
  serviceName: string
  spanCount: number
  traceCount: number
  errorCount: number
  errorRate: number
  avgDurationMs: number
  p50DurationMs: number
  p95DurationMs: number
  p99DurationMs: number
}

export interface TraceQueryInput {
  projectId: string
  startTime: Date
  endTime: Date
  serviceName?: string
  spanName?: string
  minDurationMs?: number
  maxDurationMs?: number
  statusCode?: string
  traceId?: string
  limit?: number
  offset?: number
}

export interface MetricQueryInput {
  projectId: string
  startTime: Date
  endTime: Date
  metricName?: string
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count'
  groupBy?: string[]
  interval?: string // e.g., '1m', '5m', '1h', '1d'
  limit?: number
}

export interface LogQueryInput {
  projectId: string
  startTime: Date
  endTime: Date
  severityText?: string
  minSeverityNumber?: number
  search?: string
  traceId?: string
  limit?: number
  offset?: number
}

// ============================================
// Client Implementation
// ============================================

export class ClickHouseObservabilityClient {
  private client: ClickHouseClient
  private database: string = 'observability'

  constructor(config?: {
    host?: string
    username?: string
    password?: string
    database?: string
  }) {
    const host =
      config?.host ?? process.env.CLICKHOUSE_HOST ?? 'http://localhost:8123'
    const username =
      config?.username ?? process.env.CLICKHOUSE_USER ?? 'default'
    const password = config?.password ?? process.env.CLICKHOUSE_PASSWORD ?? ''
    this.database =
      config?.database ?? process.env.CLICKHOUSE_DATABASE ?? 'observability'

    this.client = createClient({
      host,
      username,
      password,
      database: this.database,
    })
  }

  /**
   * Query traces with filters
   */
  async queryTraces(input: TraceQueryInput): Promise<Trace[]> {
    const {
      projectId,
      startTime,
      endTime,
      serviceName,
      spanName,
      minDurationMs,
      maxDurationMs,
      statusCode,
      traceId,
      limit = 100,
      offset = 0,
    } = input

    // Build WHERE clause
    const conditions: string[] = [
      `af_project_id = {projectId:String}`,
      `Timestamp >= {startTime:DateTime64(9)}`,
      `Timestamp <= {endTime:DateTime64(9)}`,
    ]

    if (serviceName) conditions.push(`ServiceName = {serviceName:String}`)
    if (spanName) conditions.push(`SpanName LIKE {spanName:String}`)
    if (minDurationMs) conditions.push(`Duration >= {minDurationNs:Int64}`)
    if (maxDurationMs) conditions.push(`Duration <= {maxDurationNs:Int64}`)
    if (statusCode) conditions.push(`StatusCode = {statusCode:String}`)
    if (traceId) conditions.push(`TraceId = {traceId:String}`)

    // Get distinct trace IDs first
    const traceIdsQuery = `
      SELECT DISTINCT TraceId
      FROM ${this.database}.traces
      WHERE ${conditions.join(' AND ')}
      ORDER BY min(Timestamp) DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `

    const traceIdsResult = await this.client.query({
      query: traceIdsQuery,
      query_params: {
        projectId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        serviceName: serviceName ?? '',
        spanName: spanName ? `%${spanName}%` : '',
        minDurationNs: (minDurationMs ?? 0) * 1_000_000,
        maxDurationNs: (maxDurationMs ?? Number.MAX_SAFE_INTEGER) * 1_000_000,
        statusCode: statusCode ?? '',
        traceId: traceId ?? '',
        limit,
        offset,
      },
    })

    const traceIds = (await traceIdsResult.json()).data as { TraceId: string }[]

    if (traceIds.length === 0) {
      return []
    }

    // Get all spans for those traces
    const spansQuery = `
      SELECT
        Timestamp,
        TraceId,
        SpanId,
        ParentSpanId,
        TraceState,
        SpanName,
        SpanKind,
        ServiceName,
        ResourceAttributes,
        ScopeName,
        ScopeVersion,
        SpanAttributes,
        Duration,
        StatusCode,
        StatusMessage,
        Events.Timestamp as EventTimestamps,
        Events.Name as EventNames,
        Events.Attributes as EventAttributes,
        Links.TraceId as LinkTraceIds,
        Links.SpanId as LinkSpanIds,
        Links.TraceState as LinkTraceStates,
        Links.Attributes as LinkAttributes
      FROM ${this.database}.traces
      WHERE af_project_id = {projectId:String}
        AND TraceId IN ({traceIds:Array(String)})
      ORDER BY Timestamp ASC
    `

    const spansResult = await this.client.query({
      query: spansQuery,
      query_params: {
        projectId,
        traceIds: traceIds.map(t => t.TraceId),
      },
    })

    const spansData = (await spansResult.json()).data as any[]

    // Group spans by trace
    const traceMap = new Map<string, Trace>()

    for (const row of spansData) {
      const span = this.parseSpanRow(row)
      let trace = traceMap.get(span.traceId)

      if (!trace) {
        trace = {
          traceId: span.traceId,
          rootSpan: null,
          spans: [],
          serviceName: span.serviceName,
          startTime: span.timestamp,
          endTime: span.timestamp,
          durationMs: 0,
          spanCount: 0,
          hasError: false,
        }
        traceMap.set(span.traceId, trace)
      }

      trace.spans.push(span)
      trace.spanCount++

      if (!span.parentSpanId) {
        trace.rootSpan = span
        trace.serviceName = span.serviceName
      }

      if (span.timestamp < trace.startTime) {
        trace.startTime = span.timestamp
      }

      const spanEndTime = new Date(span.timestamp.getTime() + span.durationMs)
      if (spanEndTime > trace.endTime) {
        trace.endTime = spanEndTime
      }

      if (span.statusCode === 'ERROR') {
        trace.hasError = true
      }
    }

    // Calculate trace durations
    for (const trace of traceMap.values()) {
      trace.durationMs = trace.endTime.getTime() - trace.startTime.getTime()
    }

    return Array.from(traceMap.values())
  }

  /**
   * Get a single trace by ID
   */
  async getTrace(projectId: string, traceId: string): Promise<Trace | null> {
    const traces = await this.queryTraces({
      projectId,
      traceId,
      startTime: new Date(0),
      endTime: new Date(),
      limit: 1,
    })

    return traces[0] ?? null
  }

  /**
   * Query metrics with aggregation
   */
  async queryMetrics(input: MetricQueryInput): Promise<MetricSeries[]> {
    const {
      projectId,
      startTime,
      endTime,
      metricName,
      aggregation = 'avg',
      interval = '1m',
      limit = 1000,
    } = input

    const conditions: string[] = [
      `af_project_id = {projectId:String}`,
      `Timestamp >= {startTime:DateTime64(9)}`,
      `Timestamp <= {endTime:DateTime64(9)}`,
    ]

    if (metricName) {
      conditions.push(`MetricName = {metricName:String}`)
    }

    // Convert interval to ClickHouse format
    const intervalFn = this.parseInterval(interval)

    // Aggregation function
    const aggFn =
      aggregation === 'avg'
        ? 'avg(Value)'
        : aggregation === 'sum'
          ? 'sum(Value)'
          : aggregation === 'min'
            ? 'min(Value)'
            : aggregation === 'max'
              ? 'max(Value)'
              : 'count()'

    const query = `
      SELECT
        ${intervalFn}(Timestamp) as TimeBucket,
        MetricName,
        MetricUnit,
        MetricType,
        ${aggFn} as AggValue,
        any(MetricDescription) as MetricDescription,
        groupArray(Attributes) as AllAttributes
      FROM ${this.database}.metrics
      WHERE ${conditions.join(' AND ')}
      GROUP BY TimeBucket, MetricName, MetricUnit, MetricType
      ORDER BY TimeBucket ASC, MetricName ASC
      LIMIT {limit:UInt32}
    `

    const result = await this.client.query({
      query,
      query_params: {
        projectId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        metricName: metricName ?? '',
        limit,
      },
    })

    const data = (await result.json()).data as any[]

    // Group by metric name into series
    const seriesMap = new Map<string, MetricSeries>()

    for (const row of data) {
      const name = row.MetricName
      let series = seriesMap.get(name)

      if (!series) {
        series = {
          metricName: name,
          metricUnit: row.MetricUnit || null,
          metricType: row.MetricType,
          dataPoints: [],
        }
        seriesMap.set(name, series)
      }

      series.dataPoints.push({
        timestamp: new Date(row.TimeBucket),
        metricName: name,
        metricDescription: row.MetricDescription || null,
        metricUnit: row.MetricUnit || null,
        metricType: row.MetricType,
        value: row.AggValue,
        histogramCount: null,
        histogramSum: null,
        histogramBuckets: null,
        histogramBucketCounts: null,
        attributes: {},
        resourceAttributes: {},
      })
    }

    return Array.from(seriesMap.values())
  }

  /**
   * Query logs
   */
  async queryLogs(input: LogQueryInput): Promise<LogEntry[]> {
    const {
      projectId,
      startTime,
      endTime,
      severityText,
      minSeverityNumber,
      search,
      traceId,
      limit = 100,
      offset = 0,
    } = input

    const conditions: string[] = [
      `af_project_id = {projectId:String}`,
      `Timestamp >= {startTime:DateTime64(9)}`,
      `Timestamp <= {endTime:DateTime64(9)}`,
    ]

    if (severityText) conditions.push(`SeverityText = {severityText:String}`)
    if (minSeverityNumber !== undefined)
      conditions.push(`SeverityNumber >= {minSeverityNumber:Int8}`)
    if (search) conditions.push(`hasToken(Body, {search:String})`)
    if (traceId) conditions.push(`TraceId = {traceId:String}`)

    const query = `
      SELECT
        Timestamp,
        TraceId,
        SpanId,
        SeverityText,
        SeverityNumber,
        Body,
        ResourceAttributes,
        LogAttributes
      FROM ${this.database}.logs
      WHERE ${conditions.join(' AND ')}
      ORDER BY Timestamp DESC
      LIMIT {limit:UInt32} OFFSET {offset:UInt32}
    `

    const result = await this.client.query({
      query,
      query_params: {
        projectId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        severityText: severityText ?? '',
        minSeverityNumber: minSeverityNumber ?? 0,
        search: search ?? '',
        traceId: traceId ?? '',
        limit,
        offset,
      },
    })

    const data = (await result.json()).data as any[]

    return data.map(row => ({
      timestamp: new Date(row.Timestamp),
      traceId: row.TraceId || null,
      spanId: row.SpanId || null,
      severityText: row.SeverityText,
      severityNumber: row.SeverityNumber,
      body: row.Body,
      resourceAttributes: row.ResourceAttributes || {},
      logAttributes: row.LogAttributes || {},
    }))
  }

  /**
   * Get service statistics
   */
  async getServices(
    projectId: string,
    startTime: Date,
    endTime: Date
  ): Promise<ServiceStats[]> {
    const query = `
      SELECT
        ServiceName,
        count() as SpanCount,
        countDistinct(TraceId) as TraceCount,
        countIf(StatusCode = 'ERROR') as ErrorCount,
        avg(Duration / 1000000) as AvgDurationMs,
        quantile(0.5)(Duration / 1000000) as P50DurationMs,
        quantile(0.95)(Duration / 1000000) as P95DurationMs,
        quantile(0.99)(Duration / 1000000) as P99DurationMs
      FROM ${this.database}.traces
      WHERE af_project_id = {projectId:String}
        AND Timestamp >= {startTime:DateTime64(9)}
        AND Timestamp <= {endTime:DateTime64(9)}
      GROUP BY ServiceName
      ORDER BY SpanCount DESC
    `

    const result = await this.client.query({
      query,
      query_params: {
        projectId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      },
    })

    const data = (await result.json()).data as any[]

    return data.map(row => ({
      serviceName: row.ServiceName,
      spanCount: row.SpanCount,
      traceCount: row.TraceCount,
      errorCount: row.ErrorCount,
      errorRate: row.SpanCount > 0 ? row.ErrorCount / row.SpanCount : 0,
      avgDurationMs: row.AvgDurationMs,
      p50DurationMs: row.P50DurationMs,
      p95DurationMs: row.P95DurationMs,
      p99DurationMs: row.P99DurationMs,
    }))
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.client.query({ query: 'SELECT 1' })
      return true
    } catch (error) {
      console.error('[ClickHouse] Health check failed:', error)
      return false
    }
  }

  /**
   * Close the client connection
   */
  async close(): Promise<void> {
    await this.client.close()
  }

  // ============================================
  // Private Helpers
  // ============================================

  private parseSpanRow(row: any): Span {
    const events: SpanEvent[] = []
    if (row.EventTimestamps && Array.isArray(row.EventTimestamps)) {
      for (let i = 0; i < row.EventTimestamps.length; i++) {
        events.push({
          timestamp: new Date(row.EventTimestamps[i]),
          name: row.EventNames?.[i] ?? '',
          attributes: row.EventAttributes?.[i] ?? {},
        })
      }
    }

    const links: SpanLink[] = []
    if (row.LinkTraceIds && Array.isArray(row.LinkTraceIds)) {
      for (let i = 0; i < row.LinkTraceIds.length; i++) {
        links.push({
          traceId: row.LinkTraceIds[i],
          spanId: row.LinkSpanIds?.[i] ?? '',
          traceState: row.LinkTraceStates?.[i] ?? null,
          attributes: row.LinkAttributes?.[i] ?? {},
        })
      }
    }

    const durationNs = BigInt(row.Duration ?? 0)
    const durationMs = Number(durationNs) / 1_000_000

    return {
      timestamp: new Date(row.Timestamp),
      traceId: row.TraceId,
      spanId: row.SpanId,
      parentSpanId: row.ParentSpanId || null,
      traceState: row.TraceState || null,
      spanName: row.SpanName,
      spanKind: row.SpanKind,
      serviceName: row.ServiceName,
      resourceAttributes: row.ResourceAttributes || {},
      scopeName: row.ScopeName || null,
      scopeVersion: row.ScopeVersion || null,
      spanAttributes: row.SpanAttributes || {},
      durationNs,
      durationMs,
      statusCode: row.StatusCode,
      statusMessage: row.StatusMessage || null,
      events,
      links,
    }
  }

  private parseInterval(interval: string): string {
    // Convert interval like '1m', '5m', '1h', '1d' to ClickHouse toStartOf function
    const match = interval.match(/^(\d+)([smhd])$/)
    if (!match) {
      return 'toStartOfMinute'
    }

    const value = parseInt(match[1], 10)
    const unit = match[2]

    if (unit === 's') {
      return value === 1 ? 'toStartOfSecond' : `toStartOfInterval`
    } else if (unit === 'm') {
      if (value === 1) return 'toStartOfMinute'
      if (value === 5) return 'toStartOfFiveMinutes'
      if (value === 10) return 'toStartOfTenMinutes'
      if (value === 15) return 'toStartOfFifteenMinutes'
      return 'toStartOfMinute'
    } else if (unit === 'h') {
      return 'toStartOfHour'
    } else if (unit === 'd') {
      return 'toStartOfDay'
    }

    return 'toStartOfMinute'
  }
}

// Singleton instance
let instance: ClickHouseObservabilityClient | null = null

export function getClickHouseClient(): ClickHouseObservabilityClient {
  if (!instance) {
    instance = new ClickHouseObservabilityClient()
  }
  return instance
}
