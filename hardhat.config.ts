import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import '@openzeppelin/hardhat-upgrades'
import 'solidity-coverage'
import * as dotenv from 'dotenv'
import { setLegacyEnvironmentVariables, getNetworksConfigForHardhat } from './utils/config-helpers'

// Load environment variables from .env file
dotenv.config()

// Load network configuration from JSON with token replacement
const networksConfig = getNetworksConfigForHardhat()

if (!networksConfig) {
  throw new Error('Failed to load networks configuration')
}

// Set legacy environment variables for compatibility
setLegacyEnvironmentVariables(networksConfig)

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
    avalanche: {
      url: buildRpcUrl(networksConfig.networks.avalanche.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.avalanche.gasPrice,
      chainId: networksConfig.networks.avalanche.chainId,
    },
    arbitrum: {
      url: buildRpcUrl(networksConfig.networks.arbitrum.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.arbitrum.gasPrice,
      chainId: networksConfig.networks.arbitrum.chainId,
    },
    katana: {
      url: buildRpcUrl(networksConfig.networks.katana.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.katana.gasPrice,
      chainId: networksConfig.networks.katana.chainId,
    },
    base: {
      url: buildRpcUrl(networksConfig.networks.base.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.base.gasPrice,
      chainId: networksConfig.networks.base.chainId,
    },
    plasma: {
      url: buildRpcUrl(networksConfig.networks.plasma.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.plasma.gasPrice,
      chainId: networksConfig.networks.plasma.chainId,
    },
    hedera: {
      url: buildRpcUrl(networksConfig.networks.hedera.rpcUrl),
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.hedera.gasPrice,
      chainId: networksConfig.networks.hedera.chainId,
    },
    bnbTestnet: {
      url: networksConfig.networks.bnbTestnet.rpcUrl,
      chainId: networksConfig.networks.bnbTestnet.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.bnbTestnet.gasPrice,
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || networksConfig.networks.sepolia.rpcUrl,
      chainId: networksConfig.networks.sepolia.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.sepolia.gasPrice,
    },
    avalancheFuji: {
      url: process.env.AVALANCHE_FUJI_RPC_URL || networksConfig.networks.avalancheFuji.rpcUrl,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: networksConfig.networks.avalancheFuji.chainId,
      gasPrice: networksConfig.networks.avalancheFuji.gasPrice,
    },
    optimismSepolia: {
      url: process.env.RPC_URL_OP_SEPOLIA || networksConfig.networks.optimismSepolia.rpcUrl,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: networksConfig.networks.optimismSepolia.chainId,
      gasPrice: networksConfig.networks.optimismSepolia.gasPrice,
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
      {
        network: 'katana',
        chainId: networksConfig.networks.katana.chainId,
        urls: {
          apiURL: 'https://api.katanascan.com/api',
          browserURL: networksConfig.networks.katana.explorer,
        },
      },
      {
        network: 'avalanche',
        chainId: 43114,
        urls: {
          apiURL: 'https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan',
          browserURL: 'https://avalanche.routescan.io',
        },
      },
      {
        network: 'plasma',
        chainId: networksConfig.networks.plasma.chainId,
        urls: {
          apiURL: 'https://plasmascan.to/api',
          browserURL: 'https://plasmascan.to/',
        },
      },
    ],
  },
}

export default config

// Export network config for use in scripts
export { networksConfig }
