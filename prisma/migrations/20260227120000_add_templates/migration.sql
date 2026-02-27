-- CreateEnum
CREATE TYPE "TemplateCategory" AS ENUM ('GAME_SERVER', 'WEB_SERVER', 'DATABASE', 'AI_ML', 'DEVTOOLS', 'CUSTOM');

-- CreateTable
CREATE TABLE "templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "featured" BOOLEAN NOT NULL DEFAULT false,
    "category" "TemplateCategory" NOT NULL,
    "tags" TEXT[],
    "icon" TEXT,
    "repoUrl" TEXT NOT NULL,
    "dockerImage" TEXT NOT NULL,
    "serviceType" TEXT NOT NULL,
    "envVars" JSONB NOT NULL DEFAULT '[]',
    "resources" JSONB NOT NULL,
    "ports" JSONB NOT NULL DEFAULT '[]',
    "healthCheck" JSONB,
    "persistentStorage" JSONB,
    "pricingUakt" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "templates_category_idx" ON "templates"("category");

-- CreateIndex
CREATE INDEX "templates_featured_idx" ON "templates"("featured");
