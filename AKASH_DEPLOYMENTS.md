# Akash Deployments - AlternateFutures

**Owner:** `akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn`

## Active Deployments

### 1. Auth Service

| Field         | Value                                                                          |
| ------------- | ------------------------------------------------------------------------------ |
| **Name**      | Auth API                                                                       |
| **DSEQ**      | `24492663`                                                                     |
| **Provider**  | `akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc` (europlots)                     |
| **Status**    | ✅ Active                                                                      |
| **Services**  | `auth-api`                                                                     |
| **URLs**      | `auth.alternatefutures.ai`, `6ndirokr8hfs121h8k63mp04ig.ingress.europlots.com` |
| **CI/CD**     | ✅ GitHub Actions workflow                                                     |
| **Resources** | 1 CPU, 1Gi RAM                                                                 |
| **Cost**      | ~7.24 uakt/block                                                               |

---

### 2. Standalone Postgres Database

| Field          | Value                                                      |
| -------------- | ---------------------------------------------------------- |
| **Name**       | Shared Postgres                                            |
| **DSEQ**       | `24520638`                                                 |
| **Provider**   | `akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc` (europlots) |
| **Status**     | ✅ Active                                                  |
| **Services**   | `postgres`                                                 |
| **Connection** | `provider.europlots.com:30155`                             |
| **Database**   | `alternatefutures`                                         |
| **Resources**  | 1 CPU, 1Gi RAM, 10Gi persistent storage                    |
| **Cost**       | ~7.0 uakt/block                                            |
| **Used By**    | Auth Service, API Service                                  |
| **SDL**        | `infra/postgres-standalone.yaml`                           |

---

### 3. Main API (Legacy - To Be Replaced)

| Field         | Value                                                                         |
| ------------- | ----------------------------------------------------------------------------- |
| **Name**      | API Service + Embedded Postgres                                               |
| **DSEQ**      | `24363709`                                                                    |
| **Provider**  | `akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc` (europlots)                    |
| **Status**    | ⚠️ Pending replacement                                                        |
| **Services**  | `api`, `postgres`                                                             |
| **URLs**      | `api.alternatefutures.ai`, `cjrdmusuql9e34bevi8mjgj8pg.ingress.europlots.com` |
| **Resources** | 2 CPU + 2Gi RAM (API), 1 CPU + 1Gi RAM (Postgres)                             |
| **Cost**      | ~19.60 uakt/block                                                             |
| **Note**      | Will be replaced with standalone API using external Postgres                  |

---

### 4. Caddy Edge Proxy

| Field         | Value                                                      |
| ------------- | ---------------------------------------------------------- |
| **Name**      | Caddy Edge Proxy                                           |
| **DSEQ**      | `24489905`                                                 |
| **Provider**  | `akash1kqzpqqhm39umt06wu8m4hx63v5hefhrfmjf9dj` (leet.haus) |
| **Status**    | ✅ Active                                                  |
| **Services**  | `caddy`                                                    |
| **URLs**      | `8etps07re99of8us93gd76p9gs.ingress.dal.leet.haus`         |
| **Static IP** | `170.75.255.101` (ports 80, 443 via IP lease)              |
| **SSL Cert**  | Let's Encrypt E8 (valid Dec 3, 2025 - Mar 3, 2026)         |
| **Domains**   | api, auth, secrets.alternatefutures.ai                     |
| **Admin API** | Port 2019 (external: 31799)                                |
| **Cost**      | ~31.22 uakt/block                                          |
| **SDL**       | `edge/caddy-akash-ip-lease.yaml`                           |

---

### 5. Gateway Service

| Field         | Value                                                  |
| ------------- | ------------------------------------------------------ |
| **Name**      | Gateway                                                |
| **DSEQ**      | `24452456`                                             |
| **Provider**  | `akash1xmjzu9dczlg9fa4v3pfvwzn7ty89r003laj4ac` (tagus) |
| **Status**    | Active                                                 |
| **Services**  | `gateway`                                              |
| **URLs**      | `d5s3eedndp9e740i6begtat6sg.ingress.akash.tagus.host`  |
| **Resources** | 0.5 CPU, 512Mi RAM                                     |
| **Cost**      | ~2.06 uakt/block                                       |

---

### 6. Infisical Secrets Manager

| Field           | Value                                                                               |
| --------------- | ----------------------------------------------------------------------------------- |
| **Name**        | Infisical Secrets Manager                                                           |
| **DSEQ**        | `24458239`                                                                          |
| **Provider**    | `akash1gq42nhp64xrkxlawvchfguuq0wpdx68rkzfnw6` (parallelnode.de)                    |
| **Status**      | ✅ Active                                                                           |
| **Services**    | `infisical`, `postgres`, `redis`                                                    |
| **URLs**        | `secrets.alternatefutures.ai`, `9tnnbebe65bvt1vd2g6k67a72g.ingress.parallelnode.de` |
| **Resources**   | 1 CPU + 1Gi (Infisical), 0.5 CPU + 512Mi (Postgres), 0.25 CPU + 256Mi (Redis)       |
| **Cost**        | ~11.73 uakt/block                                                                   |
| **Admin Setup** | Visit https://secrets.alternatefutures.ai/admin/signup                              |

---

## DNS Configuration

| Domain                        | Target                  | Status    |
| ----------------------------- | ----------------------- | --------- |
| `auth.alternatefutures.ai`    | Points to dseq 24363650 | ✅ Active |
| `api.alternatefutures.ai`     | Points to dseq 24363709 | ✅ Active |
| `secrets.alternatefutures.ai` | Points to dseq 24458239 | ✅ Active |

---

## Quick Reference: DSEQ to Service Name

Since Akash Console shows deployments as "unknown", use this reference:

| DSEQ       | Service Name                 | Primary URL                                         |
| ---------- | ---------------------------- | --------------------------------------------------- |
| `24492663` | Auth API                     | auth.alternatefutures.ai                            |
| `24520638` | Standalone Postgres          | provider.europlots.com:30155                        |
| `24363709` | Main API + Postgres (legacy) | api.alternatefutures.ai                             |
| `24489905` | Caddy Edge Proxy             | 170.75.255.101                                      |
| `24452456` | Gateway Service              | d5s3eedndp9e740i6begtat6sg.ingress.akash.tagus.host |
| `24458239` | Infisical Secrets            | secrets.alternatefutures.ai                         |

> **Note:** Akash Network does not support deployment naming/labels in SDL files.
> The Console will always show "unknown" - use this DSEQ reference instead.

---

## Provider Reference

| Provider                                       | Name            | Reliability                          |
| ---------------------------------------------- | --------------- | ------------------------------------ |
| `akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc` | europlots.com   | Good                                 |
| `akash1xmjzu9dczlg9fa4v3pfvwzn7ty89r003laj4ac` | tagus.host      | Good                                 |
| `akash1gq42nhp64xrkxlawvchfguuq0wpdx68rkzfnw6` | parallelnode.de | Good (recommended for multi-service) |
| `akash1kqzpqqhm39umt06wu8m4hx63v5hefhrfmjf9dj` | leet.haus       | Good (supports IP leases)            |

---

## Commands

### Check deployment status

```bash
# Using Akash MCP
mcp__akash__get-deployment with dseq: <DSEQ>

# Using Akash CLI
akash query deployment get --owner akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn --dseq <DSEQ>
```

### Get services/URLs

```bash
mcp__akash__get-services with owner, dseq, gseq: 1, oseq: 1, provider: <PROVIDER>
```

### Get container logs

```bash
mcp__akash__get-logs with owner, dseq, gseq: 1, oseq: 1, provider: <PROVIDER>, service: <SERVICE_NAME>
```

### Close a deployment

```bash
mcp__akash__close-deployment with dseq: <DSEQ>
```

---

_Last updated: December 7, 2025_
