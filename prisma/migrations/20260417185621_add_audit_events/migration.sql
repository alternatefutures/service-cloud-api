-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "traceId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "userId" TEXT,
    "orgId" TEXT,
    "projectId" TEXT,
    "serviceId" TEXT,
    "deploymentId" TEXT,
    "durationMs" INTEGER,
    "payload" JSONB NOT NULL,
    "errorCode" TEXT,
    "errorMessage" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditEvent_userId_timestamp_idx" ON "AuditEvent"("userId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_orgId_timestamp_idx" ON "AuditEvent"("orgId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_projectId_timestamp_idx" ON "AuditEvent"("projectId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_serviceId_timestamp_idx" ON "AuditEvent"("serviceId", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_category_timestamp_idx" ON "AuditEvent"("category", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_action_timestamp_idx" ON "AuditEvent"("action", "timestamp");

-- CreateIndex
CREATE INDEX "AuditEvent_traceId_idx" ON "AuditEvent"("traceId");

-- CreateIndex
CREATE INDEX "AuditEvent_status_timestamp_idx" ON "AuditEvent"("status", "timestamp");
