const { ethers, network } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig, manageDeploymentFiles, cleanOldDeploymentFile } = require('../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying DIRECT OFT Adapter on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'sYUSDOFTAdapter')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['syusdAddress','lzEndpoint', 'adminAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - sYUSD: ${contracts.syusdAddress}`)
  console.log(`  - LZ Endpoint: ${contracts.lzEndpoint}`)
  console.log(`  - Admin: ${contracts.adminAddress}`)

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  const adminAddress = deployer.address

  // Deploy YUSDMintBurnOFTAdapter (modified to work directly with AegisMinting)
  console.log('\n1️⃣ Deploying sYUSDOFTAdapter...')
  const sYUSDOFTAdapter = await ethers.getContractFactory('sYUSDOFTAdapter')
  // throw new Error('test')
  const oftAdapter = await sYUSDOFTAdapter.deploy(
    contracts.syusdAddress, // sYUSD token
    contracts.lzEndpoint, // LayerZero endpoint
    adminAddress, // Owner
  )

  await new Promise((resolve) => setTimeout(resolve, 10000))
  await oftAdapter.waitForDeployment()
  const oftAdapterAddress = await oftAdapter.getAddress()
  console.log(`✅ sYUSDOFTAdapter deployed to: ${oftAdapterAddress}`)

  // Setup permissions
  console.log('\n2️⃣ Setting up permissions...')

  // Connect to AegisMinting contract
  // const AegisMinting = await ethers.getContractAt('AegisMinting', contracts.aegisMintingAddress)

  // Set OFTAdapter as THE cross-chain operator (only 1 operator allowed!)
  // console.log('Setting OFTAdapter as cross-chain operator...')
  // const setOperatorTx = await AegisMinting.setCrossChainOperator(oftAdapterAddress)
  // await setOperatorTx.wait()
  // console.log('✅ Set OFTAdapter as cross-chain operator')

  // Update networks.json
  updateNetworksConfig(networkName, {
    syusdOftAdapterAddress: oftAdapterAddress,
  })

  // Create deployment files (always create new to ensure correct args)
  manageDeploymentFiles(networkName, {
    sYUSDOFTAdapter: {
      address: oftAdapterAddress,
      contract: oftAdapter,
      args: [contracts.syusdAddress, contracts.lzEndpoint, adminAddress],
    },
  }, { createNew: true })

  // Verify deployment
  console.log('\n3️⃣ Verifying deployment...')

  try {
    // Verify adapter
    const tokenAddr = await oftAdapter.token()

    console.log(`  ✅ OFTAdapter.token: ${tokenAddr}`)

    if (tokenAddr.toLowerCase() !== contracts.syusdAddress.toLowerCase()) {
      throw new Error('❌ OFTAdapter token address mismatch')
    }

    console.log('\n✅ All verifications passed!')
  } catch (error) {
    console.log(`\n❌ Verification failed: ${error.message}`)
    throw error
  }

  // Summary
  console.log('\n🎉 Deployment completed successfully!')
  console.log('📋 Deployed contracts:')
  console.log(`  - sYUSDOFTAdapter: ${oftAdapterAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${oftAdapterAddress} "${contracts.syusdAddress}" "${contracts.lzEndpoint}" "${adminAddress}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
