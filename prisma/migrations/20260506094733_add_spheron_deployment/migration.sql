-- CreateEnum
CREATE TYPE "SpheronDeploymentStatus" AS ENUM ('CREATING', 'STARTING', 'ACTIVE', 'FAILED', 'STOPPED', 'DELETED', 'PERMANENTLY_FAILED');

-- AlterEnum
ALTER TYPE "ComputeProviderType" ADD VALUE 'SPHERON';

-- AlterEnum
ALTER TYPE "PolicyStopReason" ADD VALUE 'PROVIDER_INTERRUPTED';

-- CreateTable
CREATE TABLE "spheron_deployment" (
    "id" TEXT NOT NULL,
    "provider_deployment_id" TEXT,
    "name" TEXT NOT NULL,
    "status" "SpheronDeploymentStatus" NOT NULL DEFAULT 'CREATING',
    "errorMessage" TEXT,
    "provider" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "gpuType" TEXT NOT NULL,
    "gpuCount" INTEGER NOT NULL DEFAULT 1,
    "region" TEXT NOT NULL,
    "operatingSystem" TEXT NOT NULL,
    "instanceType" TEXT NOT NULL DEFAULT 'DEDICATED',
    "ip_address" TEXT,
    "ssh_user" TEXT,
    "ssh_port" INTEGER,
    "ssh_key_id" TEXT NOT NULL,
    "saved_cloud_init" JSONB,
    "saved_deploy_input" JSONB,
    "compose_content" TEXT,
    "envKeys" JSONB,
    "priced_snapshot_json" JSONB,
    "hourly_rate_cents" INTEGER,
    "original_hourly_rate_cents" INTEGER,
    "margin_rate" DOUBLE PRECISION,
    "org_billing_id" TEXT,
    "organization_id" TEXT,
    "active_started_at" TIMESTAMP(3),
    "last_billed_at" TIMESTAMP(3),
    "total_billed_cents" INTEGER NOT NULL DEFAULT 0,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "parent_deployment_id" TEXT,
    "qstash_message_id" TEXT,
    "resumed_from_id" TEXT,
    "serviceId" TEXT NOT NULL,
    "siteId" TEXT,
    "afFunctionId" TEXT,
    "policy_id" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "spheron_deployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spheron_deployment_policy_id_key" ON "spheron_deployment"("policy_id");

-- CreateIndex
CREATE INDEX "spheron_deployment_serviceId_idx" ON "spheron_deployment"("serviceId");

-- CreateIndex
CREATE INDEX "spheron_deployment_siteId_idx" ON "spheron_deployment"("siteId");

-- CreateIndex
CREATE INDEX "spheron_deployment_afFunctionId_idx" ON "spheron_deployment"("afFunctionId");

-- CreateIndex
CREATE INDEX "spheron_deployment_status_idx" ON "spheron_deployment"("status");

-- CreateIndex
CREATE INDEX "spheron_deployment_provider_deployment_id_idx" ON "spheron_deployment"("provider_deployment_id");

-- CreateIndex
CREATE INDEX "spheron_deployment_org_billing_id_idx" ON "spheron_deployment"("org_billing_id");

-- CreateIndex
CREATE INDEX "spheron_deployment_resumed_from_id_idx" ON "spheron_deployment"("resumed_from_id");

-- CreateIndex
CREATE INDEX "spheron_deployment_organization_id_status_idx" ON "spheron_deployment"("organization_id", "status");

-- AddForeignKey
ALTER TABLE "spheron_deployment" ADD CONSTRAINT "spheron_deployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spheron_deployment" ADD CONSTRAINT "spheron_deployment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spheron_deployment" ADD CONSTRAINT "spheron_deployment_afFunctionId_fkey" FOREIGN KEY ("afFunctionId") REFERENCES "AFFunction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spheron_deployment" ADD CONSTRAINT "spheron_deployment_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "deployment_policy"("id") ON DELETE SET NULL ON UPDATE CASCADE;
