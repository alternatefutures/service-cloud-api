-- CreateTable
CREATE TABLE "verification_run" (
    "id" TEXT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "templates_total" INTEGER NOT NULL,
    "templates_passed" INTEGER NOT NULL,
    "deployments" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "unique_providers" INTEGER NOT NULL DEFAULT 0,
    "cost_uakt" BIGINT NOT NULL DEFAULT 0,
    "cost_uact" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'running',
    "error" TEXT,

    CONSTRAINT "verification_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_run_started_at_idx" ON "verification_run"("started_at");

-- CreateIndex
CREATE INDEX "verification_run_status_idx" ON "verification_run"("status");
