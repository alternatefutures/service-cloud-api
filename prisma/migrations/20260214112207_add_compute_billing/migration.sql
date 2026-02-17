-- CreateEnum
CREATE TYPE "EscrowStatus" AS ENUM ('ACTIVE', 'DEPLETED', 'REFUNDED', 'PAUSED');

-- AlterEnum
ALTER TYPE "AkashDeploymentStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "AkashDeployment" ADD COLUMN     "savedSdl" TEXT;

-- AlterTable
ALTER TABLE "PhalaDeployment" ADD COLUMN     "active_started_at" TIMESTAMP(3),
ADD COLUMN     "cvm_size" TEXT,
ADD COLUMN     "hourly_rate_cents" INTEGER,
ADD COLUMN     "last_billed_at" TIMESTAMP(3),
ADD COLUMN     "margin_rate" DOUBLE PRECISION,
ADD COLUMN     "org_billing_id" TEXT,
ADD COLUMN     "organization_id" TEXT,
ADD COLUMN     "total_billed_cents" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "deployment_escrow" (
    "id" TEXT NOT NULL,
    "akash_deployment_id" TEXT NOT NULL,
    "org_billing_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "deposit_cents" INTEGER NOT NULL,
    "consumed_cents" INTEGER NOT NULL DEFAULT 0,
    "daily_rate_cents" INTEGER NOT NULL,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "margin_rate" DOUBLE PRECISION NOT NULL,
    "status" "EscrowStatus" NOT NULL DEFAULT 'ACTIVE',
    "last_billed_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_escrow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deployment_escrow_akash_deployment_id_key" ON "deployment_escrow"("akash_deployment_id");

-- CreateIndex
CREATE INDEX "deployment_escrow_org_billing_id_idx" ON "deployment_escrow"("org_billing_id");

-- CreateIndex
CREATE INDEX "deployment_escrow_organization_id_idx" ON "deployment_escrow"("organization_id");

-- CreateIndex
CREATE INDEX "deployment_escrow_status_idx" ON "deployment_escrow"("status");

-- CreateIndex
CREATE INDEX "PhalaDeployment_org_billing_id_idx" ON "PhalaDeployment"("org_billing_id");

-- AddForeignKey
ALTER TABLE "deployment_escrow" ADD CONSTRAINT "deployment_escrow_akash_deployment_id_fkey" FOREIGN KEY ("akash_deployment_id") REFERENCES "AkashDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
