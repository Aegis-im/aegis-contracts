// scripts/jusd/deploy-sjusd-oracle.js
const { ethers } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig } = require('../../utils/helpers')

/**
 * Script to deploy sJUSD oracle contracts
 *
 * These oracles will store the sJUSD/JUSD exchange rate (not USD price)
 * The rate represents how much JUSD each sJUSD token is worth
 *
 * Usage:
 * npx hardhat run scripts/jusd/deploy-sjusd-oracle.js --network avalanche
 * npx hardhat run scripts/jusd/deploy-sjusd-oracle.js --network katana
 *
 * Environment Variables:
 * - PRIVATE_KEY: Private key of the deployer account
 * - OPERATOR_ADDRESS: Address that will be granted operator role (optional, defaults to deployer)
 */

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const networkName = network.name === 'unknown' ? 'katana' : network.name

  console.log('🚀 Deploying sJUSD Exchange Rate Oracle')
  console.log(`🌐 Network: ${networkName} (Chain ID: ${network.chainId})`)
  console.log(`👤 Deployer: ${deployer.address}`)
  console.log('📊 Purpose: Track sJUSD/JUSD exchange rate')
  console.log('='.repeat(60))

  // Load network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`Network ${networkName} not found in configuration`)
  }

  const networkConfig = config.networks[networkName]

  // Get operator and owner addresses
  const operatorAddress = process.env.OPERATOR_ADDRESS || deployer.address
  const ownerAddress = networkConfig.contracts.adminAddress || deployer.address

  console.log(`🔐 Owner address: ${ownerAddress}`)
  console.log(`⚡ Operator address: ${operatorAddress}`)

  // Deploy AegisOracleJUSD for sJUSD exchange rate
  console.log('\n📋 Deploying AegisOracleJUSD contract...')

  const AegisOracleJUSD = await ethers.getContractFactory('AegisOracleJUSD')
  const oracle = await AegisOracleJUSD.deploy(
    [operatorAddress], // operators array
    ownerAddress, // initial owner
  )

  await oracle.waitForDeployment()
  const oracleAddress = await oracle.getAddress()

  console.log(`✅ AegisOracleJUSD deployed to: ${oracleAddress}`)

  // Verify deployment
  console.log('\n🔍 Verifying deployment...')

  const decimals = await oracle.decimals()

  console.log(`📊 Oracle decimals: ${decimals}`)
  console.log(`⚡ Operator configured: ${operatorAddress}`)
  console.log(`🔐 Owner configured: ${ownerAddress}`)

  // Update configuration file
  console.log('\n📝 Updating network configuration...')

  updateNetworksConfig(networkName, {
    sjusdOracle: oracleAddress,
  })

  // Summary
  console.log('\n🎉 DEPLOYMENT COMPLETE')
  console.log('='.repeat(60))
  console.log(`Network: ${networkName}`)
  console.log(`sJUSD Oracle: ${oracleAddress}`)
  console.log(`Owner: ${ownerAddress}`)
  console.log(`Operator: ${operatorAddress}`)
  console.log('Purpose: sJUSD/JUSD exchange rate tracking')
  console.log('')
  console.log('📋 Next steps:')
  console.log('1. Verify the contract on block explorer')
  console.log('2. Run update-sjusd-oracle.js to set initial exchange rate')
  console.log('3. Set up automated rate updates')
  console.log('')
  console.log('💡 Note: This oracle tracks sJUSD/JUSD ratio, not USD price')
  console.log('   Rate format: 8 decimals (e.g., 105000000 = 1.05 JUSD per sJUSD)')

  console.log('\n📝 Contract verification command:')
  console.log(`npx hardhat verify --network ${networkName} ${oracleAddress} '["${operatorAddress}"]' '${ownerAddress}'`)

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
