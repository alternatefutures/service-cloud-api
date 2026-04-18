-- Heartbeat-based leader lease for singleton schedulers.
--
-- Enables REPLICAS > 1 for service-cloud-api. With more than one pod,
-- multiple billing crons / escrow monitors / sweepers running in
-- parallel would race on chain TXs and rows. Schedulers now wrap their
-- `.start()` in `runWithLeadership(prisma, schedulerKey)` and only the
-- pod that holds the lease runs the loop.
--
-- The leader renews `expires_at` every `LEADER_HEARTBEAT_MS`; if it
-- crashes, followers detect the expired lease and one of them claims
-- it on their next poll.

CREATE TABLE "scheduler_leader_lease" (
    "scheduler_key" TEXT NOT NULL,
    "leader_id" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduler_leader_lease_pkey" PRIMARY KEY ("scheduler_key")
);
