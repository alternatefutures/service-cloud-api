-- AlterTable: Make Domain.siteId optional and add org-level ownership
ALTER TABLE "Domain" ALTER COLUMN "siteId" DROP NOT NULL;

-- AddColumn: organizationId for org-level domain ownership
ALTER TABLE "Domain" ADD COLUMN "organization_id" TEXT;

-- CreateIndex
CREATE INDEX "Domain_organization_id_idx" ON "Domain"("organization_id");

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
