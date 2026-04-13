-- AlterTable
ALTER TABLE "Service" ADD COLUMN     "shutdown_priority" INTEGER NOT NULL DEFAULT 50;

-- AlterTable
ALTER TABLE "deployment_policy" ADD COLUMN     "reserved_cents" INTEGER NOT NULL DEFAULT 0;
