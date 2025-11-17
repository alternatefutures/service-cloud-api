#!/bin/bash

# Akash Testnet Faucet Script
# Hits the faucet for testnet wallet akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn

WALLET_ADDRESS="akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn"
FAUCET_URL="https://faucet.sandbox-01.aksh.pw"

# Get current timestamp
TIMESTAMP=$(date +"%Y-%m-%d %H:%M:%S")

# Hit the faucet
echo "[$TIMESTAMP] Requesting AKT from faucet for $WALLET_ADDRESS"
curl -X POST "$FAUCET_URL" \
  -H "Content-Type: application/json" \
  -d "{\"address\": \"$WALLET_ADDRESS\"}" \
  2>&1 | tee -a /tmp/akash-faucet.log

echo "" >> /tmp/akash-faucet.log
