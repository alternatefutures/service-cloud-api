#!/bin/sh
set -e

echo "Starting application..."

# ─── Restore Akash certificate from env var (ephemeral container storage) ────
# Write cert to disk so MCP process can find it. The akash-mcp loadCertificate()
# also reads AKASH_CERT_JSON directly, but writing to disk covers both paths.
if [ -n "$AKASH_CERT_JSON" ] && [ -n "$AKASH_MNEMONIC" ]; then
  CERT_DIR="/app/akash-mcp/.local/akash-certs"
  mkdir -p "$CERT_DIR"
  echo "$AKASH_CERT_JSON" | base64 -d > "$CERT_DIR/_env_cert.json" 2>/dev/null || true
  echo "Akash certificate restored from env"
fi

# NOTE: prisma CLI is a devDependency — not installed in production.
# Migrations must be applied externally. See INCIDENTS.md (canonical runbook).

echo "Starting Node.js application..."
exec node dist/index.js
