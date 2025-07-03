const { ethers, network } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig, cleanOldDeploymentFile } = require('../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying NEW AegisMinting on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'AegisMinting')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts
  const deployment = networkConfig.deployment

  // Validate required addresses exist
  const requiredAddresses = [
    'yusdAddress',
    'aegisConfigAddress',
    'aegisRewardsAddress',
    'aegisOracleAddress',
    'adminAddress',
    'feedRegistryAddress',
  ]
  for (const addr of requiredAddresses) {
    if (!contracts[addr] && !deployment[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  // Get parameters from config
  const YUSD_ADDRESS = contracts.yusdAddress
  const AEGIS_CONFIG_ADDRESS = contracts.aegisConfigAddress
  const AEGIS_REWARDS_ADDRESS = contracts.aegisRewardsAddress
  const AEGIS_ORACLE_ADDRESS = contracts.aegisOracleAddress
  const ADMIN_ADDRESS = contracts.adminAddress || deployment.initialOwner?.replace('{DEPLOYER_ADDRESS}', '')
  const INSURANCE_FUND_ADDRESS =
    deployment.insuranceFundAddress?.replace('{DEPLOYER_ADDRESS}', '') || contracts.adminAddress
  const FEED_REGISTRY_ADDRESS = contracts.feedRegistryAddress

  // Get assets from deployment config or use defaults
  const ASSET_ADDRESSES = deployment.assetAddresses || ['0x84b9B910527Ad5C03A9Ca831909E21e236EA7b06']
  const CHAINLINK_HEARTBEATS = deployment.lockupPeriods || ASSET_ADDRESSES.map(() => 86400)
  const CUSTODIANS = deployment.custodianAddresses?.map((addr) => addr.replace('{DEPLOYER_ADDRESS}', '')) || []

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  // Replace placeholder addresses with deployer address
  const finalAdminAddress = ADMIN_ADDRESS || deployer.address
  const finalInsuranceFundAddress = INSURANCE_FUND_ADDRESS || deployer.address
  const finalCustodians = CUSTODIANS.map((addr) => addr || deployer.address)

  console.log('📋 Using addresses from config:')
  console.log(`  - YUSD: ${YUSD_ADDRESS}`)
  console.log(`  - AegisConfig: ${AEGIS_CONFIG_ADDRESS}`)
  console.log(`  - AegisRewards: ${AEGIS_REWARDS_ADDRESS}`)
  console.log(`  - AegisOracle: ${AEGIS_ORACLE_ADDRESS}`)
  console.log(`  - Feed Registry: ${FEED_REGISTRY_ADDRESS}`)
  console.log(`  - Admin: ${finalAdminAddress}`)
  console.log(`  - Insurance Fund: ${finalInsuranceFundAddress}`)
  console.log(`  - Assets: ${ASSET_ADDRESSES}`)
  console.log(`  - Custodians: ${finalCustodians}`)

  // Deploy new AegisMinting contract
  console.log('\n1️⃣ Deploying new AegisMinting...')
  const AegisMinting = await ethers.getContractFactory('AegisMinting')
  const aegisMinting = await AegisMinting.deploy(
    YUSD_ADDRESS,
    AEGIS_CONFIG_ADDRESS,
    AEGIS_REWARDS_ADDRESS,
    AEGIS_ORACLE_ADDRESS,
    FEED_REGISTRY_ADDRESS,
    finalInsuranceFundAddress,
    ASSET_ADDRESSES,
    CHAINLINK_HEARTBEATS,
    finalCustodians,
    finalAdminAddress,
  )

  await aegisMinting.waitForDeployment()
  const aegisMintingAddress = await aegisMinting.getAddress()
  console.log(`✅ New AegisMinting deployed to: ${aegisMintingAddress}`)

  // Setup permissions and connections
  console.log('\n2️⃣ Setting up connections...')

  // Set new AegisMinting as YUSD minter
  console.log('Setting new AegisMinting as YUSD minter...')
  try {
    const yusdContract = await ethers.getContractAt('YUSD', YUSD_ADDRESS)
    const setMinterTx = await yusdContract.setMinter(aegisMintingAddress)
    await setMinterTx.wait()
    console.log('✅ AegisMinting set as YUSD minter')
  } catch (error) {
    console.error(`❌ Error setting minter: ${error.message}`)
    console.log('Please set the minter manually using the YUSD contract owner')
  }

  // Update AegisRewards if needed
  console.log('Updating AegisRewards contract...')
  try {
    const aegisRewardsContract = await ethers.getContractAt('AegisRewards', AEGIS_REWARDS_ADDRESS)
    const setAegisMintingTx = await aegisRewardsContract.setAegisMintingAddress(aegisMintingAddress)
    await setAegisMintingTx.wait()
    console.log('✅ AegisRewards updated with new AegisMinting address')
  } catch (error) {
    console.error(`❌ Error updating AegisRewards: ${error.message}`)
    console.log('Please update AegisRewards manually using the contract owner')
  }

  // Update networks.json with new AegisMinting address
  updateNetworksConfig(networkName, {
    aegisMintingAddress: aegisMintingAddress,
  })

  // Verify deployment
  console.log('\n3️⃣ Verifying deployment...')
  try {
    // Basic verification
    const yusdAddr = await aegisMinting.yusd()
    const configAddr = await aegisMinting.aegisConfig()
    const rewardsAddr = await aegisMinting.aegisRewards()
    const oracleAddr = await aegisMinting.aegisOracle()

    console.log(`  ✅ AegisMinting.yusd: ${yusdAddr}`)
    console.log(`  ✅ AegisMinting.aegisConfig: ${configAddr}`)
    console.log(`  ✅ AegisMinting.aegisRewards: ${rewardsAddr}`)
    console.log(`  ✅ AegisMinting.aegisOracle: ${oracleAddr}`)

    // Validate configurations
    if (yusdAddr.toLowerCase() !== YUSD_ADDRESS.toLowerCase()) {
      throw new Error('❌ AegisMinting YUSD address mismatch')
    }
    if (configAddr.toLowerCase() !== AEGIS_CONFIG_ADDRESS.toLowerCase()) {
      throw new Error('❌ AegisMinting AegisConfig address mismatch')
    }

    console.log('\n✅ All verifications passed!')
  } catch (error) {
    console.log(`\n❌ Verification failed: ${error.message}`)
    throw error
  }

  // Summary
  console.log('\n🎉 Deployment completed successfully!')
  console.log('📋 Updated contracts:')
  console.log(`  - NEW AegisMinting: ${aegisMintingAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${aegisMintingAddress} --constructor-args-path deploy-args.js`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
