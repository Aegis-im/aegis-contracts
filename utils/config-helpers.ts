import * as fs from 'fs'
import * as path from 'path'
import { Wallet } from 'ethers'

// Helper function to read networks configuration with token replacement
export function getNetworksConfigForHardhat() {
  try {
    const configPath = path.join(__dirname, '..', 'config', 'networks.json')
    const configData = JSON.parse(fs.readFileSync(configPath, 'utf8'))

    // Replace {DEPLOYER_ADDRESS} tokens with actual deployer address
    const deployerAddress = getDeployerAddressForHardhat()
    if (deployerAddress) {
      replaceDeployerAddressTokensForHardhat(configData, deployerAddress)
    }

    return configData
  } catch (error) {
    console.error(`❌ Error reading networks config: ${(error as any).message}`)
    return null
  }
}

// Helper function to get deployer address from private key (for hardhat config)
function getDeployerAddressForHardhat(): string | null {
  try {
    const privateKey = process.env.PRIVATE_KEY
    if (!privateKey) {
      return null
    }

    // Use ethers v6 without importing from hardhat
    const wallet = new Wallet(privateKey)
    return wallet.address
  } catch (error) {
    console.error(`❌ Error getting deployer address: ${(error as any).message}`)
    return null
  }
}

// Helper function to recursively replace {DEPLOYER_ADDRESS} tokens (for hardhat config)
function replaceDeployerAddressTokensForHardhat(obj: any, deployerAddress: string): void {
  for (const key in obj) {
    if (typeof obj[key] === 'string' && obj[key] === '{DEPLOYER_ADDRESS}') {
      obj[key] = deployerAddress
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      replaceDeployerAddressTokensForHardhat(obj[key], deployerAddress)
    }
  }
}

// Function to set environment variables from network config for backward compatibility
// TODO: DEPRECATED - These env variables are set for compatibility with legacy scripts
// TODO: Consider updating scripts to use the new config system instead
export function setLegacyEnvironmentVariables(networksConfig: any) {
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

  if (contracts.adminAddress && !process.env.ADMIN_ADDRESS) {
    process.env.ADMIN_ADDRESS = contracts.adminAddress // DEPRECATED: Use config/networks.json instead
  }

  if (contracts.timelockAddress && !process.env.TIMELOCK_ADDRESS) {
    process.env.TIMELOCK_ADDRESS = contracts.timelockAddress // DEPRECATED: Use config/networks.json instead
  }

  // Set network-specific deployment configuration (if exists)
  const networkDeployment = networkConfig.deployment
  if (networkDeployment) {
    if (networkDeployment.initialOwner && !process.env.INITIAL_OWNER) {
      process.env.INITIAL_OWNER = networkDeployment.initialOwner // DEPRECATED: Use config/networks.json instead
    }

    if (networkDeployment.trustedSignerAddress && !process.env.TRUSTED_SIGNER_ADDRESS) {
      process.env.TRUSTED_SIGNER_ADDRESS = networkDeployment.trustedSignerAddress // DEPRECATED: Use config/networks.json instead
    }

    if (networkDeployment.insuranceFundAddress && !process.env.INSURANCE_FUND_ADDRESS) {
      process.env.INSURANCE_FUND_ADDRESS = networkDeployment.insuranceFundAddress // DEPRECATED: Use config/networks.json instead
    }

    if (
      networkDeployment.assetAddresses &&
      networkDeployment.assetAddresses.length > 0 &&
      !process.env.ASSET_ADDRESSES
    ) {
      process.env.ASSET_ADDRESSES = networkDeployment.assetAddresses.join(',') // DEPRECATED: Use config/networks.json instead
    }

    if (networkDeployment.lockupPeriods && networkDeployment.lockupPeriods.length > 0 && !process.env.LOCKUP_PERIODS) {
      process.env.LOCKUP_PERIODS = networkDeployment.lockupPeriods.join(',') // DEPRECATED: Use config/networks.json instead
    }

    if (
      networkDeployment.custodianAddresses &&
      networkDeployment.custodianAddresses.length > 0 &&
      !process.env.CUSTODIAN_ADDRESSES
    ) {
      process.env.CUSTODIAN_ADDRESSES = networkDeployment.custodianAddresses.join(',') // DEPRECATED: Use config/networks.json instead
    }
  }

  // Set common deployment configuration (fallback)
  const deployment = networksConfig.common.deployment
  if (deployment.assetAddresses && deployment.assetAddresses.length > 0 && !process.env.ASSET_ADDRESSES) {
    process.env.ASSET_ADDRESSES = deployment.assetAddresses.join(',') // DEPRECATED: Use config/networks.json instead
  }

  if (deployment.lockupPeriods && deployment.lockupPeriods.length > 0 && !process.env.LOCKUP_PERIODS) {
    process.env.LOCKUP_PERIODS = deployment.lockupPeriods.join(',') // DEPRECATED: Use config/networks.json instead
  }

  if (deployment.custodianAddresses && deployment.custodianAddresses.length > 0 && !process.env.CUSTODIAN_ADDRESSES) {
    process.env.CUSTODIAN_ADDRESSES = deployment.custodianAddresses.join(',') // DEPRECATED: Use config/networks.json instead
  }

  if (deployment.operators && deployment.operators.length > 0 && !process.env.OPERATORS) {
    process.env.OPERATORS = deployment.operators.join(',') // DEPRECATED: Use config/networks.json instead
  }
}
