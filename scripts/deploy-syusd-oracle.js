// scripts/deploy-syusd-oracle.js
const { ethers } = require('hardhat')
const fs = require('fs')
const path = require('path')

/**
 * Script to deploy sYUSD oracle contracts on Avalanche and Katana networks
 *
 * These oracles will store the sYUSD/YUSD exchange rate (not USD price)
 * The rate represents how much YUSD each sYUSD token is worth
 *
 * Usage:
 * npx hardhat run scripts/deploy-syusd-oracle.js --network avalanche
 * npx hardhat run scripts/deploy-syusd-oracle.js --network katana
 *
 * Environment Variables:
 * - PRIVATE_KEY: Private key of the deployer account
 * - OPERATOR_ADDRESS: Address that will be granted operator role (optional, defaults to deployer)
 */

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const networkName = network.name === 'unknown' ? 'katana' : network.name

  console.log('🚀 Deploying sYUSD Exchange Rate Oracle')
  console.log(`🌐 Network: ${networkName} (Chain ID: ${network.chainId})`)
  console.log(`👤 Deployer: ${deployer.address}`)
  console.log('📊 Purpose: Track sYUSD/YUSD exchange rate')
  console.log('=' .repeat(60))

  // Load network configuration
  const configPath = path.join(__dirname, '../config/networks.json')
  const networksConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const networkConfig = networksConfig.networks[networkName]

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in configuration`)
  }

  // Get operator and owner addresses
  const operatorAddress = process.env.OPERATOR_ADDRESS || deployer.address
  const ownerAddress = networkConfig.contracts.adminAddress || deployer.address

  console.log(`🔐 Owner address: ${ownerAddress}`)
  console.log(`⚡ Operator address: ${operatorAddress}`)

  // Deploy AegisOracle for sYUSD exchange rate
  console.log('\n📋 Deploying AegisOracle contract...')

  const AegisOracle = await ethers.getContractFactory('AegisOracle')
  const oracle = await AegisOracle.deploy(
    [operatorAddress], // operators array
    ownerAddress,       // initial owner
  )

  await oracle.waitForDeployment()
  const oracleAddress = await oracle.getAddress()

  console.log(`✅ AegisOracle deployed to: ${oracleAddress}`)

  // Verify deployment
  console.log('\n🔍 Verifying deployment...')

  const decimals = await oracle.decimals()

  console.log(`📊 Oracle decimals: ${decimals}`)
  console.log(`⚡ Operator configured: ${operatorAddress}`)
  console.log(`🔐 Owner configured: ${ownerAddress}`)

  // Update configuration file
  console.log('\n📝 Updating network configuration...')

  networksConfig.networks[networkName].contracts.syusdOracle = oracleAddress

  fs.writeFileSync(configPath, JSON.stringify(networksConfig, null, 2))
  console.log('✅ Updated config/networks.json with sYUSD oracle address')

  // Summary
  console.log('\n🎉 DEPLOYMENT COMPLETE')
  console.log('=' .repeat(60))
  console.log(`Network: ${networkName}`)
  console.log(`sYUSD Oracle: ${oracleAddress}`)
  console.log(`Owner: ${ownerAddress}`)
  console.log(`Operator: ${operatorAddress}`)
  console.log('Purpose: sYUSD/YUSD exchange rate tracking')
  console.log('')
  console.log('📋 Next steps:')
  console.log('1. Verify the contract on block explorer')
  console.log('2. Run update-syusd-oracle.js to set initial exchange rate')
  console.log('3. Set up automated rate updates')
  console.log('')
  console.log('💡 Note: This oracle tracks sYUSD/YUSD ratio, not USD price')
  console.log('   Rate format: 8 decimals (e.g., 105000000 = 1.05 YUSD per sYUSD)')

  // Return deployment info for potential verification
  return {
    oracleAddress,
    ownerAddress,
    operatorAddress,
    networkName,
    chainId: network.chainId,
  }
}

// Handle script execution
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('💥 Deployment failed:', error)
      process.exit(1)
    })
}

module.exports = { main }
