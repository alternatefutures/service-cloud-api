-- ============================================
-- ClickHouse Schema for AlternateFutures APM
-- Multi-tenant observability storage
-- ============================================

-- Create database
CREATE DATABASE IF NOT EXISTS observability;

-- ============================================
-- TRACES TABLE
-- Stores OpenTelemetry spans with project partitioning
-- ============================================
CREATE TABLE IF NOT EXISTS observability.traces
(
    -- Timestamp (nanosecond precision)
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),

    -- Trace identification
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),
    ParentSpanId String CODEC(ZSTD(1)),
    TraceState String CODEC(ZSTD(1)),

    -- Span details
    SpanName LowCardinality(String) CODEC(ZSTD(1)),
    SpanKind LowCardinality(String) CODEC(ZSTD(1)),
    ServiceName LowCardinality(String) CODEC(ZSTD(1)),

    -- Resource & Scope attributes
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ScopeName String CODEC(ZSTD(1)),
    ScopeVersion String CODEC(ZSTD(1)),

    -- Span attributes
    SpanAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),

    -- Duration in nanoseconds
    Duration Int64 CODEC(Delta, ZSTD(1)),

    -- Status
    StatusCode LowCardinality(String) CODEC(ZSTD(1)),
    StatusMessage String CODEC(ZSTD(1)),

    -- Events (nested)
    Events Nested(
        Timestamp DateTime64(9),
        Name LowCardinality(String),
        Attributes Map(LowCardinality(String), String)
    ) CODEC(ZSTD(1)),

    -- Links (nested)
    Links Nested(
        TraceId String,
        SpanId String,
        TraceState String,
        Attributes Map(LowCardinality(String), String)
    ) CODEC(ZSTD(1)),

    -- Multi-tenant fields
    af_project_id String CODEC(ZSTD(1)),
    af_project_slug LowCardinality(String) CODEC(ZSTD(1)),

    -- Materialized columns for common queries
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX idx_service ServiceName TYPE bloom_filter(0.01) GRANULARITY 1,
    INDEX idx_status StatusCode TYPE set(10) GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY (toYYYYMM(Timestamp), af_project_id)
ORDER BY (af_project_id, ServiceName, Timestamp, TraceId)
TTL toDateTime(Timestamp) + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- ============================================
-- METRICS TABLE
-- Stores OpenTelemetry metrics with project partitioning
-- ============================================
CREATE TABLE IF NOT EXISTS observability.metrics
(
    -- Timestamp
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),

    -- Metric identification
    MetricName LowCardinality(String) CODEC(ZSTD(1)),
    MetricDescription String CODEC(ZSTD(1)),
    MetricUnit LowCardinality(String) CODEC(ZSTD(1)),
    MetricType LowCardinality(String) CODEC(ZSTD(1)),  -- gauge, counter, histogram, summary

    -- Value (for gauge/counter)
    Value Float64 CODEC(ZSTD(1)),

    -- Histogram data (optional)
    HistogramCount UInt64 CODEC(Delta, ZSTD(1)),
    HistogramSum Float64 CODEC(ZSTD(1)),
    HistogramBuckets Array(Float64) CODEC(ZSTD(1)),
    HistogramBucketCounts Array(UInt64) CODEC(ZSTD(1)),

    -- Attributes
    Attributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),

    -- Multi-tenant fields
    af_project_id String CODEC(ZSTD(1)),
    af_project_slug LowCardinality(String) CODEC(ZSTD(1)),

    INDEX idx_metric_name MetricName TYPE bloom_filter(0.01) GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY (toYYYYMM(Timestamp), af_project_id)
ORDER BY (af_project_id, MetricName, Timestamp)
TTL toDateTime(Timestamp) + INTERVAL 30 DAY
SETTINGS index_granularity = 8192;

-- ============================================
-- LOGS TABLE
-- Stores OpenTelemetry logs with project partitioning
-- ============================================
CREATE TABLE IF NOT EXISTS observability.logs
(
    -- Timestamp
    Timestamp DateTime64(9) CODEC(Delta, ZSTD(1)),

    -- Trace context (for correlation)
    TraceId String CODEC(ZSTD(1)),
    SpanId String CODEC(ZSTD(1)),

    -- Severity
    SeverityText LowCardinality(String) CODEC(ZSTD(1)),
    SeverityNumber Int8 CODEC(ZSTD(1)),

    -- Log body
    Body String CODEC(ZSTD(1)),

    -- Attributes
    ResourceAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),
    LogAttributes Map(LowCardinality(String), String) CODEC(ZSTD(1)),

    -- Multi-tenant fields
    af_project_id String CODEC(ZSTD(1)),
    af_project_slug LowCardinality(String) CODEC(ZSTD(1)),

    -- Full-text search index
    INDEX idx_body Body TYPE tokenbf_v1(10240, 3, 0) GRANULARITY 4,
    INDEX idx_severity SeverityText TYPE set(10) GRANULARITY 1,
    INDEX idx_trace_id TraceId TYPE bloom_filter(0.001) GRANULARITY 1
)
ENGINE = MergeTree()
PARTITION BY (toYYYYMM(Timestamp), af_project_id)
ORDER BY (af_project_id, Timestamp)
TTL toDateTime(Timestamp) + INTERVAL 7 DAY
SETTINGS index_granularity = 8192;

-- ============================================
-- INGESTION STATS MATERIALIZED VIEW
-- For billing and usage tracking
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS observability.trace_ingestion_hourly
ENGINE = SummingMergeTree()
PARTITION BY (toYYYYMMDD(period_start))
ORDER BY (af_project_id, period_start)
AS
SELECT
    af_project_id,
    toStartOfHour(Timestamp) AS period_start,
    count() AS span_count,
    sum(length(SpanName) + length(toString(SpanAttributes)) + length(toString(ResourceAttributes))) AS bytes_estimate
FROM observability.traces
GROUP BY af_project_id, period_start;

CREATE MATERIALIZED VIEW IF NOT EXISTS observability.metric_ingestion_hourly
ENGINE = SummingMergeTree()
PARTITION BY (toYYYYMMDD(period_start))
ORDER BY (af_project_id, period_start)
AS
SELECT
    af_project_id,
    toStartOfHour(Timestamp) AS period_start,
    count() AS metric_count,
    sum(length(MetricName) + length(toString(Attributes))) AS bytes_estimate
FROM observability.metrics
GROUP BY af_project_id, period_start;

CREATE MATERIALIZED VIEW IF NOT EXISTS observability.log_ingestion_hourly
ENGINE = SummingMergeTree()
PARTITION BY (toYYYYMMDD(period_start))
ORDER BY (af_project_id, period_start)
AS
SELECT
    af_project_id,
    toStartOfHour(Timestamp) AS period_start,
    count() AS log_count,
    sum(length(Body) + length(toString(LogAttributes))) AS bytes_estimate
FROM observability.logs
GROUP BY af_project_id, period_start;

-- ============================================
-- SERVICE CATALOG VIEW
-- Aggregated service stats for quick lookups
-- ============================================
CREATE MATERIALIZED VIEW IF NOT EXISTS observability.service_stats_hourly
ENGINE = SummingMergeTree()
PARTITION BY (toYYYYMMDD(period_start))
ORDER BY (af_project_id, ServiceName, period_start)
AS
SELECT
    af_project_id,
    ServiceName,
    toStartOfHour(Timestamp) AS period_start,
    count() AS span_count,
    countDistinct(TraceId) AS trace_count,
    sum(Duration) AS total_duration,
    countIf(StatusCode = 'ERROR') AS error_count
FROM observability.traces
GROUP BY af_project_id, ServiceName, period_start;
