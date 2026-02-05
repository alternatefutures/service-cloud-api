-- CreateEnum
CREATE TYPE "AkashDeploymentStatus" AS ENUM ('CREATING', 'WAITING_BIDS', 'SELECTING_BID', 'CREATING_LEASE', 'SENDING_MANIFEST', 'DEPLOYING', 'ACTIVE', 'FAILED', 'CLOSED');

-- CreateTable
CREATE TABLE "AkashDeployment" (
    "id" TEXT NOT NULL,
    "owner" TEXT NOT NULL,
    "dseq" BIGINT NOT NULL,
    "gseq" INTEGER NOT NULL DEFAULT 1,
    "oseq" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT,
    "status" "AkashDeploymentStatus" NOT NULL DEFAULT 'CREATING',
    "serviceUrls" JSONB,
    "sdlContent" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "afFunctionId" TEXT,
    "siteId" TEXT,
    "depositUakt" BIGINT,
    "pricePerBlock" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deployedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "AkashDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AkashDeployment_serviceId_idx" ON "AkashDeployment"("serviceId");

-- CreateIndex
CREATE INDEX "AkashDeployment_afFunctionId_idx" ON "AkashDeployment"("afFunctionId");

-- CreateIndex
CREATE INDEX "AkashDeployment_siteId_idx" ON "AkashDeployment"("siteId");

-- CreateIndex
CREATE INDEX "AkashDeployment_status_idx" ON "AkashDeployment"("status");

-- CreateIndex
CREATE INDEX "AkashDeployment_dseq_idx" ON "AkashDeployment"("dseq");

-- CreateIndex
CREATE UNIQUE INDEX "AkashDeployment_owner_dseq_key" ON "AkashDeployment"("owner", "dseq");

-- AddForeignKey
ALTER TABLE "AkashDeployment" ADD CONSTRAINT "AkashDeployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AkashDeployment" ADD CONSTRAINT "AkashDeployment_afFunctionId_fkey" FOREIGN KEY ("afFunctionId") REFERENCES "AFFunction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AkashDeployment" ADD CONSTRAINT "AkashDeployment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;
