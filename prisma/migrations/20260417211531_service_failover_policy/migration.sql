-- AlterTable
ALTER TABLE "AkashDeployment" ADD COLUMN     "excluded_providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "failover_parent_id" TEXT,
ADD COLUMN     "failover_reason" TEXT;

-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "failoverPolicy" JSONB;

-- CreateIndex
CREATE INDEX "AkashDeployment_failover_parent_id_idx" ON "AkashDeployment"("failover_parent_id");
