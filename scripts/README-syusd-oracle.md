# sYUSD Oracle Scripts

Quick reference for sYUSD oracle deployment and exchange rate updates.

## 🚀 Quick Start

### 1. Deploy Oracle Contracts

```bash
# Deploy on Avalanche
npx hardhat run scripts/deploy-syusd-oracle.js --network avalanche

# Deploy on Katana
npx hardhat run scripts/deploy-syusd-oracle.js --network katana
```

### 2. Test Exchange Rate Updates (Dry Run)

```bash
# Test without sending transactions
DRY_RUN=true npx hardhat run scripts/update-syusd-oracle.js --network mainnet
```

### 3. Update Oracle Exchange Rates

```bash
# Update both Avalanche and Katana
npx hardhat run scripts/update-syusd-oracle.js --network mainnet

# Update specific network only
TARGET_NETWORKS=avalanche npx hardhat run scripts/update-syusd-oracle.js --network mainnet
```

## 📋 Environment Variables

```bash
# Required for live updates
PRIVATE_KEY=your_private_key_here

# Optional configurations
DRY_RUN=true                    # Enable simulation mode
TARGET_NETWORKS=avalanche,katana # Comma-separated list of networks
OPERATOR_ADDRESS=0x...          # Oracle operator address (deploy script only)
```

## 🔍 Example Output

```
🚀 Starting sYUSD Oracle Update Script
📊 Mode: LIVE
🎯 Target networks: avalanche, katana
============================================================

📡 Fetching sYUSD/YUSD exchange rate from mainnet...
📊 1 sYUSD = 1.01707585 YUSD
💰 Exchange rate: 1.0170758517247558
💰 sYUSD/YUSD Exchange Rate: 1.01707585
🔢 Rate (8 decimals): 101707585

🔄 Updating oracle on avalanche...
👤 Using operator account: 0x...
📊 Current oracle price: 101500000 (8 decimals)
⏰ Last update: 2024-01-15T10:30:00.000Z
🔄 Updating exchange rate to: 101707585
⛽ Estimated gas: 45000
📤 Transaction sent: 0x...
⏳ Waiting for confirmation (timeout: 300s)...
✅ Transaction confirmed on avalanche
⛽ Gas used: 43521

📋 Update Summary:
============================================================
✅ avalanche: Success (tx: 0x...)
✅ katana: Success (tx: 0x...)

🎉 Successfully updated 2/2 oracles
```

## 🔗 Related Files

- `contracts/AegisOracle.sol` - Oracle contract implementation
- `config/networks.json` - Network configuration with oracle addresses
- `docs/syusd-oracle-system.md` - Complete system documentation
