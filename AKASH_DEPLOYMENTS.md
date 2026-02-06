# Akash Deployments — AlternateFutures

**Owner:** `akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn`

## Active Deployments

### 1. service-cloud-api (Full Stack)

| Field | Value |
|-------|-------|
| **DSEQ** | 25411473 |
| **Provider** | `akash1kqzpqqhm39umt06wu8m4hx63v5hefhrfmjf9dj` (leet.haus) |
| **Status** | Running |
| **Services** | API + YugabyteDB + IPFS (Kubo) + Jaeger + OTel Collector |
| **URLs** | api.alternatefutures.ai, yb.alternatefutures.ai, ipfs.alternatefutures.ai |
| **Resources** | 8 CPU, 20Gi RAM, 280Gi storage |
| **CI/CD** | `deploy-akash.yml` (full) / `update-manifest.yml` (in-place) |

---

### 2. service-auth (Authentication)

| Field | Value |
|-------|-------|
| **DSEQ** | 25412621 |
| **Provider** | `akash1xmjzu9dczlg9fa4v3pfvwzn7ty89r003laj4ac` (tagus.host) |
| **Status** | Running |
| **Services** | auth-api |
| **URLs** | auth.alternatefutures.ai |
| **Resources** | 1 CPU, 1Gi RAM, 1Gi storage |
| **CI/CD** | `deploy-akash.yml` (full) / `update-manifest.yml` (in-place) |

---

### 3. infrastructure-proxy (SSL Proxy)

| Field | Value |
|-------|-------|
| **DSEQ** | 25312670 |
| **Provider** | DigitalFrontier (`akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z`) |
| **Status** | Running |
| **Dedicated IP** | 77.76.13.213 |
| **Domains** | auth, api, app, docs.alternatefutures.ai |
| **Image** | `ghcr.io/alternatefutures/infrastructure-proxy-pingap:main` |

---

### 4. Infisical Secrets Manager

| Field | Value |
|-------|-------|
| **DSEQ** | 25354545 |
| **Provider** | Europlots (`akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc`) |
| **Status** | Running |
| **Ingress** | `uvhirubqe1aa1att76elejdi3c.ingress.europlots.com` |
| **URL** | secrets.alternatefutures.ai (direct, not through proxy) |

---

## Quick Reference: DSEQ to Service

| DSEQ | Service | Primary URL |
|------|---------|-------------|
| 25411473 | service-cloud-api (full stack) | api.alternatefutures.ai |
| 25412621 | service-auth | auth.alternatefutures.ai |
| 25312670 | infrastructure-proxy (SSL) | 77.76.13.213 |
| 25354545 | Infisical Secrets | secrets.alternatefutures.ai |

> **Note:** Akash Console shows deployments as "Unknown" — use this DSEQ reference.

## Provider Reference

| Provider | Name | Used For |
|----------|------|----------|
| `akash1kqzpqqhm39umt06wu8m4hx63v5hefhrfmjf9dj` | leet.haus | service-cloud-api |
| `akash1xmjzu9dczlg9fa4v3pfvwzn7ty89r003laj4ac` | tagus.host | service-auth |
| `akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z` | DigitalFrontier | SSL proxy |
| `akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc` | Europlots | Infisical (BLOCKED for other services) |

## Commands

### Check deployment status
```bash
# Using Akash Console
https://deploy.cloudmos.io/deployment/akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn/<DSEQ>

# Using Akash CLI
akash query deployment get --owner akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn --dseq <DSEQ>
```

### Update a service (code change)
```bash
# Push to main — CI/CD handles the rest
git push origin main
```

### Full redeploy
See the service-specific deployment docs:
- [service-auth deployment guide](../service-auth/AKASH_DEPLOYMENT.md)

---

*Last updated: 2026-02-06*
