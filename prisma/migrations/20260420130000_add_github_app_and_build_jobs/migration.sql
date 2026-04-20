-- Phase: GitHub deploy (2026-04-20)
-- Vercel-style "connect a repo, we build and ship it" flow.
-- - GithubInstallation: one row per (org, GitHub App installation)
-- - BuildJob: append-only history of build attempts
-- - Service: new git-source columns (gitProvider/gitOwner/gitRepo/...)

-- 1. New enum for BuildJob.status
CREATE TYPE "BuildStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- 2. github_installation table
CREATE TABLE "github_installation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "accountType" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "installedByUserId" TEXT,
    "selectedRepos" JSONB,
    "suspendedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "github_installation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "github_installation_installationId_key" ON "github_installation"("installationId");
CREATE INDEX "github_installation_organizationId_idx" ON "github_installation"("organizationId");
CREATE INDEX "github_installation_accountLogin_idx" ON "github_installation"("accountLogin");

ALTER TABLE "github_installation"
    ADD CONSTRAINT "github_installation_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "github_installation"
    ADD CONSTRAINT "github_installation_installedByUserId_fkey"
    FOREIGN KEY ("installedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. New columns on Service for git-source deploys
ALTER TABLE "Service"
    ADD COLUMN "gitProvider"       TEXT,
    ADD COLUMN "gitOwner"          TEXT,
    ADD COLUMN "gitRepo"           TEXT,
    ADD COLUMN "gitBranch"         TEXT,
    ADD COLUMN "gitInstallationId" TEXT,
    ADD COLUMN "buildCommand"      TEXT,
    ADD COLUMN "startCommand"      TEXT,
    ADD COLUMN "rootDirectory"     TEXT,
    ADD COLUMN "detectedFramework" TEXT,
    ADD COLUMN "detectedPort"      INTEGER,
    ADD COLUMN "lastBuildSha"      TEXT,
    ADD COLUMN "lastBuildStatus"   TEXT,
    ADD COLUMN "lastBuildAt"       TIMESTAMP(3);

CREATE INDEX "Service_gitInstallationId_idx" ON "Service"("gitInstallationId");
CREATE INDEX "Service_gitOwner_gitRepo_idx" ON "Service"("gitOwner", "gitRepo");

ALTER TABLE "Service"
    ADD CONSTRAINT "Service_gitInstallationId_fkey"
    FOREIGN KEY ("gitInstallationId") REFERENCES "github_installation"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. build_job table
CREATE TABLE "build_job" (
    "id"                TEXT NOT NULL,
    "serviceId"         TEXT NOT NULL,
    "commitSha"         TEXT NOT NULL,
    "commitMessage"     TEXT,
    "branch"            TEXT NOT NULL,
    "status"            "BuildStatus" NOT NULL DEFAULT 'PENDING',
    "k8sJobName"        TEXT,
    "imageTag"          TEXT,
    "detectedFramework" TEXT,
    "detectedPort"      INTEGER,
    "logs"              TEXT,
    "triggeredBy"       TEXT,
    "startedAt"         TIMESTAMP(3),
    "finishedAt"        TIMESTAMP(3),
    "errorMessage"      TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "build_job_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "build_job_serviceId_idx" ON "build_job"("serviceId");
CREATE INDEX "build_job_status_idx" ON "build_job"("status");
CREATE INDEX "build_job_commitSha_idx" ON "build_job"("commitSha");

ALTER TABLE "build_job"
    ADD CONSTRAINT "build_job_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "Service"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
