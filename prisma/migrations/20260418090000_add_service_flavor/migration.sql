-- Phase 39: discriminator for the create-time flavor of a Service.
-- Allowed values (validated in the resolver): 'docker' | 'server' | 'function' | 'template'.
-- Free-form String (not Prisma enum) to keep migrations cheap and forward-compatible
-- when new catalog flows are added. Null = legacy row; readers default to 'docker'
-- for VM rows and 'function' for FUNCTION rows (matches today's UI fall-through).
ALTER TABLE "Service" ADD COLUMN "flavor" TEXT;
