-- CreateEnum
CREATE TYPE "PolicyStopReason" AS ENUM ('BUDGET_EXCEEDED', 'RUNTIME_EXPIRED', 'MANUAL_STOP', 'BALANCE_LOW');

-- CreateTable
CREATE TABLE "deployment_policy" (
    "id" TEXT NOT NULL,
    "acceptableGpuModels" TEXT[],
    "gpuUnits" INTEGER,
    "gpuVendor" TEXT,
    "max_budget_usd" DOUBLE PRECISION,
    "max_monthly_usd" DOUBLE PRECISION,
    "runtime_minutes" INTEGER,
    "expires_at" TIMESTAMP(3),
    "stop_reason" "PolicyStopReason",
    "stopped_at" TIMESTAMP(3),
    "total_spent_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_policy_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "deployment_policy_expires_at_idx" ON "deployment_policy"("expires_at");

-- CreateIndex
CREATE INDEX "deployment_policy_stop_reason_idx" ON "deployment_policy"("stop_reason");

-- AlterTable
ALTER TABLE "AkashDeployment" ADD COLUMN "policy_id" TEXT;

-- AlterTable
ALTER TABLE "PhalaDeployment" ADD COLUMN "policy_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "AkashDeployment_policy_id_key" ON "AkashDeployment"("policy_id");

-- CreateIndex
CREATE UNIQUE INDEX "PhalaDeployment_policy_id_key" ON "PhalaDeployment"("policy_id");

-- AddForeignKey
ALTER TABLE "AkashDeployment" ADD CONSTRAINT "AkashDeployment_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "deployment_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhalaDeployment" ADD CONSTRAINT "PhalaDeployment_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "deployment_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
