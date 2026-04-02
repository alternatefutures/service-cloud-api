-- CreateEnum
CREATE TYPE "ComputeProviderType" AS ENUM ('AKASH', 'PHALA');

-- CreateTable
CREATE TABLE "compute_provider" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "providerType" "ComputeProviderType" NOT NULL,
    "name" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "block_reason" TEXT,
    "is_online" BOOLEAN NOT NULL DEFAULT false,
    "last_seen_online_at" TIMESTAMP(3),
    "gpu_models" TEXT[],
    "gpu_available" INTEGER NOT NULL DEFAULT 0,
    "gpu_total" INTEGER NOT NULL DEFAULT 0,
    "min_price_uact" BIGINT,
    "max_price_uact" BIGINT,
    "attributes" JSONB,
    "last_tested_at" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "compute_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_template_result" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "price_uact" BIGINT,
    "duration_ms" INTEGER,
    "error_message" TEXT,
    "tested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_template_result_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "compute_provider_address_key" ON "compute_provider"("address");

-- CreateIndex
CREATE INDEX "compute_provider_providerType_idx" ON "compute_provider"("providerType");

-- CreateIndex
CREATE INDEX "compute_provider_verified_idx" ON "compute_provider"("verified");

-- CreateIndex
CREATE INDEX "compute_provider_is_online_idx" ON "compute_provider"("is_online");

-- CreateIndex
CREATE INDEX "provider_template_result_template_id_idx" ON "provider_template_result"("template_id");

-- CreateIndex
CREATE INDEX "provider_template_result_passed_idx" ON "provider_template_result"("passed");

-- CreateIndex
CREATE UNIQUE INDEX "provider_template_result_provider_id_template_id_key" ON "provider_template_result"("provider_id", "template_id");

-- AddForeignKey
ALTER TABLE "provider_template_result" ADD CONSTRAINT "provider_template_result_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "compute_provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
