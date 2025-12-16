# Backup & Recovery

## Automated Backups

Daily backups run via GitHub Actions at 4 AM UTC:
- Export PostgreSQL database using `pg_dump`
- Encrypt with `age` (public key encryption)
- Upload to Storacha (IPFS + Filecoin storage)
- Also stored as GitHub artifact (30-day retention)

### Required GitHub Secrets

| Secret | Description |
|--------|-------------|
| `AGE_PUBLIC_KEY` | Public key for encrypting backups |
| `W3_PRINCIPAL` | Storacha agent private key (base64) |
| `W3_PROOF` | Storacha delegation proof (base64) |

### Storacha Configuration

- **Account:** angela@alternatefutures.ai
- **Space:** `alternatefutures-backups`
- **Space DID:** `did:key:z6Mkoe31W9Z8WBznHQ6GPrfPaBdjnFC1fMt6P8QbZ9kKoQU6`
- **CI Agent DID:** `did:key:z6MksU8hnbAmL2xaY7nrRZ6az1qENLMcYdRgJvdPEzFgJzXs`
- **Gateway:** https://w3s.link/ipfs/

### Manual Backup Trigger

```bash
gh workflow run backup-database.yml \
  --repo alternatefutures/service-cloud-api
```

## Database Configuration

**Production (Akash):**
- PostgreSQL runs as internal service (not exposed)
- Connection: `postgresql://postgres:postgres@postgres:5432/alternatefutures`
- Backup runs via sidecar container inside Akash deployment

**Local Development:**
- Uses local PostgreSQL or configured `DATABASE_URL`

## Finding Backups

### Storacha (IPFS + Filecoin)

Backups are stored on IPFS with Filecoin storage deals. Access via:
```
https://w3s.link/ipfs/<CID>
```

List uploads in the space:
```bash
w3 ls
```

### GitHub Artifacts

1. Go to Actions → Backup PostgreSQL Database
2. Select a workflow run
3. Download the artifact (30-day retention)

## Restore Procedure

### 1. Download and Decrypt

```bash
# Get your age private key
export AGE_KEY_FILE=~/.age-key.txt

# Download from Storacha (using CID from workflow logs)
curl -o backup.sql.gz.age "https://w3s.link/ipfs/<CID>"

# Decrypt
age -d -i $AGE_KEY_FILE -o backup.sql.gz backup.sql.gz.age
gunzip backup.sql.gz
```

### 2. Restore to PostgreSQL

```bash
# For local development
psql $DATABASE_URL < backup.sql

# For production (Akash) - connect via sidecar or expose temporarily
# WARNING: This will overwrite existing data
psql postgresql://postgres:postgres@postgres:5432/alternatefutures < backup.sql
```

### 3. Verify Restore

```bash
# Check tables exist
psql $DATABASE_URL -c "\dt"

# Verify record counts
psql $DATABASE_URL -c "SELECT COUNT(*) FROM \"User\";"
psql $DATABASE_URL -c "SELECT COUNT(*) FROM \"Site\";"
```

## Disaster Recovery

### Scenario: Akash deployment lost

1. **Redeploy service-cloud-api** using Akash SDL
   - PostgreSQL will be empty on fresh deployment

2. **Restore from backup**
   - Download latest backup from Storacha or GitHub Artifacts
   - Decrypt with age private key
   - Restore to new PostgreSQL instance

3. **Update DNS** if ingress URL changed
   - Update CNAME for api.alternatefutures.ai

4. **Regenerate secrets** if needed
   - Update Infisical with new deployment URLs
   - Rotate any compromised credentials

## Retention Policy

| Storage | Retention |
|---------|-----------|
| Storacha (IPFS + Filecoin) | Filecoin storage deals (~months-years) |
| GitHub Artifacts | 30 days |

## Related Documentation

- Organization backup overview: https://github.com/alternatefutures/.github/blob/main/BACKUP.md
- Infisical secrets backup: See `service-secrets/BACKUP.md`
