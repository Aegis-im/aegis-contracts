# JUSD Deployment Scripts

Scripts for deploying the JUSD core contracts.

## Deployment Order

### 1. Deploy JUSD Token

```bash
npx hardhat run scripts/jusd/deploy-jusd.js --network <network>
```

**Environment variables:**
- `INITIAL_OWNER` - contract owner address (optional, defaults to deployer)

### 2. Deploy AegisOracleJUSD

```bash
npx hardhat run scripts/jusd/deploy-aegis-oracle-jusd.js --network <network>
```

**Environment variables:**
- `OPERATORS` - comma-separated list of operators (optional)
- `INITIAL_OWNER` - contract owner address (optional, defaults to deployer)

### 3. Deploy AegisMintingJUSD

```bash
npx hardhat run scripts/jusd/deploy-aegis-minting-jusd.js --network <network>
```

**Required addresses** (from config/networks.json or env):
- `jusdAddress` / `JUSD_ADDRESS`
- `aegisConfigAddress` / `AEGIS_CONFIG_ADDRESS` (shared with YUSD)
- `aegisOracleJUSDAddress` / `AEGIS_ORACLE_JUSD_ADDRESS`

**Environment variables:**
- `INSURANCE_FUND_ADDRESS` - insurance fund address (optional, defaults to deployer)
- `ASSET_ADDRESSES` - comma-separated list of asset addresses (required)
- `LOCKUP_PERIODS` - comma-separated lockup periods for each asset (optional, defaults to 86400)
- `CUSTODIAN_ADDRESSES` - comma-separated custodian addresses for each asset (optional, defaults to deployer)
- `INITIAL_OWNER` - contract owner address (optional, defaults to deployer)

## Full Deployment Example

```bash
# 1. Deploy JUSD
INITIAL_OWNER=0x... npx hardhat run scripts/jusd/deploy-jusd.js --network sepolia

# 2. Deploy AegisOracleJUSD
OPERATORS=0x...,0x... INITIAL_OWNER=0x... npx hardhat run scripts/jusd/deploy-aegis-oracle-jusd.js --network sepolia

# 3. Deploy AegisMintingJUSD
INSURANCE_FUND_ADDRESS=0x... \
ASSET_ADDRESSES=0x...,0x... \
LOCKUP_PERIODS=86400,172800 \
CUSTODIAN_ADDRESSES=0x...,0x... \
npx hardhat run scripts/jusd/deploy-aegis-minting-jusd.js --network sepolia
```

## Post-Deployment Setup

### 1. Verify Contract

```bash
npx hardhat verify --network sepolia \
  --contract contracts/AegisMintingJUSD.sol:AegisMintingJUSD \
  <AEGIS_MINTING_JUSD_ADDRESS> \
  --constructor-args aegis-minting-jusd-args-sepolia.js
```

### 2. Grant Roles

Grant necessary roles to operators:

```bash
# Grant COLLATERAL_MANAGER_ROLE (for custody transfers)
ROLE=COLLATERAL_MANAGER_ROLE CONTRACT=aegisMintingJUSD \
  npx hardhat run scripts/grant-role.js --network sepolia

# Grant FUNDS_MANAGER_ROLE (for deposit income)
ROLE=FUNDS_MANAGER_ROLE CONTRACT=aegisMintingJUSD \
  npx hardhat run scripts/grant-role.js --network sepolia

# Grant SETTINGS_MANAGER_ROLE (for configuration)
ROLE=SETTINGS_MANAGER_ROLE CONTRACT=aegisMintingJUSD \
  npx hardhat run scripts/grant-role.js --network sepolia
```

### 3. Configure Pre-Collateralized Mint Limits

Set limits for pre-collateralized minting (period duration in seconds, max amount as BPS):

```bash
# Example: 1 day period, 5% max per period
PERIOD_DURATION=86400 MAX_PERIOD_AMOUNT_BPS=500 \
  npx hardhat run scripts/jusd/set-pre-collateralized-limit.js --network sepolia
```

**Parameters:**
- `PERIOD_DURATION` - period duration in seconds (e.g., 86400 = 1 day)
- `MAX_PERIOD_AMOUNT_BPS` - max mint per period as % of totalSupply in BPS (e.g., 500 = 5%)

**Examples:**
```bash
# 1 day, 5%
PERIOD_DURATION=86400 MAX_PERIOD_AMOUNT_BPS=500 npx hardhat run scripts/jusd/set-pre-collateralized-limit.js --network sepolia

# 1 hour, 10%
PERIOD_DURATION=3600 MAX_PERIOD_AMOUNT_BPS=1000 npx hardhat run scripts/jusd/set-pre-collateralized-limit.js --network sepolia

# Disable limit
PERIOD_DURATION=0 MAX_PERIOD_AMOUNT_BPS=0 npx hardhat run scripts/jusd/set-pre-collateralized-limit.js --network sepolia
```

### 4. Set JUSD Minter

After deploying AegisMintingJUSD, set it as the minter for JUSD:

```bash
# Via JUSD owner
await jusdContract.setMinter(aegisMintingJUSDAddress)
```

## Complete Deployment Example

```bash
# 1. Deploy JUSD
INITIAL_OWNER=0x... npx hardhat run scripts/jusd/deploy-jusd.js --network sepolia

# 2. Deploy AegisOracleJUSD
OPERATORS=0x...,0x... INITIAL_OWNER=0x... \
  npx hardhat run scripts/jusd/deploy-aegis-oracle-jusd.js --network sepolia

# 3. Deploy AegisMintingJUSD
ASSET_ADDRESSES=0xa8d8524be97a6b0bdfa9ab2635e18e9fe8384eda \
  npx hardhat run scripts/jusd/deploy-aegis-minting-jusd.js --network sepolia

# 4. Verify AegisMintingJUSD
npx hardhat verify --network sepolia \
  --contract contracts/AegisMintingJUSD.sol:AegisMintingJUSD \
  0x1FE05C75a8affb3889a3078dA7EcCc0805Dc727A \
  --constructor-args aegis-minting-jusd-args-sepolia.js

# 5. Grant roles
ROLE=COLLATERAL_MANAGER_ROLE CONTRACT=aegisMintingJUSD \
  npx hardhat run scripts/grant-role.js --network sepolia

ROLE=FUNDS_MANAGER_ROLE CONTRACT=aegisMintingJUSD \
  npx hardhat run scripts/grant-role.js --network sepolia

ROLE=SETTINGS_MANAGER_ROLE CONTRACT=aegisMintingJUSD \
  npx hardhat run scripts/grant-role.js --network sepolia

# 6. Set pre-collateralized mint limits (1 day, 5%)
PERIOD_DURATION=86400 MAX_PERIOD_AMOUNT_BPS=500 \
  npx hardhat run scripts/jusd/set-pre-collateralized-limit.js --network sepolia
```

## Verification

Each script outputs the verification command for the contract explorer.
For AegisMintingJUSD, a `aegis-minting-jusd-args-<network>.js` file is created with constructor arguments.

Note: All verification commands include the `--contract` parameter to specify the exact contract path, as JUSD/YUSD contracts may have identical bytecode.

## Notes

- AegisConfig is shared between YUSD and JUSD, no separate deployment needed
- AegisRewards is not used for JUSD
- All addresses are saved to `config/networks.json`

