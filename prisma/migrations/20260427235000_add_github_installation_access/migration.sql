-- Allow one GitHub App installation (a GitHub user/org account) to be usable
-- from multiple AlternateFutures organizations. Existing installations keep
-- their legacy owner in github_installation.organizationId and are backfilled
-- into this access table.
CREATE TABLE "github_installation_access" (
    "id" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "granted_by_user_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'setup_url',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installation_access_pkey" PRIMARY KEY ("id")
);

INSERT INTO "github_installation_access" (
    "id",
    "installation_id",
    "organization_id",
    "granted_by_user_id",
    "source",
    "created_at",
    "updated_at"
)
SELECT
    'legacy_' || "id",
    "id",
    "organizationId",
    "installedByUserId",
    'legacy_owner',
    "createdAt",
    "updatedAt"
FROM "github_installation"
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX "github_installation_access_installation_id_organization_id_key"
    ON "github_installation_access"("installation_id", "organization_id");

CREATE INDEX "github_installation_access_organization_id_idx"
    ON "github_installation_access"("organization_id");

CREATE INDEX "github_installation_access_granted_by_user_id_idx"
    ON "github_installation_access"("granted_by_user_id");

ALTER TABLE "github_installation_access"
    ADD CONSTRAINT "github_installation_access_installation_id_fkey"
    FOREIGN KEY ("installation_id") REFERENCES "github_installation"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_installation_access"
    ADD CONSTRAINT "github_installation_access_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
