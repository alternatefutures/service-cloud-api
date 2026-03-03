-- Add QStash retry and cost tracking fields to AkashDeployment
ALTER TABLE "AkashDeployment" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AkashDeployment" ADD COLUMN "parentDeploymentId" TEXT;
ALTER TABLE "AkashDeployment" ADD COLUMN "qstashMessageId" TEXT;
ALTER TABLE "AkashDeployment" ADD COLUMN "dailyRateCentsRaw" INTEGER;
ALTER TABLE "AkashDeployment" ADD COLUMN "dailyRateCentsCharged" INTEGER;

-- Add PERMANENTLY_FAILED to AkashDeploymentStatus enum
ALTER TYPE "AkashDeploymentStatus" ADD VALUE 'PERMANENTLY_FAILED';

-- Add QStash retry fields to PhalaDeployment
ALTER TABLE "PhalaDeployment" ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PhalaDeployment" ADD COLUMN "parentDeploymentId" TEXT;
ALTER TABLE "PhalaDeployment" ADD COLUMN "qstashMessageId" TEXT;

-- Add PERMANENTLY_FAILED to PhalaDeploymentStatus enum
ALTER TYPE "PhalaDeploymentStatus" ADD VALUE 'PERMANENTLY_FAILED';
