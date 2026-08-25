const { ethers, network } = require('hardhat')
const {
  getNetworksConfig,
  updateNetworksConfig,
  manageDeploymentFiles,
  cleanOldDeploymentFile,
} = require('../../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying JUSD OFT on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'JUSDOFT')

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

  // Deploy JUSDOFT
  console.log('\n1️⃣ Deploying JUSDOFT...')
  const JUSDOFT = await ethers.getContractFactory('JUSDOFT')
  const jusdOft = await JUSDOFT.deploy(
    contracts.lzEndpoint, // LayerZero endpoint
    contracts.adminAddress, // delegate/owner
  )

  await jusdOft.waitForDeployment()
  const jusdOftAddress = await jusdOft.getAddress()
  console.log(`✅ JUSDOFT deployed to: ${jusdOftAddress}`)

  // Update networks.json
  updateNetworksConfig(networkName, {
    jusdOftAddress: jusdOftAddress,
  })

  // Create deployment files
  manageDeploymentFiles(
    networkName,
    {
      JUSDOFT: {
        address: jusdOftAddress,
        contract: jusdOft,
        args: [contracts.lzEndpoint, contracts.adminAddress],
      },
    },
    { createNew: true },
  )

  // Verify deployment
  console.log('\n2️⃣ Verifying deployment...')

  try {
    const name = await jusdOft.name()
    const symbol = await jusdOft.symbol()
    const decimals = await jusdOft.decimals()
    const owner = await jusdOft.owner()
    const endpoint = await jusdOft.endpoint()

    console.log(`  ✅ Name: ${name}`)
    console.log(`  ✅ Symbol: ${symbol}`)
    console.log(`  ✅ Decimals: ${decimals}`)
    console.log(`  ✅ Owner: ${owner}`)
    console.log(`  ✅ Endpoint: ${endpoint}`)

    if (name !== 'JUSD') {
      throw new Error('❌ Token name mismatch')
    }
    if (symbol !== 'JUSD') {
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
  console.log(`  - JUSDOFT: ${jusdOftAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${jusdOftAddress} '${contracts.lzEndpoint}' '${contracts.adminAddress}'`,
  )

  console.log('\n📋 Next steps:')
  console.log('1. Verify contract on explorer')
  console.log('2. Set peers: mainnet JUSDMintBurnOFTAdapter <-> this JUSDOFT')
  console.log('3. Configure enforced options if needed')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
