#!/bin/bash
#---------------------------------------------------------------------
# AlternateFutures Edge Node Deployment Script
# Run on a fresh Ubuntu 22.04 VPS
#---------------------------------------------------------------------

set -euo pipefail

# Configuration
EDGE_DOMAIN="${EDGE_DOMAIN:-edge.alternatefutures.ai}"
ACME_EMAIL="${ACME_EMAIL:-admin@alternatefutures.ai}"
OPENPROVIDER_USER="${OPENPROVIDER_USER:-system}"
OPENPROVIDER_PASS="${OPENPROVIDER_PASS:-}"

echo "=============================================="
echo "AlternateFutures Edge Node Deployment"
echo "=============================================="

# Check if running as root
if [[ $EUID -ne 0 ]]; then
   echo "This script must be run as root"
   exit 1
fi

# Update system
echo "[1/8] Updating system packages..."
apt-get update
apt-get upgrade -y

# Install HAProxy 2.8+
echo "[2/8] Installing HAProxy 2.8..."
apt-get install -y software-properties-common
add-apt-repository -y ppa:vbernat/haproxy-2.8
apt-get update
apt-get install -y haproxy=2.8.\*

# Install acme.sh for certificate management
echo "[3/8] Installing acme.sh..."
curl https://get.acme.sh | sh -s email="${ACME_EMAIL}"
source ~/.bashrc

# Create directory structure
echo "[4/8] Creating directory structure..."
mkdir -p /etc/haproxy/certs
mkdir -p /etc/haproxy/maps
mkdir -p /etc/haproxy/errors
mkdir -p /opt/edge/scripts

# Copy configuration files
echo "[5/8] Installing configuration..."
cat > /etc/haproxy/haproxy.cfg << 'HAPROXY_CONFIG'
# HAProxy config will be placed here
# Copy from edge/haproxy.cfg
HAPROXY_CONFIG

# Copy domain map
cat > /etc/haproxy/maps/domains.map << 'DOMAIN_MAP'
api.alternatefutures.ai     be_api
auth.alternatefutures.ai    be_auth
DOMAIN_MAP

# Create error pages
echo "[6/8] Creating error pages..."
for code in 400 403 408 500 502 503 504; do
    cat > /etc/haproxy/errors/${code}.http << EOF
HTTP/1.1 ${code}
Content-Type: application/json
Connection: close

{"error": "HTTP ${code}", "message": "Edge node error"}
EOF
done

# Issue SSL certificates
echo "[7/8] Issuing SSL certificates..."
export OPENPROVIDER_REST_USERNAME="${OPENPROVIDER_USER}"
export OPENPROVIDER_REST_PASSWORD="${OPENPROVIDER_PASS}"

~/.acme.sh/acme.sh --issue \
    --server letsencrypt \
    --dns dns_openprovider_rest \
    -d api.alternatefutures.ai \
    -d auth.alternatefutures.ai \
    --keylength ec-256 \
    --dnssleep 60

# Install certificates for HAProxy (combined PEM format)
~/.acme.sh/acme.sh --install-cert \
    -d api.alternatefutures.ai \
    --key-file /etc/haproxy/certs/api.alternatefutures.ai.key \
    --fullchain-file /etc/haproxy/certs/api.alternatefutures.ai.crt \
    --reloadcmd "cat /etc/haproxy/certs/api.alternatefutures.ai.crt /etc/haproxy/certs/api.alternatefutures.ai.key > /etc/haproxy/certs/api.alternatefutures.ai.pem && systemctl reload haproxy"

~/.acme.sh/acme.sh --install-cert \
    -d auth.alternatefutures.ai \
    --key-file /etc/haproxy/certs/auth.alternatefutures.ai.key \
    --fullchain-file /etc/haproxy/certs/auth.alternatefutures.ai.crt \
    --reloadcmd "cat /etc/haproxy/certs/auth.alternatefutures.ai.crt /etc/haproxy/certs/auth.alternatefutures.ai.key > /etc/haproxy/certs/auth.alternatefutures.ai.pem && systemctl reload haproxy"

# Set permissions
chmod 600 /etc/haproxy/certs/*

# Enable and start HAProxy
echo "[8/8] Starting HAProxy..."
systemctl enable haproxy
systemctl restart haproxy

# Verify
echo ""
echo "=============================================="
echo "Deployment Complete!"
echo "=============================================="
echo ""
echo "HAProxy status:"
systemctl status haproxy --no-pager
echo ""
echo "Listening ports:"
ss -tlnp | grep haproxy
echo ""
echo "Next steps:"
echo "1. Configure DNS A records to point to this server's IP"
echo "2. Test: curl -I https://api.alternatefutures.ai"
echo "3. Monitor: http://$(hostname -I | awk '{print $1}'):8404/stats"
echo ""
