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
    optimismSepolia: {
      eid: EndpointId.OPTSEP_V2_TESTNET,
      url: process.env.RPC_URL_OP_SEPOLIA || networksConfig.networks.optimismSepolia.rpcUrl,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: networksConfig.networks.optimismSepolia.chainId,
      gasPrice: networksConfig.networks.optimismSepolia.gasPrice,
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