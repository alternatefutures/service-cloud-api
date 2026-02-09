# Akash deployments (service-cloud-api)

This file intentionally **does not** track “currently active” DSEQs/providers/IPs anymore (those values drift and create inconsistencies).

## Source of truth (current production state)

- `DEPLOYMENTS.md` (repo root)
- `.github/DEPLOYMENTS.md` (repo root)

## What runs where (high level)

- **Akash**:
  - `postgres (db)` (standalone)
  - `data services` (IPFS + Jaeger; OTel collector currently disabled)
  - `service-cloud-api` (API-only deployment)
  - `service-auth`
  - `infrastructure-proxy` (SSL proxy + dedicated IP lease)
- **Vercel**:
  - `web-app.alternatefutures.ai` (dashboard)

## How to inspect live deployments

- **Cloudmos**:
  - `https://deploy.cloudmos.io/addresses/akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn`
  - Or per deployment: `https://deploy.cloudmos.io/deployment/<owner>/<dseq>`
- **Repo script**:
  - `cd akash-mcp && npx tsx scripts/list-deployments.ts`

## Notes

- **Infisical** is optional and lives under `service-secrets/`. If/when production uses Infisical for runtime secrets again, that should be reflected only in the repo-root deployment trackers above.
