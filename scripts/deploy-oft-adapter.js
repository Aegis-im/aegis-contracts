const { ethers, network } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig, manageDeploymentFiles, cleanOldDeploymentFile } = require('../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying DIRECT OFT Adapter on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'YUSDMintBurnOFTAdapter')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['yusdAddress', 'aegisMintingAddress', 'lzEndpoint', 'adminAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - YUSD: ${contracts.yusdAddress}`)
  console.log(`  - AegisMinting: ${contracts.aegisMintingAddress}`)
  console.log(`  - LZ Endpoint: ${contracts.lzEndpoint}`)
  console.log(`  - Admin: ${contracts.adminAddress}`)

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  // Deploy YUSDMintBurnOFTAdapter (modified to work directly with AegisMinting)
  console.log('\n1️⃣ Deploying YUSDMintBurnOFTAdapter...')
  const YUSDMintBurnOFTAdapter = await ethers.getContractFactory('YUSDMintBurnOFTAdapter')
  const oftAdapter = await YUSDMintBurnOFTAdapter.deploy(
    contracts.yusdAddress, // YUSD token
    contracts.aegisMintingAddress, // AegisMinting contract (directly!)
    contracts.lzEndpoint, // LayerZero endpoint
    contracts.adminAddress, // Owner
  )

  await oftAdapter.waitForDeployment()
  const oftAdapterAddress = await oftAdapter.getAddress()
  console.log(`✅ YUSDMintBurnOFTAdapter deployed to: ${oftAdapterAddress}`)

  // Setup permissions
  console.log('\n2️⃣ Setting up permissions...')

  // Connect to AegisMinting contract
  const AegisMinting = await ethers.getContractAt('AegisMinting', contracts.aegisMintingAddress)

  // Set OFTAdapter as THE cross-chain operator (only 1 operator allowed!)
  console.log('Setting OFTAdapter as cross-chain operator...')
  const setOperatorTx = await AegisMinting.setCrossChainOperator(oftAdapterAddress)
  await setOperatorTx.wait()
  console.log('✅ Set OFTAdapter as cross-chain operator')

  // Update networks.json
  updateNetworksConfig(networkName, {
    directOftAdapterAddress: oftAdapterAddress,
  })

  // Create deployment files (always create new to ensure correct args)
  manageDeploymentFiles(networkName, {
    YUSDMintBurnOFTAdapter: {
      address: oftAdapterAddress,
      contract: oftAdapter,
      args: [contracts.yusdAddress, contracts.aegisMintingAddress, contracts.lzEndpoint, contracts.adminAddress],
    },
  }, { createNew: true })

  // Verify deployment
  console.log('\n3️⃣ Verifying deployment...')

  try {
    // Verify adapter
    const aegisMintingAddr = await oftAdapter.getAegisMinting()
    const tokenAddr = await oftAdapter.token()

    console.log(`  ✅ OFTAdapter.aegisMinting: ${aegisMintingAddr}`)
    console.log(`  ✅ OFTAdapter.token: ${tokenAddr}`)

    // Validate configurations
    if (aegisMintingAddr.toLowerCase() !== contracts.aegisMintingAddress.toLowerCase()) {
      throw new Error('❌ OFTAdapter AegisMinting address mismatch')
    }
    if (tokenAddr.toLowerCase() !== contracts.yusdAddress.toLowerCase()) {
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
  console.log(`  - YUSDMintBurnOFTAdapter: ${oftAdapterAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${oftAdapterAddress} "${contracts.yusdAddress}" "${contracts.aegisMintingAddress}" "${contracts.lzEndpoint}" "${contracts.adminAddress}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
