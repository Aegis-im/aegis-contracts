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

After deploying AegisMintingJUSD, set it as the minter for JUSD:

```bash
# Via JUSD owner
await jusdContract.setMinter(aegisMintingJUSDAddress)
```

## Verification

Each script outputs the verification command for the contract explorer.
For AegisMintingJUSD, a `aegis-minting-jusd-args-<network>.js` file is created with constructor arguments.

Note: All verification commands include the `--contract` parameter to specify the exact contract path, as JUSD/YUSD contracts may have identical bytecode.

## Notes

- AegisConfig is shared between YUSD and JUSD, no separate deployment needed
- AegisRewards is not used for JUSD
- All addresses are saved to `config/networks.json`

