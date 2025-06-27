import 'hardhat-deploy'
import '@nomiclabs/hardhat-ethers'
import '@layerzerolabs/toolbox-hardhat'
import { HardhatUserConfig } from 'hardhat/types'
import { EndpointId } from '@layerzerolabs/lz-definitions'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

// Load environment variables from current directory
dotenv.config({ path: '../.env' })

// Load network configuration from parent project
const networksConfigPath = path.join(__dirname, '..', 'config', 'networks.json')
const networksConfig = JSON.parse(fs.readFileSync(networksConfigPath, 'utf8'))

// Function to set environment variables from network config for backward compatibility
// TODO: DEPRECATED - These env variables are set for compatibility with legacy scripts
// TODO: Consider updating scripts to use the new config system instead
function setLegacyEnvironmentVariables() {
  const currentNetwork = process.env.HARDHAT_NETWORK || 'hardhat'
  const networkConfig = networksConfig.networks[currentNetwork]

  if (!networkConfig) {
    console.warn(`⚠️  Network config not found for: ${currentNetwork}`)
    return
  }

  const contracts = networkConfig.contracts || {}

  // Set legacy environment variables for backward compatibility
  if (contracts.yusdAddress && !process.env.YUSD_ADDRESS) {
    process.env.YUSD_ADDRESS = contracts.yusdAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.lzEndpoint && !process.env.LZ_ENDPOINT) {
    process.env.LZ_ENDPOINT = contracts.lzEndpoint // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.adminAddress && !process.env.ADMIN_ADDRESS) {
    process.env.ADMIN_ADDRESS = contracts.adminAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.oftAdapterAddress && !process.env.OFT_ADAPTER_ADDRESS) {
    process.env.OFT_ADAPTER_ADDRESS = contracts.oftAdapterAddress // DEPRECATED: Use ../config/networks.json instead
  }

  // Additional Aegis contract addresses
  if (contracts.aegisConfigAddress && !process.env.AEGIS_CONFIG_ADDRESS) {
    process.env.AEGIS_CONFIG_ADDRESS = contracts.aegisConfigAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.aegisOracleAddress && !process.env.AEGIS_ORACLE_ADDRESS) {
    process.env.AEGIS_ORACLE_ADDRESS = contracts.aegisOracleAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.aegisRewardsAddress && !process.env.AEGIS_REWARDS_ADDRESS) {
    process.env.AEGIS_REWARDS_ADDRESS = contracts.aegisRewardsAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.aegisMintingAddress && !process.env.AEGIS_MINTING_ADDRESS) {
    process.env.AEGIS_MINTING_ADDRESS = contracts.aegisMintingAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.minterBurnerAddress && !process.env.MINTER_BURNER_ADDRESS) {
    process.env.MINTER_BURNER_ADDRESS = contracts.minterBurnerAddress // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.elevatedMinterBurner && !process.env.ELEVATED_MINTER_BURNER_ADDRESS) {
    process.env.ELEVATED_MINTER_BURNER_ADDRESS = contracts.elevatedMinterBurner // DEPRECATED: Use ../config/networks.json instead
  }

  if (contracts.yusdMintBurnOFTAdapter && !process.env.YUSD_MINT_BURN_OFT_ADAPTER) {
    process.env.YUSD_MINT_BURN_OFT_ADAPTER = contracts.yusdMintBurnOFTAdapter // DEPRECATED: Use ../config/networks.json instead
  }

  // Set network-specific deployment configuration (if exists)
  const networkDeployment = networkConfig.deployment
  if (networkDeployment) {
    if (networkDeployment.initialOwner && !process.env.INITIAL_OWNER) {
      process.env.INITIAL_OWNER = networkDeployment.initialOwner // DEPRECATED: Use ../config/networks.json instead
    }

    if (networkDeployment.trustedSignerAddress && !process.env.TRUSTED_SIGNER_ADDRESS) {
      process.env.TRUSTED_SIGNER_ADDRESS = networkDeployment.trustedSignerAddress // DEPRECATED: Use ../config/networks.json instead
    }

    if (networkDeployment.insuranceFundAddress && !process.env.INSURANCE_FUND_ADDRESS) {
      process.env.INSURANCE_FUND_ADDRESS = networkDeployment.insuranceFundAddress // DEPRECATED: Use ../config/networks.json instead
    }

    if (networkDeployment.assetAddresses && networkDeployment.assetAddresses.length > 0 && !process.env.ASSET_ADDRESSES) {
      process.env.ASSET_ADDRESSES = networkDeployment.assetAddresses.join(',') // DEPRECATED: Use ../config/networks.json instead
    }

    if (networkDeployment.lockupPeriods && networkDeployment.lockupPeriods.length > 0 && !process.env.LOCKUP_PERIODS) {
      process.env.LOCKUP_PERIODS = networkDeployment.lockupPeriods.join(',') // DEPRECATED: Use ../config/networks.json instead
    }

    if (networkDeployment.custodianAddresses && networkDeployment.custodianAddresses.length > 0 && !process.env.CUSTODIAN_ADDRESSES) {
      process.env.CUSTODIAN_ADDRESSES = networkDeployment.custodianAddresses.join(',') // DEPRECATED: Use ../config/networks.json instead
    }
  }

  // Set common deployment configuration (fallback)
  const deployment = networksConfig.common.deployment
  if (deployment.assetAddresses && deployment.assetAddresses.length > 0 && !process.env.ASSET_ADDRESSES) {
    process.env.ASSET_ADDRESSES = deployment.assetAddresses.join(',') // DEPRECATED: Use ../config/networks.json instead
  }

  if (deployment.lockupPeriods && deployment.lockupPeriods.length > 0 && !process.env.LOCKUP_PERIODS) {
    process.env.LOCKUP_PERIODS = deployment.lockupPeriods.join(',') // DEPRECATED: Use ../config/networks.json instead
  }

  if (deployment.custodianAddresses && deployment.custodianAddresses.length > 0 && !process.env.CUSTODIAN_ADDRESSES) {
    process.env.CUSTODIAN_ADDRESSES = deployment.custodianAddresses.join(',') // DEPRECATED: Use ../config/networks.json instead
  }

  if (deployment.operators && deployment.operators.length > 0 && !process.env.OPERATORS) {
    process.env.OPERATORS = deployment.operators.join(',') // DEPRECATED: Use ../config/networks.json instead
  }
}

// Set legacy environment variables for compatibility
setLegacyEnvironmentVariables()

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    sepolia: {
      eid: EndpointId.SEPOLIA_V2_TESTNET,
      url: process.env.SEPOLIA_RPC_URL || networksConfig.networks.sepolia.rpcUrl,
      chainId: networksConfig.networks.sepolia.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.sepolia.gasPrice,
    },
    avalancheFuji: {
      eid: EndpointId.AVALANCHE_V2_TESTNET,
      url: process.env.AVALANCHE_FUJI_RPC_URL || networksConfig.networks.avalancheFuji.rpcUrl,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: networksConfig.networks.avalancheFuji.chainId,
      gasPrice: networksConfig.networks.avalancheFuji.gasPrice,
    },
    bnbTestnet: {
      url: networksConfig.networks.bnbTestnet.rpcUrl,
      chainId: networksConfig.networks.bnbTestnet.chainId,
      eid: EndpointId.BSC_V2_TESTNET,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.bnbTestnet.gasPrice,
    },
  },
  // Указываем путь к контрактам в родительском проекте
  paths: {
    sources: '../contracts',
    artifacts: '../artifacts',
    cache: '../cache',
    deployments: '../deployments',
  },
  solidity: {
    compilers: [
      {
        version: networksConfig.common.solidity.version,
        settings: {
          viaIR: true,
          optimizer: networksConfig.common.solidity.optimizer,
        },
      },
    ],
  },
}

export default config

// Export network config for use in scripts
export { networksConfig }