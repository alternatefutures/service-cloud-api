-- AlterTable: Add internalHostname to Service
ALTER TABLE "Service" ADD COLUMN "internalHostname" TEXT;

-- CreateTable: ServiceEnvVar
CREATE TABLE "ServiceEnvVar" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "secret" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceEnvVar_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ServicePort
CREATE TABLE "ServicePort" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "containerPort" INTEGER NOT NULL,
    "publicPort" INTEGER,
    "protocol" TEXT NOT NULL DEFAULT 'TCP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServicePort_pkey" PRIMARY KEY ("id")
);

-- CreateTable: ServiceLink
CREATE TABLE "ServiceLink" (
    "id" TEXT NOT NULL,
    "sourceServiceId" TEXT NOT NULL,
    "targetServiceId" TEXT NOT NULL,
    "alias" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceEnvVar_serviceId_idx" ON "ServiceEnvVar"("serviceId");
CREATE UNIQUE INDEX "ServiceEnvVar_serviceId_key_key" ON "ServiceEnvVar"("serviceId", "key");

CREATE INDEX "ServicePort_serviceId_idx" ON "ServicePort"("serviceId");
CREATE UNIQUE INDEX "ServicePort_serviceId_containerPort_key" ON "ServicePort"("serviceId", "containerPort");

CREATE INDEX "ServiceLink_sourceServiceId_idx" ON "ServiceLink"("sourceServiceId");
CREATE INDEX "ServiceLink_targetServiceId_idx" ON "ServiceLink"("targetServiceId");
CREATE UNIQUE INDEX "ServiceLink_sourceServiceId_targetServiceId_key" ON "ServiceLink"("sourceServiceId", "targetServiceId");

-- AddForeignKey
ALTER TABLE "ServiceEnvVar" ADD CONSTRAINT "ServiceEnvVar_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServicePort" ADD CONSTRAINT "ServicePort_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceLink" ADD CONSTRAINT "ServiceLink_sourceServiceId_fkey" FOREIGN KEY ("sourceServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ServiceLink" ADD CONSTRAINT "ServiceLink_targetServiceId_fkey" FOREIGN KEY ("targetServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;
