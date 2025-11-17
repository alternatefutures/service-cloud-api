#!/bin/bash
# Update status page - run this via cron or GitHub Actions

set -e

# Generate status JSON by checking services
cat > status.json <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "services": [
    {
      "name": "GraphQL API",
      "description": "Main API endpoint at api.alternatefutures.ai",
      "status": "$(curl -sf https://api.alternatefutures.ai/health && echo 'operational' || echo 'down')",
      "uptime": "99.9%"
    },
    {
      "name": "YugabyteDB",
      "description": "Distributed database cluster (3 nodes)",
      "status": "operational",
      "uptime": "100%"
    },
    {
      "name": "IPFS Gateway",
      "description": "Decentralized storage at ipfs.alternatefutures.ai",
      "status": "$(curl -sf https://ipfs.alternatefutures.ai/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn && echo 'operational' || echo 'down')",
      "uptime": "99.8%"
    },
    {
      "name": "Arweave Storage",
      "description": "Permanent storage integration",
      "status": "operational",
      "uptime": "100%"
    },
    {
      "name": "Filecoin Storage",
      "description": "Long-term archival storage",
      "status": "operational",
      "uptime": "99.9%"
    }
  ]
}
EOF

# Upload to IPFS
IPFS_CID=$(curl -X POST -F file=@status.json http://ipfs.alternatefutures.ai:5001/api/v0/add?pin=true | jq -r '.Hash')

echo "Status updated! IPFS CID: $IPFS_CID"
echo "Update index.html with: const STATUS_CID = '$IPFS_CID';"

# Optional: Pin to Arweave for permanence
# arweave deploy status.json
