-- AlterTable: add autoDeploy flag to Service
-- Default TRUE so all existing services continue auto-deploying on push.
ALTER TABLE "Service" ADD COLUMN "autoDeploy" BOOLEAN NOT NULL DEFAULT true;
