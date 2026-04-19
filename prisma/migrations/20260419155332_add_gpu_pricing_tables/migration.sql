-- CreateTable
CREATE TABLE "gpu_bid_observation" (
    "id" TEXT NOT NULL,
    "probe_run_id" TEXT NOT NULL,
    "gpu_model" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "provider_addr" TEXT NOT NULL,
    "price_per_block_uact" BIGINT NOT NULL,
    "dseq" BIGINT NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gpu_bid_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gpu_price_summary" (
    "gpu_model" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "min_price_per_block_uact" BIGINT NOT NULL,
    "p50_price_per_block_uact" BIGINT NOT NULL,
    "p90_price_per_block_uact" BIGINT NOT NULL,
    "max_price_per_block_uact" BIGINT NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "unique_provider_count" INTEGER NOT NULL,
    "window_days" INTEGER NOT NULL DEFAULT 7,
    "refreshed_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gpu_price_summary_pkey" PRIMARY KEY ("gpu_model")
);

-- CreateTable
CREATE TABLE "chain_stats" (
    "id" TEXT NOT NULL DEFAULT 'akash-mainnet',
    "seconds_per_block" DOUBLE PRECISION NOT NULL,
    "blocks_per_day" INTEGER NOT NULL,
    "blocks_per_hour" INTEGER NOT NULL,
    "source_url" TEXT NOT NULL,
    "sampled_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_stats_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gpu_bid_observation_gpu_model_observed_at_idx" ON "gpu_bid_observation"("gpu_model", "observed_at");

-- CreateIndex
CREATE INDEX "gpu_bid_observation_probe_run_id_idx" ON "gpu_bid_observation"("probe_run_id");
