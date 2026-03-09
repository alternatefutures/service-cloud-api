-- Add parentServiceId for companion services (bundled multi-service templates)
ALTER TABLE "Service" ADD COLUMN "parentServiceId" TEXT;

-- Self-referencing FK: companion → parent, cascade delete
ALTER TABLE "Service" ADD CONSTRAINT "Service_parentServiceId_fkey"
  FOREIGN KEY ("parentServiceId") REFERENCES "Service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Index for fast companion lookups
CREATE INDEX "Service_parentServiceId_idx" ON "Service"("parentServiceId");
