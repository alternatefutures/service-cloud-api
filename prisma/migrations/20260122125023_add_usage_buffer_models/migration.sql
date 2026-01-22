-- CreateTable
CREATE TABLE "UsageBuffer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bandwidth" INTEGER NOT NULL DEFAULT 0,
    "compute" INTEGER NOT NULL DEFAULT 0,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UsageBuffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageMetadata" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageMetadata_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageBuffer_userId_key" ON "UsageBuffer"("userId");

-- CreateIndex
CREATE INDEX "UsageBuffer_userId_idx" ON "UsageBuffer"("userId");

-- CreateIndex
CREATE INDEX "UsageMetadata_userId_idx" ON "UsageMetadata"("userId");

-- CreateIndex
CREATE INDEX "UsageMetadata_createdAt_idx" ON "UsageMetadata"("createdAt");
