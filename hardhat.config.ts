import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@openzeppelin/hardhat-upgrades'
import * as dotenv from 'dotenv'
import { EndpointId } from '@layerzerolabs/lz-definitions'
import * as fs from 'fs'
import * as path from 'path'

// Load environment variables from .env file
dotenv.config()

// Load network configuration from JSON
const networksConfigPath = path.join(__dirname, 'config', 'networks.json')
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
    process.env.YUSD_ADDRESS = contracts.yusdAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.lzEndpoint && !process.env.LZ_ENDPOINT) {
    process.env.LZ_ENDPOINT = contracts.lzEndpoint // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.adminAddress && !process.env.ADMIN_ADDRESS) {
    process.env.ADMIN_ADDRESS = contracts.adminAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.oftAdapterAddress && !process.env.OFT_ADAPTER_ADDRESS) {
    process.env.OFT_ADAPTER_ADDRESS = contracts.oftAdapterAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.timelockAddress && !process.env.TIMELOCK_ADDRESS) {
    process.env.TIMELOCK_ADDRESS = contracts.timelockAddress // DEPRECATED: Use config/networks.json instead
  }

  // Additional Aegis contract addresses
  if (contracts.aegisConfigAddress && !process.env.AEGIS_CONFIG_ADDRESS) {
    process.env.AEGIS_CONFIG_ADDRESS = contracts.aegisConfigAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.aegisOracleAddress && !process.env.AEGIS_ORACLE_ADDRESS) {
    process.env.AEGIS_ORACLE_ADDRESS = contracts.aegisOracleAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.aegisRewardsAddress && !process.env.AEGIS_REWARDS_ADDRESS) {
    process.env.AEGIS_REWARDS_ADDRESS = contracts.aegisRewardsAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.aegisMintingAddress && !process.env.AEGIS_MINTING_ADDRESS) {
    process.env.AEGIS_MINTING_ADDRESS = contracts.aegisMintingAddress // DEPRECATED: Use config/networks.json instead
  }

  // sYUSD contract addresses
  if (contracts.sYUSDAddress && !process.env.sYUSD_ADDRESS) {
    process.env.sYUSD_ADDRESS = contracts.sYUSDAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.sYUSDSiloAddress && !process.env.sYUSD_SILO_ADDRESS) {
    process.env.sYUSD_SILO_ADDRESS = contracts.sYUSDSiloAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.minterBurnerAddress && !process.env.MINTER_BURNER_ADDRESS) {
    process.env.MINTER_BURNER_ADDRESS = contracts.minterBurnerAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.elevatedMinterBurner && !process.env.ELEVATED_MINTER_BURNER_ADDRESS) {
    process.env.ELEVATED_MINTER_BURNER_ADDRESS = contracts.elevatedMinterBurner // DEPRECATED: Use config/networks.json instead
  }

  // Set LayerZero configuration
  if (networkConfig.layerzero) {
    if (networkConfig.layerzero.targetEid && !process.env.TARGET_EID) {
      process.env.TARGET_EID = networkConfig.layerzero.targetEid.toString() // DEPRECATED: Use config/networks.json instead
    }

    if (networkConfig.layerzero.targetNetworkName && !process.env.TARGET_NETWORK_NAME) {
      process.env.TARGET_NETWORK_NAME = networkConfig.layerzero.targetNetworkName // DEPRECATED: Use config/networks.json instead
    }
  }

  // Set network explorer
  if (networkConfig.explorer && !process.env.NETWORK_EXPLORER) {
    process.env.NETWORK_EXPLORER = networkConfig.explorer // DEPRECATED: Use config/networks.json instead
  }

  // Set common deployment configuration
  const deployment = networksConfig.common.deployment
  if (deployment.assetAddresses && deployment.assetAddresses.length > 0 && !process.env.ASSET_ADDRESSES) {
    process.env.ASSET_ADDRESSES = deployment.assetAddresses.join(',') // DEPRECATED: Use config/networks.json instead
  }

  if (deployment.lockupPeriods && deployment.lockupPeriods.length > 0 && !process.env.LOCKUP_PERIODS) {
    process.env.LOCKUP_PERIODS = deployment.lockupPeriods.join(',') // DEPRECATED: Use config/networks.json instead
  }

  if (deployment.operators && deployment.operators.length > 0 && !process.env.OPERATORS) {
    process.env.OPERATORS = deployment.operators.join(',') // DEPRECATED: Use config/networks.json instead
  }

  if (deployment.custodianAddresses && deployment.custodianAddresses.length > 0 && !process.env.CUSTODIAN_ADDRESSES) {
    process.env.CUSTODIAN_ADDRESSES = deployment.custodianAddresses.join(',') // DEPRECATED: Use config/networks.json instead
  }
}

// Set legacy environment variables for compatibility
setLegacyEnvironmentVariables()

// Function to build RPC URL with API key replacement
function buildRpcUrl(template: string): string {
  return template.replace('{ALCHEMY_API_KEY}', process.env.ALCHEMY_API_KEY || '')
}

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    hardhat: {
      chainId: networksConfig.networks.hardhat.chainId,
    },
    mainnet: {
      url: buildRpcUrl(networksConfig.networks.mainnet.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.mainnet.gasPrice,
    },
    bnbMainnet: {
      url: buildRpcUrl(networksConfig.networks.bnbMainnet.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.bnbMainnet.gasPrice,
      chainId: networksConfig.networks.bnbMainnet.chainId,
    },
    bnbTestnet: {
      url: networksConfig.networks.bnbTestnet.rpcUrl,
      chainId: networksConfig.networks.bnbTestnet.chainId,
      eid: EndpointId.BSC_V2_TESTNET,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.bnbTestnet.gasPrice,
    },
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
  },
  sourcify: {
    enabled: true,
  },
  solidity: {
    compilers: [
      {
        version: networksConfig.common.solidity.version,
        settings: {
          viaIR: true,
          optimizer: networksConfig.common.solidity.optimizer,
          metadata: {
            // do not include the metadata hash, since this is machine dependent
            // and we want all generated code to be deterministic
            // https://docs.soliditylang.org/en/v0.7.6/metadata.html
            bytecodeHash: 'none',
          },
        },
      },
    ],
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || '',
    customChains: [
      {
        network: 'bnbTestnet',
        chainId: networksConfig.networks.bnbTestnet.chainId,
        urls: {
          apiURL: 'https://api-testnet.bscscan.com/api',
          browserURL: networksConfig.networks.bnbTestnet.explorer,
        },
      },
    ],
  },
}

export default config

// Export network config for use in scripts
export { networksConfig }
