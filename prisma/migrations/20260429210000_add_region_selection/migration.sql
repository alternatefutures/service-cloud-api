-- Phase 46 — Region selection.
--
-- Adds the data layer for curated region buckets ("us-east", "us-west", "eu",
-- "asia"). All columns are NULL-able so this migration is non-breaking — the
-- existing "Any (cheapest globally)" path keeps working unchanged. Until the
-- registry-refresh patch lands and starts populating ComputeProvider.region,
-- every region resolver query degrades to "all regions unavailable" with the
-- existing fail-open semantics.
--
-- Rollback: drop the columns, drop the override table, drop the new enum
-- value (Postgres < 14 needs the dump-and-recreate trick; everything we run
-- is >= 14 so it's a one-liner). See AF_REGION_SELECTION.md for the design.

-- ── ComputeProvider: resolved region + country ───────────────────────
ALTER TABLE "compute_provider" ADD COLUMN "region"  TEXT;
ALTER TABLE "compute_provider" ADD COLUMN "country" TEXT;

CREATE INDEX "compute_provider_region_idx" ON "compute_provider"("region");

-- ── ComputeProviderRegionOverride: admin escape hatch ────────────────
CREATE TABLE "compute_provider_region_override" (
    "provider_address" TEXT NOT NULL,
    "region"           TEXT,
    "reason"           TEXT,
    "set_by"           TEXT,
    "set_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_provider_region_override_pkey" PRIMARY KEY ("provider_address")
);

-- ── AkashDeployment: intent + resolved ───────────────────────────────
ALTER TABLE "AkashDeployment" ADD COLUMN "region"          TEXT;
ALTER TABLE "AkashDeployment" ADD COLUMN "resolved_region" TEXT;

CREATE INDEX "AkashDeployment_region_idx"          ON "AkashDeployment"("region");
CREATE INDEX "AkashDeployment_resolved_region_idx" ON "AkashDeployment"("resolved_region");

-- ── PhalaDeployment: forward-compat (always NULL until upstream lands) ──
ALTER TABLE "PhalaDeployment" ADD COLUMN "region" TEXT;

-- ── Service: per-service defaults ────────────────────────────────────
ALTER TABLE "Service" ADD COLUMN "preferred_region"   TEXT;
ALTER TABLE "Service" ADD COLUMN "preferred_provider" TEXT;

-- ── DeploymentPolicy: hard / soft region constraints ─────────────────
ALTER TABLE "deployment_policy" ADD COLUMN "allowed_regions"   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "deployment_policy" ADD COLUMN "preferred_regions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ── GpuBidObservation: region-aware price rollups ────────────────────
ALTER TABLE "gpu_bid_observation" ADD COLUMN "provider_region" TEXT;

CREATE INDEX "gpu_bid_observation_provider_region_gpu_model_observed_at_idx"
    ON "gpu_bid_observation" ("provider_region", "gpu_model", "observed_at");

-- ── AkashDeploymentStatus: empty-bids region branch ──────────────────
ALTER TYPE "AkashDeploymentStatus" ADD VALUE 'AWAITING_REGION_RESPONSE';
