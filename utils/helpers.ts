import { ethers, network } from 'hardhat'
import { OrderLib } from '../typechain-types/contracts/AegisMinting'
import { ClaimRewardsLib } from '../typechain-types/contracts/AegisRewards'
import { HDNodeWallet } from 'ethers'
import * as fs from 'fs'
import * as path from 'path'

export const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
export const SETTINGS_MANAGER_ROLE = ethers.id('SETTINGS_MANAGER_ROLE')
export const FUNDS_MANAGER_ROLE = ethers.id('FUNDS_MANAGER_ROLE')
export const COLLATERAL_MANAGER_ROLE = ethers.id('COLLATERAL_MANAGER_ROLE')
export const REWARDS_MANAGER_ROLE = ethers.id('REWARDS_MANAGER_ROLE')
export const OPERATOR_ROLE = ethers.id('OPERATOR_ROLE')

export const USD_FEED_ADDRESS = '0x0000000000000000000000000000000000000348'

export enum OrderType {
  MINT,
  REDEEM,
  DEPOSIT_INCOME,
}

export enum RedeemRequestStatus {
  PENDING,
  APPROVED,
  REJECTED,
  WITHDRAWN,
}

export const MAX_BPS = 10_000n
export const INCOME_FEE_BP = 500n // 5%

export const trustedSignerAccount = ethers.Wallet.createRandom()
export const insuranceFundAccount = ethers.Wallet.createRandom()
export const custodianAccount = ethers.Wallet.createRandom()

export async function deployFixture() {
  const [owner] = await ethers.getSigners()

  const assetContract = await ethers.deployContract('TestToken', ['Test', 'TST', 18])
  const assetAddress = await assetContract.getAddress()

  const yusdContract = await ethers.deployContract('YUSD', [owner.address])
  const yusdAddress = await yusdContract.getAddress()

  const aegisConfig = await ethers.deployContract('AegisConfig', [trustedSignerAccount, [owner], owner])
  const aegisConfigAddress = await aegisConfig.getAddress()

  const aegisRewardsContract = await ethers.deployContract('AegisRewards', [yusdAddress, aegisConfig, owner])
  const aegisRewardsAddress = await aegisRewardsContract.getAddress()

  const aegisMintingContract = await ethers.deployContract('AegisMinting', [
    yusdAddress,
    aegisConfig,
    aegisRewardsAddress,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    insuranceFundAccount.address,
    [assetAddress],
    [86400],
    [custodianAccount.address],
    owner.address,
  ])
  const aegisMintingAddress = await aegisMintingContract.getAddress()

  await yusdContract.setMinter(aegisMintingAddress)
  await aegisRewardsContract.setAegisMintingAddress(aegisMintingAddress)

  return {
    yusdContract,
    yusdAddress,
    aegisRewardsContract,
    aegisRewardsAddress,
    aegisMintingContract,
    aegisMintingAddress,
    assetContract,
    assetAddress,
    aegisConfig,
    aegisConfigAddress,
  }
}

export async function signOrderByWallet(order: OrderLib.OrderStruct, contractAddress: string, wallet: HDNodeWallet) {
  return wallet.signTypedData(
    {
      name: 'AegisMinting',
      version: '1',
      chainId: 1337n,
      verifyingContract: contractAddress,
    },
    {
      Order: [
        { name: 'orderType', type: 'uint8' },
        { name: 'userWallet', type: 'address' },
        { name: 'collateralAsset', type: 'address' },
        { name: 'collateralAmount', type: 'uint256' },
        { name: 'yusdAmount', type: 'uint256' },
        { name: 'slippageAdjustedAmount', type: 'uint256' },
        { name: 'expiry', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'additionalData', type: 'bytes' },
      ],
    },
    order,
  )
}

export async function signOrder(order: OrderLib.OrderStruct, contractAddress: string) {
  return signOrderByWallet(order, contractAddress, trustedSignerAccount)
}

export async function signClaimRequestByWallet(
  request: ClaimRewardsLib.ClaimRequestStruct,
  contractAddress: string,
  wallet: HDNodeWallet,
) {
  return wallet.signTypedData(
    {
      name: 'AegisRewards',
      version: '1',
      chainId: 1337n,
      verifyingContract: contractAddress,
    },
    {
      ClaimRequest: [
        { name: 'claimer', type: 'address' },
        { name: 'ids', type: 'bytes32[]' },
        { name: 'amounts', type: 'uint256[]' },
      ],
    },
    request,
  )
}

export async function signClaimRequest(request: ClaimRewardsLib.ClaimRequestStruct, contractAddress: string) {
  return signClaimRequestByWallet(request, contractAddress, trustedSignerAccount)
}

export function encodeString(str: string) {
  return ethers.AbiCoder.defaultAbiCoder().encode(['string'], [str])
}

export async function executeInBatch(...promises: Promise<any>[]) {
  await network.provider.send('evm_setAutomine', [false])
  await network.provider.send('evm_setIntervalMining', [0])
  await Promise.all(promises)
  await network.provider.send('hardhat_setNextBlockBaseFeePerGas', ['0x0'])
  await network.provider.send('hardhat_mine', ['0x1'])
  await network.provider.send('evm_setAutomine', [true])
}

// Helper function to update config/networks.json with deployed contract addresses
export function updateNetworksConfig(networkName: string, contractAddresses: Record<string, string>) {
  try {
    const configPath = path.join(__dirname, '..', 'config', 'networks.json')

    // Read existing config
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // Update network contracts
    if (!configData.networks[networkName]) {
      console.log(`⚠️  Network ${networkName} not found in config, skipping config update`)
      return
    }

    if (!configData.networks[networkName].contracts) {
      configData.networks[networkName].contracts = {}
    }

    // Update contract addresses
    Object.keys(contractAddresses).forEach((contractKey) => {
      const oldAddress = configData.networks[networkName].contracts[contractKey]
      const newAddress = contractAddresses[contractKey]

      configData.networks[networkName].contracts[contractKey] = newAddress

      if (oldAddress && oldAddress !== newAddress) {
        console.log(`🔄 Updated ${contractKey}: ${oldAddress} → ${newAddress}`)
      } else {
        console.log(`✅ Set ${contractKey}: ${newAddress}`)
      }
    })

    // Write updated config
    fs.writeFileSync(configPath, JSON.stringify(configData, null, 2))
    console.log(`💾 Updated config/networks.json for ${networkName}`)
  } catch (error) {
    console.log(`❌ Error updating networks config: ${(error as Error).message}`)
  }
}

// Helper function to read networks configuration
export function getNetworksConfig() {
  try {
    const configPath = path.join(__dirname, '..', 'config', 'networks.json')
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // Replace {DEPLOYER_ADDRESS} tokens with actual deployer address
    const deployerAddress = getDeployerAddress()
    if (deployerAddress) {
      replaceDeployerAddressTokens(configData, deployerAddress)
    }

    return configData
  } catch (error) {
    console.error(`❌ Error reading networks config: ${(error as Error).message}`)
    return null
  }
}

// Helper function to get deployer address from private key
function getDeployerAddress(): string | null {
  try {
    const privateKey = process.env.PRIVATE_KEY
    if (!privateKey) {
      return null
    }

    const wallet = new ethers.Wallet(privateKey)
    return wallet.address
  } catch (error) {
    console.error(`❌ Error getting deployer address: ${(error as Error).message}`)
    return null
  }
}

// Helper function to recursively replace {DEPLOYER_ADDRESS} tokens
function replaceDeployerAddressTokens(obj: any, deployerAddress: string): void {
  for (const key in obj) {
    if (typeof obj[key] === 'string' && obj[key] === '{DEPLOYER_ADDRESS}') {
      obj[key] = deployerAddress
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      replaceDeployerAddressTokens(obj[key], deployerAddress)
    }
  }
}

// Helper function to manage deployment files (create new or update existing)
export function manageDeploymentFiles(
  networkName: string,
  contracts: Record<string, any>,
  options: { createNew?: boolean } = {},
) {
  const deploymentsDir = path.join(__dirname, '..', 'deployments', networkName)

  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true })
  }

  Object.entries(contracts).forEach(([contractName, contractData]) => {
    const deploymentPath = path.join(deploymentsDir, `${contractName}.json`)
    const isNewDeployment = !fs.existsSync(deploymentPath) || options.createNew

    if (isNewDeployment) {
      // Create new deployment file with full data
      if (!contractData.contract) {
        console.log(`⚠️ Contract instance required for creating new deployment: ${contractName}`)
        return
      }

      const deploymentFile = {
        address: contractData.address,
        abi: contractData.contract.interface.fragments.map((f: any) => f.format('json')).map((f: any) => JSON.parse(f)),
        transactionHash: contractData.contract.deploymentTransaction()?.hash || '',
        args: contractData.args || [],
        numDeployments: 1,
        solcInputHash: '',
        metadata: '{}',
        bytecode: '0x',
        deployedBytecode: '0x',
        libraries: {},
        facets: [],
        diamondCut: [],
        execute: {},
        history: [],
        implementation: null,
        devdoc: {},
        userdoc: {},
        storageLayout: {},
        gasEstimates: {},
      }

      fs.writeFileSync(deploymentPath, JSON.stringify(deploymentFile, null, 2))
      console.log(`✅ Created deployment file: ${contractName}.json`)
    } else {
      // Update existing deployment file
      try {
        const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'))
        const oldAddress = deploymentData.address
        const newAddress = contractData.address || contractData

        // Update address in deployment file
        deploymentData.address = newAddress

        // Update receipt data if available
        if (deploymentData.receipt) {
          deploymentData.receipt.contractAddress = newAddress
        }

        // Update logs data - replace old address with new one
        if (deploymentData.receipt && deploymentData.receipt.logs) {
          deploymentData.receipt.logs = deploymentData.receipt.logs.map((log: any) => ({
            ...log,
            address: log.address === oldAddress ? newAddress : log.address,
          }))
        }

        // Update event logs data
        if (deploymentData.logs) {
          deploymentData.logs = deploymentData.logs.map((log: any) => ({
            ...log,
            address: log.address === oldAddress ? newAddress : log.address,
          }))
        }

        // Update args data - use new args if provided, otherwise update old address references
        if (contractData.args && Array.isArray(contractData.args)) {
          deploymentData.args = contractData.args
        } else if (deploymentData.args && Array.isArray(deploymentData.args)) {
          deploymentData.args = deploymentData.args.map((arg: any) =>
            arg === oldAddress ? newAddress : arg,
          )
        }

        // Update transactionHash if available
        if (contractData.contract && contractData.contract.deploymentTransaction) {
          const txHash = contractData.contract.deploymentTransaction()?.hash
          if (txHash) {
            deploymentData.transactionHash = txHash
          }
        }

        // Write updated deployment file
        fs.writeFileSync(deploymentPath, JSON.stringify(deploymentData, null, 2))
        console.log(`✅ Updated deployment file: ${contractName} address ${oldAddress} → ${newAddress}`)
      } catch (error) {
        console.log(`❌ Error updating deployment file ${contractName}: ${(error as Error).message}`)
      }
    }
  })
}

// Legacy function for backward compatibility - creates new deployment files
export function createDeploymentFiles(networkName: string, contracts: Record<string, any>) {
  manageDeploymentFiles(networkName, contracts, { createNew: true })
}

// Legacy function for backward compatibility - updates existing deployment files
export function updateDeploymentFiles(networkName: string, contractUpdates: Record<string, string>) {
  manageDeploymentFiles(networkName, contractUpdates)
}

// Helper function to clean old deployment files before creating new ones
export function cleanOldDeploymentFile(networkName: string, contractName: string) {
  try {
    const deploymentPath = path.join(__dirname, '..', 'deployments', networkName, `${contractName}.json`)
    if (fs.existsSync(deploymentPath)) {
      fs.unlinkSync(deploymentPath)
      console.log(`🗑️ Removed old deployment file: ${contractName}.json`)
      return true
    }
    return false
  } catch (error) {
    console.log(`⚠️ Error removing old deployment file ${contractName}: ${(error as Error).message}`)
    return false
  }
}
