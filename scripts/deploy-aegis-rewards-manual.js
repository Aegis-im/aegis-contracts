// scripts/deploy-aegis-rewards-manual.js
const { ethers } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig } = require('../utils/helpers')



async function main() {
  const [deployer] = await ethers.getSigners()
  // Get network
  const network = await ethers.provider.getNetwork()
  const networkName = network.name
  console.log(`🚀 Deploying NEW AegisRewardsManual on ${networkName}...`)
  console.log('Deploying AegisRewardsManual with the account:', deployer.address)

  // Get parameters from networks.json
  // --------------------------------------------------------------------
  const networksConfig = getNetworksConfig()
  if (!networksConfig || !networksConfig.networks[networkName]) {
    throw new Error(`Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = networksConfig.networks[networkName]

  // Get contract addresses from config
  const contracts = networkConfig.contracts || {}

  // Validate required addresses
  if (!contracts.yusdAddress && !contracts.yusdOftAddress) {
    throw new Error(`YUSD address not found in config for network ${networkName}`)
  }
  if (!contracts.aegisConfigAddress) {
    throw new Error(`AegisConfig address not found in config for network ${networkName}`)
  }

  const yusdAddress = contracts.yusdAddress || contracts.yusdOftAddress
  const aegisConfigAddress = contracts.aegisConfigAddress
  const admin = contracts.adminAddress || deployer.address

  console.log('📋 Using addresses from config:')
  console.log(`  - YUSD: ${yusdAddress}`)
  console.log(`  - AegisConfig: ${aegisConfigAddress}`)
  console.log(`  - Admin: ${admin}`)

  // --------------------------------------------------------------------
  // DEPLOYMENT
  // --------------------------------------------------------------------

  // Deploy AegisRewardsManual
  console.log('\nDeploying AegisRewardsManual...')
  const AegisRewardsManual = await ethers.getContractFactory('AegisRewardsManual')
  const aegisRewardsManualContract = await AegisRewardsManual.deploy(yusdAddress, aegisConfigAddress, admin)
  await aegisRewardsManualContract.waitForDeployment()
  const aegisRewardsManualAddress = await aegisRewardsManualContract.getAddress()
  console.log('AegisRewardsManual deployed to:', aegisRewardsManualAddress)

  // Update networks.json with new AegisMinting address
  updateNetworksConfig(networkName, {
    aegisRewardsManualAddress: aegisRewardsManualAddress,
  })

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisRewardsManual:', aegisRewardsManualAddress)

  console.log('\nVerification command:')
  console.log(
    `npx hardhat verify --network ${network.name} ${aegisRewardsManualAddress} "${yusdAddress}" "${aegisConfigAddress}" "${admin}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
