-- Write-ahead lifecycle states for DeploymentEscrow.
--
-- PENDING_DEPOSIT:
--   Set BEFORE calling the deposit RPC against auth, so we never end up with a
--   debit on the auth side and no local row to track it (or vice-versa). The
--   escrow reconciler in EscrowService.reconcilePendingDeposits() drives stuck
--   rows to ACTIVE (deposit succeeded) or FAILED (insufficient balance /
--   persistent error).
--
-- REFUNDING:
--   Set BEFORE calling the refund RPC. Lets a partial-failure reconciler tell
--   the difference between "we never started the refund" and "the credit landed
--   on auth but our local row never updated" — both are unsafe states without
--   the marker.
--
-- FAILED:
--   Terminal state for write-ahead deposits that cannot be completed. The
--   deployment lifecycle should reject billing operations against FAILED rows
--   and trigger upstream cleanup.
--
-- Postgres requires ALTER TYPE ... ADD VALUE outside a transaction, so each
-- value gets its own statement. IF NOT EXISTS keeps re-runs safe in dev.

ALTER TYPE "EscrowStatus" ADD VALUE IF NOT EXISTS 'PENDING_DEPOSIT';
ALTER TYPE "EscrowStatus" ADD VALUE IF NOT EXISTS 'REFUNDING';
ALTER TYPE "EscrowStatus" ADD VALUE IF NOT EXISTS 'FAILED';
