-- Per-org concurrent-deployment counter.
--
-- Replaces the racy `COUNT(*)` on (AkashDeployment + PhalaDeployment)
-- inside `assertOrgConcurrency` with a single source-of-truth row that
-- is incremented under SELECT FOR UPDATE. Two concurrent launches now
-- serialize on the row, so the cap is enforced strictly.
--
-- The hourly reconciler recomputes activeCount from the deployment
-- tables and clamps drift, so a forgotten decrement in one of the close
-- paths cannot permanently lock an org out of new launches.

CREATE TABLE "organization_concurrency_counter" (
    "organization_id" TEXT NOT NULL,
    "active_count" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_concurrency_counter_pkey" PRIMARY KEY ("organization_id")
);
