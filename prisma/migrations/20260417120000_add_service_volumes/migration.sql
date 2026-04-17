-- Phase 38: persistent volumes for raw Docker images.
-- Stores Array<{ name: string; mountPath: string; size: string }> per Service.
-- Templates use template.persistentStorage and ignore this column.
ALTER TABLE "Service" ADD COLUMN "volumes" JSONB;
