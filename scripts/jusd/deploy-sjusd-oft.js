const { ethers, network } = require('hardhat')
const {
  getNetworksConfig,
  updateNetworksConfig,
  manageDeploymentFiles,
  cleanOldDeploymentFile,
} = require('../../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying sJUSD OFT on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'sJUSDOFT')

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

  // Deploy sJUSDOFT
  console.log('\n1️⃣ Deploying sJUSDOFT...')
  const sJUSDOFT = await ethers.getContractFactory('sJUSDOFT')
  const sjusdOft = await sJUSDOFT.deploy(
    'Staked JUSD',
    'sJUSD',
    contracts.lzEndpoint, // LayerZero endpoint
    contracts.adminAddress, // delegate/owner
  )

  await sjusdOft.waitForDeployment()
  const sjusdOftAddress = await sjusdOft.getAddress()
  console.log(`✅ sJUSDOFT deployed to: ${sjusdOftAddress}`)

  // Update networks.json
  updateNetworksConfig(networkName, {
    sjusdOftAddress: sjusdOftAddress,
  })

  // Create deployment files
  manageDeploymentFiles(
    networkName,
    {
      sJUSDOFT: {
        address: sjusdOftAddress,
        contract: sjusdOft,
        args: ['Staked JUSD', 'sJUSD', contracts.lzEndpoint, contracts.adminAddress],
      },
    },
    { createNew: true },
  )

  // Verify deployment
  console.log('\n2️⃣ Verifying deployment...')

  try {
    // Verify basic properties
    const name = await sjusdOft.name()
    const symbol = await sjusdOft.symbol()
    const decimals = await sjusdOft.decimals()
    const owner = await sjusdOft.owner()
    const endpoint = await sjusdOft.endpoint()

    console.log(`  ✅ Name: ${name}`)
    console.log(`  ✅ Symbol: ${symbol}`)
    console.log(`  ✅ Decimals: ${decimals}`)
    console.log(`  ✅ Owner: ${owner}`)
    console.log(`  ✅ Endpoint: ${endpoint}`)

    // Validate configurations
    if (name !== 'Staked JUSD') {
      throw new Error('❌ Token name mismatch')
    }
    if (symbol !== 'sJUSD') {
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
  console.log(`  - sJUSDOFT: ${sjusdOftAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${sjusdOftAddress} 'Staked JUSD' 'sJUSD' '${contracts.lzEndpoint}' '${contracts.adminAddress}'`,
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
