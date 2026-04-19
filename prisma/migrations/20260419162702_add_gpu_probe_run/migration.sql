-- CreateTable
CREATE TABLE "gpu_probe_run" (
    "id" TEXT NOT NULL,
    "probe_run_id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "models_probed" INTEGER NOT NULL DEFAULT 0,
    "bids_collected" INTEGER NOT NULL DEFAULT 0,
    "unique_providers" INTEGER NOT NULL DEFAULT 0,
    "cost_uact" BIGINT NOT NULL DEFAULT 0,
    "cost_uakt" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,

    CONSTRAINT "gpu_probe_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gpu_probe_run_probe_run_id_key" ON "gpu_probe_run"("probe_run_id");

-- CreateIndex
CREATE INDEX "gpu_probe_run_started_at_idx" ON "gpu_probe_run"("started_at");

-- CreateIndex
CREATE INDEX "gpu_probe_run_status_idx" ON "gpu_probe_run"("status");
