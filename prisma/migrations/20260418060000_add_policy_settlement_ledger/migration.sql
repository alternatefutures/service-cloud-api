-- Write-ahead ledger for deployment settlement charges.
--
-- Every pre-close settlement debit MUST be inserted here as PENDING BEFORE
-- the auth-side computeDebit RPC fires. A crash between "advance local
-- state" and "auth credited the charge" is then recoverable by the
-- reconciler:
--
--   * PENDING + no auth charge  → retry, charge lands, mark COMMITTED.
--   * PENDING + auth has charge → retry returns alreadyProcessed=true,
--                                  mark COMMITTED.
--   * Persistent failure        → mark FAILED, page ops.
--
-- The UNIQUE constraint on idempotency_key doubles as a duplicate-charge
-- guard: even a buggy caller cannot insert two rows for the same
-- settlement window and end up double-billing the user.

-- CreateEnum
CREATE TYPE "SettlementProvider" AS ENUM ('AKASH', 'PHALA');

-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('FINAL_SETTLEMENT', 'HOURLY_ACCRUAL');

-- CreateEnum
CREATE TYPE "PolicySettlementStatus" AS ENUM ('PENDING', 'COMMITTED', 'FAILED');

-- CreateTable
CREATE TABLE "policy_settlement_ledger" (
    "id" TEXT NOT NULL,
    "provider" "SettlementProvider" NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "deployment_ref" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "org_billing_id" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "settled_to" TIMESTAMP(3) NOT NULL,
    "status" "PolicySettlementStatus" NOT NULL DEFAULT 'PENDING',
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "committed_at" TIMESTAMP(3),
    "policy_id" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_settlement_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_settlement_ledger_idempotency_key_key" ON "policy_settlement_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "policy_settlement_ledger_status_createdAt_idx" ON "policy_settlement_ledger"("status", "createdAt");

-- CreateIndex
CREATE INDEX "policy_settlement_ledger_deployment_ref_idx" ON "policy_settlement_ledger"("deployment_ref");
