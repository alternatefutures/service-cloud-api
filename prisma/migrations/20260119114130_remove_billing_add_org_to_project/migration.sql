-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('PENDING', 'BUILDING', 'UPLOADING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "StorageType" AS ENUM ('IPFS', 'ARWEAVE', 'FILECOIN');

-- CreateEnum
CREATE TYPE "FunctionStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'DEPLOYING', 'FAILED');

-- CreateEnum
CREATE TYPE "DomainType" AS ENUM ('WEB2', 'ARNS', 'ENS', 'IPNS');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');

-- CreateEnum
CREATE TYPE "SslStatus" AS ENUM ('NONE', 'PENDING', 'ACTIVE', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'TRAINING', 'ERROR');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('USER', 'AGENT', 'SYSTEM');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "username" TEXT,
    "walletAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "organization_id" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "primaryDomainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "storageType" "StorageType" NOT NULL DEFAULT 'IPFS',
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AFFunction" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "invokeUrl" TEXT,
    "routes" JSONB,
    "status" "FunctionStatus" NOT NULL DEFAULT 'ACTIVE',
    "projectId" TEXT NOT NULL,
    "siteId" TEXT,
    "currentDeploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AFFunction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AFFunctionDeployment" (
    "id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "blake3Hash" TEXT,
    "assetsCid" TEXT,
    "sgx" BOOLEAN NOT NULL DEFAULT false,
    "afFunctionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AFFunctionDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "domainType" "DomainType" NOT NULL DEFAULT 'WEB2',
    "siteId" TEXT NOT NULL,
    "txtVerificationToken" TEXT,
    "txtVerificationStatus" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "dnsVerifiedAt" TIMESTAMP(3),
    "expectedCname" TEXT,
    "expectedARecord" TEXT,
    "sslStatus" "SslStatus" NOT NULL DEFAULT 'NONE',
    "sslCertificateId" TEXT,
    "sslIssuedAt" TIMESTAMP(3),
    "sslExpiresAt" TIMESTAMP(3),
    "sslAutoRenew" BOOLEAN NOT NULL DEFAULT true,
    "arnsName" TEXT,
    "arnsTransactionId" TEXT,
    "ensName" TEXT,
    "ensContentHash" TEXT,
    "ipnsHash" TEXT,
    "lastDnsCheck" TIMESTAMP(3),
    "dnsCheckAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Zone" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pin" (
    "id" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "name" TEXT,
    "size" INTEGER,
    "deploymentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IPNSRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IPNSRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "avatar" TEXT,
    "systemPrompt" TEXT,
    "model" TEXT NOT NULL DEFAULT 'gpt-4',
    "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
    "functionId" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chat" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "userId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "metadata" JSONB,
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Chat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "chatId" TEXT NOT NULL,
    "agentId" TEXT,
    "userId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Attachment" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "url" TEXT NOT NULL,
    "cid" TEXT,
    "storageType" "StorageType",
    "chatId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PinnedContent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cid" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "pinnedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unpinnedAt" TIMESTAMP(3),
    "filename" TEXT,
    "mimeType" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinnedContent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageSnapshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "totalBytes" BIGINT NOT NULL,
    "pinCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryIngestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "bytesIngested" BIGINT NOT NULL DEFAULT 0,
    "spansCount" INTEGER NOT NULL DEFAULT 0,
    "metricsCount" INTEGER NOT NULL DEFAULT 0,
    "logsCount" INTEGER NOT NULL DEFAULT 0,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetryIngestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ObservabilitySettings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "tracesEnabled" BOOLEAN NOT NULL DEFAULT true,
    "metricsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "logsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "traceRetention" INTEGER NOT NULL DEFAULT 7,
    "metricRetention" INTEGER NOT NULL DEFAULT 30,
    "logRetention" INTEGER NOT NULL DEFAULT 7,
    "sampleRate" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "maxBytesPerHour" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ObservabilitySettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_walletAddress_key" ON "User"("walletAddress");

-- CreateIndex
CREATE INDEX "User_email_idx" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_username_idx" ON "User"("username");

-- CreateIndex
CREATE INDEX "User_walletAddress_idx" ON "User"("walletAddress");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE INDEX "Project_organization_id_idx" ON "Project"("organization_id");

-- CreateIndex
CREATE INDEX "Project_slug_idx" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Site_slug_key" ON "Site"("slug");

-- CreateIndex
CREATE INDEX "Site_projectId_idx" ON "Site"("projectId");

-- CreateIndex
CREATE INDEX "Site_slug_idx" ON "Site"("slug");

-- CreateIndex
CREATE INDEX "Deployment_siteId_idx" ON "Deployment"("siteId");

-- CreateIndex
CREATE INDEX "Deployment_cid_idx" ON "Deployment"("cid");

-- CreateIndex
CREATE INDEX "Deployment_status_idx" ON "Deployment"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AFFunction_slug_key" ON "AFFunction"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "AFFunction_currentDeploymentId_key" ON "AFFunction"("currentDeploymentId");

-- CreateIndex
CREATE INDEX "AFFunction_projectId_idx" ON "AFFunction"("projectId");

-- CreateIndex
CREATE INDEX "AFFunction_slug_idx" ON "AFFunction"("slug");

-- CreateIndex
CREATE INDEX "AFFunction_status_idx" ON "AFFunction"("status");

-- CreateIndex
CREATE INDEX "AFFunctionDeployment_afFunctionId_idx" ON "AFFunctionDeployment"("afFunctionId");

-- CreateIndex
CREATE INDEX "AFFunctionDeployment_cid_idx" ON "AFFunctionDeployment"("cid");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_hostname_key" ON "Domain"("hostname");

-- CreateIndex
CREATE INDEX "Domain_siteId_idx" ON "Domain"("siteId");

-- CreateIndex
CREATE INDEX "Domain_hostname_idx" ON "Domain"("hostname");

-- CreateIndex
CREATE INDEX "Domain_txtVerificationStatus_idx" ON "Domain"("txtVerificationStatus");

-- CreateIndex
CREATE INDEX "Domain_sslStatus_idx" ON "Domain"("sslStatus");

-- CreateIndex
CREATE INDEX "Domain_domainType_idx" ON "Domain"("domainType");

-- CreateIndex
CREATE INDEX "Zone_siteId_idx" ON "Zone"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "Pin_cid_key" ON "Pin"("cid");

-- CreateIndex
CREATE UNIQUE INDEX "Pin_deploymentId_key" ON "Pin"("deploymentId");

-- CreateIndex
CREATE INDEX "Pin_cid_idx" ON "Pin"("cid");

-- CreateIndex
CREATE UNIQUE INDEX "IPNSRecord_name_key" ON "IPNSRecord"("name");

-- CreateIndex
CREATE INDEX "IPNSRecord_siteId_idx" ON "IPNSRecord"("siteId");

-- CreateIndex
CREATE INDEX "IPNSRecord_name_idx" ON "IPNSRecord"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Agent_slug_key" ON "Agent"("slug");

-- CreateIndex
CREATE INDEX "Agent_userId_idx" ON "Agent"("userId");

-- CreateIndex
CREATE INDEX "Agent_slug_idx" ON "Agent"("slug");

-- CreateIndex
CREATE INDEX "Agent_status_idx" ON "Agent"("status");

-- CreateIndex
CREATE INDEX "Agent_functionId_idx" ON "Agent"("functionId");

-- CreateIndex
CREATE INDEX "Chat_userId_idx" ON "Chat"("userId");

-- CreateIndex
CREATE INDEX "Chat_agentId_idx" ON "Chat"("agentId");

-- CreateIndex
CREATE INDEX "Chat_lastMessageAt_idx" ON "Chat"("lastMessageAt");

-- CreateIndex
CREATE INDEX "Message_chatId_idx" ON "Message"("chatId");

-- CreateIndex
CREATE INDEX "Message_agentId_idx" ON "Message"("agentId");

-- CreateIndex
CREATE INDEX "Message_userId_idx" ON "Message"("userId");

-- CreateIndex
CREATE INDEX "Message_role_idx" ON "Message"("role");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE INDEX "Attachment_chatId_idx" ON "Attachment"("chatId");

-- CreateIndex
CREATE INDEX "Attachment_messageId_idx" ON "Attachment"("messageId");

-- CreateIndex
CREATE INDEX "Attachment_cid_idx" ON "Attachment"("cid");

-- CreateIndex
CREATE INDEX "PinnedContent_userId_idx" ON "PinnedContent"("userId");

-- CreateIndex
CREATE INDEX "PinnedContent_cid_idx" ON "PinnedContent"("cid");

-- CreateIndex
CREATE INDEX "PinnedContent_userId_unpinnedAt_idx" ON "PinnedContent"("userId", "unpinnedAt");

-- CreateIndex
CREATE INDEX "PinnedContent_pinnedAt_idx" ON "PinnedContent"("pinnedAt");

-- CreateIndex
CREATE INDEX "PinnedContent_unpinnedAt_idx" ON "PinnedContent"("unpinnedAt");

-- CreateIndex
CREATE INDEX "StorageSnapshot_userId_idx" ON "StorageSnapshot"("userId");

-- CreateIndex
CREATE INDEX "StorageSnapshot_date_idx" ON "StorageSnapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "StorageSnapshot_userId_date_key" ON "StorageSnapshot"("userId", "date");

-- CreateIndex
CREATE INDEX "TelemetryIngestion_projectId_idx" ON "TelemetryIngestion"("projectId");

-- CreateIndex
CREATE INDEX "TelemetryIngestion_periodStart_periodEnd_idx" ON "TelemetryIngestion"("periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "TelemetryIngestion_projectId_periodStart_periodEnd_key" ON "TelemetryIngestion"("projectId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "ObservabilitySettings_projectId_key" ON "ObservabilitySettings"("projectId");

-- CreateIndex
CREATE INDEX "ObservabilitySettings_projectId_idx" ON "ObservabilitySettings"("projectId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_primaryDomainId_fkey" FOREIGN KEY ("primaryDomainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AFFunction" ADD CONSTRAINT "AFFunction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AFFunction" ADD CONSTRAINT "AFFunction_currentDeploymentId_fkey" FOREIGN KEY ("currentDeploymentId") REFERENCES "AFFunctionDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AFFunctionDeployment" ADD CONSTRAINT "AFFunctionDeployment_afFunctionId_fkey" FOREIGN KEY ("afFunctionId") REFERENCES "AFFunction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Zone" ADD CONSTRAINT "Zone_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pin" ADD CONSTRAINT "Pin_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "Deployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IPNSRecord" ADD CONSTRAINT "IPNSRecord_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_functionId_fkey" FOREIGN KEY ("functionId") REFERENCES "AFFunction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PinnedContent" ADD CONSTRAINT "PinnedContent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageSnapshot" ADD CONSTRAINT "StorageSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryIngestion" ADD CONSTRAINT "TelemetryIngestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ObservabilitySettings" ADD CONSTRAINT "ObservabilitySettings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
