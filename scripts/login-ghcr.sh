#!/bin/bash
# GitHub Container Registry Login Helper
# Makes token rotation easy when needed

set -e

echo "🔐 GitHub Container Registry Login"
echo "=================================="
echo ""

# Check if already logged in
if docker info 2>/dev/null | grep -q "ghcr.io"; then
    echo "✅ Already logged in to ghcr.io"
    echo ""
    read -p "Do you want to re-login? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 0
    fi
fi

echo "Get a new GitHub Personal Access Token:"
echo "  https://github.com/settings/tokens?type=beta"
echo ""
echo "Required permissions:"
echo "  - Repository: alternatefutures/alternatefutures-backend"
echo "  - Packages: Read & Write"
echo "  - Expiration: 1 year"
echo ""

# Prompt for token
read -sp "Paste your GitHub token: " GITHUB_TOKEN
echo ""

# Prompt for username (default: alternatefutures)
read -p "GitHub username [alternatefutures]: " GITHUB_USERNAME
GITHUB_USERNAME=${GITHUB_USERNAME:-alternatefutures}

# Login
echo ""
echo "Logging in to ghcr.io..."
echo "$GITHUB_TOKEN" | docker login ghcr.io -u "$GITHUB_USERNAME" --password-stdin

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Login successful!"
    echo ""
    echo "Your token is now saved in Docker's credential store."
    echo "Set a reminder to re-run this script in ~11 months."
    echo ""
    echo "Recommended: Set calendar reminder for $(date -v+11m +%Y-%m-%d)"
else
    echo ""
    echo "❌ Login failed!"
    exit 1
fi
