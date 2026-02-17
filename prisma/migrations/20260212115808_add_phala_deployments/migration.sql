-- CreateEnum
CREATE TYPE "PhalaDeploymentStatus" AS ENUM ('CREATING', 'STARTING', 'ACTIVE', 'FAILED', 'STOPPED', 'DELETED');

-- CreateTable
CREATE TABLE "PhalaDeployment" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "PhalaDeploymentStatus" NOT NULL DEFAULT 'CREATING',
    "errorMessage" TEXT,
    "composeContent" TEXT NOT NULL,
    "envKeys" JSONB,
    "appUrl" TEXT,
    "teepod" TEXT,
    "serviceId" TEXT NOT NULL,
    "siteId" TEXT,
    "afFunctionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhalaDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PhalaDeployment_serviceId_idx" ON "PhalaDeployment"("serviceId");

-- CreateIndex
CREATE INDEX "PhalaDeployment_siteId_idx" ON "PhalaDeployment"("siteId");

-- CreateIndex
CREATE INDEX "PhalaDeployment_afFunctionId_idx" ON "PhalaDeployment"("afFunctionId");

-- CreateIndex
CREATE INDEX "PhalaDeployment_status_idx" ON "PhalaDeployment"("status");

-- CreateIndex
CREATE INDEX "PhalaDeployment_appId_idx" ON "PhalaDeployment"("appId");

-- AddForeignKey
ALTER TABLE "PhalaDeployment" ADD CONSTRAINT "PhalaDeployment_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhalaDeployment" ADD CONSTRAINT "PhalaDeployment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhalaDeployment" ADD CONSTRAINT "PhalaDeployment_afFunctionId_fkey" FOREIGN KEY ("afFunctionId") REFERENCES "AFFunction"("id") ON DELETE SET NULL ON UPDATE CASCADE;
