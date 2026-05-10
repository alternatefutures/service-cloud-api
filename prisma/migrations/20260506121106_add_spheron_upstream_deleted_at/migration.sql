-- AlterTable
ALTER TABLE "spheron_deployment" ADD COLUMN     "upstream_deleted_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "spheron_deployment_status_upstream_deleted_at_idx" ON "spheron_deployment"("status", "upstream_deleted_at");
