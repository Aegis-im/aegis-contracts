import 'hardhat-deploy'
import '@nomiclabs/hardhat-ethers'
import '@layerzerolabs/toolbox-hardhat'
import { HardhatUserConfig } from 'hardhat/types'
import { EndpointId } from '@layerzerolabs/lz-definitions'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'
import { setLegacyEnvironmentVariables } from '../utils/config-helpers'

// Load environment variables from current directory
dotenv.config({ path: '../.env' })

// Load network configuration from parent project
const networksConfigPath = path.join(__dirname, '..', 'config', 'networks.json')
const networksConfig = JSON.parse(fs.readFileSync(networksConfigPath, 'utf8'))

// Set legacy environment variables for compatibility
setLegacyEnvironmentVariables(networksConfig)

const config: HardhatUserConfig = {
  defaultNetwork: 'hardhat',
  networks: {
    mainnet: {
      eid: EndpointId.ETHEREUM_V2_MAINNET as any,
      url: process.env.MAINNET_RPC_URL || networksConfig.networks.mainnet.rpcUrl,
      chainId: networksConfig.networks.mainnet.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.mainnet.gasPrice,
    },
    bnbMainnet: {
      eid: EndpointId.BSC_V2_MAINNET as any,
      url: process.env.BSC_MAINNET_RPC_URL || networksConfig.networks.bnbMainnet.rpcUrl,
      chainId: networksConfig.networks.bnbMainnet.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.bnbMainnet.gasPrice,
    },
    avalanche: {
      eid: EndpointId.AVALANCHE_V2_MAINNET as any,
      url: process.env.AVALANCHE_MAINNET_RPC_URL || networksConfig.networks.avalanche.rpcUrl,
      chainId: networksConfig.networks.avalanche.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.avalanche.gasPrice,
    },
    arbitrum: {
      eid: EndpointId.ARBITRUM_V2_MAINNET as any,
      url: process.env.ARBITRUM_MAINNET_RPC_URL || networksConfig.networks.arbitrum.rpcUrl,
      chainId: networksConfig.networks.arbitrum.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.arbitrum.gasPrice,
    },
    katana: {
      eid: EndpointId.KATANA_V2_MAINNET as any,
      url: process.env.KATANA_MAINNET_RPC_URL || networksConfig.networks.katana.rpcUrl,
      chainId: networksConfig.networks.katana.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.katana.gasPrice,
    },
    base: {
      eid: EndpointId.BASE_V2_MAINNET as any,
      url: process.env.BASE_MAINNET_RPC_URL || networksConfig.networks.base.rpcUrl,
      chainId: networksConfig.networks.base.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.base.gasPrice,
    },
    plasma: {
      eid: EndpointId.PLASMA_V2_MAINNET as any,
      url: process.env.PLASMA_MAINNET_RPC_URL || networksConfig.networks.plasma.rpcUrl,
      chainId: networksConfig.networks.plasma.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.plasma.gasPrice,
    },
    hedera: {
      eid: EndpointId.HEDERA_V2_MAINNET as any,
      url: process.env.HEDERA_MAINNET_RPC_URL || networksConfig.networks.hedera.rpcUrl,
      chainId: networksConfig.networks.hedera.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.hedera.gasPrice,
    },
    sepolia: {
      eid: EndpointId.SEPOLIA_V2_TESTNET as any,
      url: process.env.SEPOLIA_RPC_URL || networksConfig.networks.sepolia.rpcUrl,
      chainId: networksConfig.networks.sepolia.chainId,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.sepolia.gasPrice,
    },
    avalancheFuji: {
      eid: EndpointId.AVALANCHE_V2_TESTNET as any,
      url: process.env.AVALANCHE_FUJI_RPC_URL || networksConfig.networks.avalancheFuji.rpcUrl,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: networksConfig.networks.avalancheFuji.chainId,
      gasPrice: networksConfig.networks.avalancheFuji.gasPrice,
    },
    bnbTestnet: {
      url: networksConfig.networks.bnbTestnet.rpcUrl,
      chainId: networksConfig.networks.bnbTestnet.chainId,
      eid: EndpointId.BSC_V2_TESTNET as any,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gasPrice: networksConfig.networks.bnbTestnet.gasPrice,
    },
    optimismSepolia: {
      eid: EndpointId.OPTSEP_V2_TESTNET as any,
      url: process.env.RPC_URL_OP_SEPOLIA || networksConfig.networks.optimismSepolia.rpcUrl,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: networksConfig.networks.optimismSepolia.chainId,
      gasPrice: networksConfig.networks.optimismSepolia.gasPrice,
    },
  },
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