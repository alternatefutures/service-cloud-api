-- AlterTable
ALTER TABLE "AkashDeployment" ADD COLUMN "resumed_from_id" TEXT;

-- AlterTable
ALTER TABLE "PhalaDeployment" ADD COLUMN "resumed_from_id" TEXT;

-- CreateIndex
CREATE INDEX "AkashDeployment_resumed_from_id_idx" ON "AkashDeployment"("resumed_from_id");

-- CreateIndex
CREATE INDEX "PhalaDeployment_resumed_from_id_idx" ON "PhalaDeployment"("resumed_from_id");
