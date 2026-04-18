-- Akash strict close mode.
--
-- Add CLOSE_FAILED to the AkashDeployment status enum so callers
-- can distinguish:
--   * CLOSED: the on-chain `tx deployment close` was accepted (or the
--     chain reports the deployment as already gone) — done, no further
--     action.
--   * CLOSE_FAILED: the local close attempt threw because of an
--     environmental issue (RPC unreachable, wallet out of gas, account
--     sequence collision). The lease may still be running on-chain
--     and incurring escrow draw — operators / the stale-deployment
--     sweeper must retry.
--
-- Previously every close failure collapsed to CLOSED in the database
-- regardless of chain outcome, which masked stuck leases until the
-- escrow drained.

-- AlterEnum
ALTER TYPE "AkashDeploymentStatus" ADD VALUE 'CLOSE_FAILED';
