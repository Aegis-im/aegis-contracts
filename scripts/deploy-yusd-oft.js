const { ethers, network } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig, manageDeploymentFiles, cleanOldDeploymentFile } = require('../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying YUSD OFT on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'YUSDOFT')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['lzEndpoint', 'adminAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - LZ Endpoint: ${contracts.lzEndpoint}`)
  console.log(`  - Admin: ${contracts.adminAddress}`)

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  // Deploy YUSDOFT
  console.log('\n1️⃣ Deploying YUSDOFT...')
  const YUSDOFT = await ethers.getContractFactory('YUSDOFT')
  const yusdOft = await YUSDOFT.deploy(
    contracts.lzEndpoint, // LayerZero endpoint
    contracts.adminAddress, // delegate/owner
  )

  await yusdOft.waitForDeployment()
  const yusdOftAddress = await yusdOft.getAddress()
  console.log(`✅ YUSDOFT deployed to: ${yusdOftAddress}`)

  // Update networks.json
  updateNetworksConfig(networkName, {
    yusdOftAddress: yusdOftAddress,
  })

  // Create deployment files
  manageDeploymentFiles(networkName, {
    YUSDOFT: {
      address: yusdOftAddress,
      contract: yusdOft,
      args: ['YUSD', 'YUSD', contracts.lzEndpoint, contracts.adminAddress],
    },
  }, { createNew: true })

  // Verify deployment
  console.log('\n2️⃣ Verifying deployment...')

  try {
    // Verify basic properties
    const name = await yusdOft.name()
    const symbol = await yusdOft.symbol()
    const decimals = await yusdOft.decimals()
    const owner = await yusdOft.owner()
    const endpoint = await yusdOft.endpoint()

    console.log(`  ✅ Name: ${name}`)
    console.log(`  ✅ Symbol: ${symbol}`)
    console.log(`  ✅ Decimals: ${decimals}`)
    console.log(`  ✅ Owner: ${owner}`)
    console.log(`  ✅ Endpoint: ${endpoint}`)

    // Validate configurations
    if (name !== 'YUSD') {
      throw new Error('❌ Token name mismatch')
    }
    if (symbol !== 'YUSD') {
      throw new Error('❌ Token symbol mismatch')
    }
    if (decimals !== 18n) {
      throw new Error('❌ Token decimals mismatch')
    }
    if (owner.toLowerCase() !== contracts.adminAddress.toLowerCase()) {
      throw new Error('❌ Owner address mismatch')
    }
    if (endpoint.toLowerCase() !== contracts.lzEndpoint.toLowerCase()) {
      throw new Error('❌ Endpoint address mismatch')
    }

    console.log('\n✅ All verifications passed!')
  } catch (error) {
    console.log(`\n❌ Verification failed: ${error.message}`)
    throw error
  }

  // Summary
  console.log('\n🎉 Deployment completed successfully!')
  console.log('📋 Deployed contracts:')
  console.log(`  - YUSDOFT: ${yusdOftAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${yusdOftAddress} 'YUSD' 'YUSD' '${contracts.lzEndpoint}' '${contracts.adminAddress}'`,
  )

  console.log('\n📋 Next steps:')
  console.log('1. Verify contract on explorer')
  console.log('2. Set peers on other networks using setPeer()')
  console.log('3. Configure enforced options if needed')
  console.log('4. Mint initial supply if required')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })