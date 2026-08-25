#!/usr/bin/env bash
# Deploy YUSD OFT on Starknet Mainnet
#
# Uses pre-declared class hashes — no Cairo compilation needed.
#
# Prerequisites:
#   - sncast installed: https://github.com/foundry-rs/starknet-foundry
#   - A funded Starknet account (needs STRK for gas fees)
#   - The following env vars set (source .env first):
#       STARKNET_PRIVATE_KEY     — Stark private key (from compute-account-address.js output)
#       STARKNET_ACCOUNT_ADDRESS — your Starknet account contract address
#       STARKNET_ADMIN_ADDRESS   — optional, defaults to STARKNET_ACCOUNT_ADDRESS
#
# Usage:
#   source .env && bash scripts/starknet/deploy-yusd-starknet.sh

set -euo pipefail

# Load .env from repo root
set -a && source "$(dirname "$0")/../../.env" && set +a

# ─── Constants ────────────────────────────────────────────────────────────────
LZ_ENDPOINT="0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68"
STRK_TOKEN="0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d"
ERC20_CLASS_HASH="0x01bea3900ebe975f332083d441cac55f807cf5de7b1aa0b7ccbda1de53268500"
OFT_CLASS_HASH="0x07c02e3797d2c7b848fa94820ffb335617820d2c44d82d6b8cf71c71fbe7dd6e"
MINTER_ROLE="0x4d494e5445525f524f4c45"
BURNER_ROLE="0x4255524e45525f524f4c45"
SHARED_DECIMALS=6

# ─── Env ──────────────────────────────────────────────────────────────────────
RPC_URL="${STARKNET_RPC_URL:-$(node -e "console.log(require('./config/networks.json').networks.starknet.rpcUrl)")}"
ACCOUNT_ADDRESS="${STARKNET_ACCOUNT_ADDRESS:?STARKNET_ACCOUNT_ADDRESS is required}"
PRIVATE_KEY="${STARKNET_PRIVATE_KEY:?STARKNET_PRIVATE_KEY is required}"
ADMIN_ADDRESS="${STARKNET_ADMIN_ADDRESS:-$ACCOUNT_ADDRESS}"

echo "🚀 Deploying YUSD OFT on Starknet Mainnet"
echo "   RPC:     $RPC_URL"
echo "   Account: $ACCOUNT_ADDRESS"
echo "   Admin:   $ADMIN_ADDRESS"
echo ""

# ─── Register sncast account ──────────────────────────────────────────────────
ACCOUNT_NAME="yusd-starknet-deployer"
sncast account import \
  --name "$ACCOUNT_NAME" \
  --address "$ACCOUNT_ADDRESS" \
  --private-key "$PRIVATE_KEY" \
  --type open_zeppelin \
  --url "$RPC_URL" \
  --silent 2>&1 | grep -v "already exists" || true

# ─── Step 1: Deploy ERC20 ─────────────────────────────────────────────────────
echo "1️⃣  Deploying YUSD ERC20 token..."

ERC20_RESULT=$(sncast \
  --account "$ACCOUNT_NAME" \
  deploy \
  --url "$RPC_URL" \
  --class-hash "$ERC20_CLASS_HASH" \
  --arguments "\"YUSD\", \"YUSD\", 18, $ADMIN_ADDRESS")

ERC20_ADDRESS=$(echo "$ERC20_RESULT" | grep -oE 'contract_address: 0x[0-9a-f]+' | awk '{print $2}')
if [[ -z "$ERC20_ADDRESS" ]]; then
  echo "❌ Failed to parse ERC20 address:"
  echo "$ERC20_RESULT"
  exit 1
fi
echo "   ✅ ERC20 deployed: $ERC20_ADDRESS"
echo ""

# ─── Step 2: Deploy OFTMintBurnAdapter ───────────────────────────────────────
echo "2️⃣  Deploying OFTMintBurnAdapter..."

OFT_RESULT=$(sncast \
  --account "$ACCOUNT_NAME" \
  deploy \
  --url "$RPC_URL" \
  --class-hash "$OFT_CLASS_HASH" \
  --arguments "$ERC20_ADDRESS, $ERC20_ADDRESS, $LZ_ENDPOINT, $ADMIN_ADDRESS, $STRK_TOKEN, $SHARED_DECIMALS")

OFT_ADDRESS=$(echo "$OFT_RESULT" | grep -oE 'contract_address: 0x[0-9a-f]+' | awk '{print $2}')
if [[ -z "$OFT_ADDRESS" ]]; then
  echo "❌ Failed to parse OFT address:"
  echo "$OFT_RESULT"
  exit 1
fi
echo "   ✅ OFTMintBurnAdapter deployed: $OFT_ADDRESS"
echo ""

# ─── Step 3: Grant roles ──────────────────────────────────────────────────────
echo "3️⃣  Granting roles to OFT adapter on ERC20..."

sncast \
  --account "$ACCOUNT_NAME" \
  invoke \
  --url "$RPC_URL" \
  --contract-address "$ERC20_ADDRESS" \
  --function "grant_role" \
  --arguments "$MINTER_ROLE, $OFT_ADDRESS"
echo "   ✅ MINTER_ROLE granted"

sncast \
  --account "$ACCOUNT_NAME" \
  invoke \
  --url "$RPC_URL" \
  --contract-address "$ERC20_ADDRESS" \
  --function "grant_role" \
  --arguments "$BURNER_ROLE, $OFT_ADDRESS"
echo "   ✅ BURNER_ROLE granted"
echo ""

# ─── Summary ──────────────────────────────────────────────────────────────────
echo "🎉 Deployment complete!"
echo ""
echo "   YUSD ERC20 (Starknet):  $ERC20_ADDRESS"
echo "   OFTMintBurnAdapter:     $OFT_ADDRESS"
echo ""
echo "📋 Next steps:"
echo "   1. Update config/networks.json starknet.contracts:"
echo "        \"yusdERC20Address\": \"$ERC20_ADDRESS\","
echo "        \"yusdOftAddress\":   \"$OFT_ADDRESS\""
echo ""
echo "   2. Wire Starknet side:"
echo "        STARKNET_YUSD_OFT_ADDRESS=$OFT_ADDRESS node scripts/starknet/wire-starknet-yusd.js"
echo ""
echo "   3. Generate mainnet multisig tx:"
echo "        STARKNET_YUSD_OFT_ADDRESS=$OFT_ADDRESS node scripts/jusd/generate-multisig-wire-txs.js"
