const { ethers, network } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig, manageDeploymentFiles, cleanOldDeploymentFile } = require('../../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying DIRECT OFT Adapter on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'JUSDMintBurnOFTAdapter')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['jusdAddress', 'aegisMintingJUSDAddress', 'lzEndpoint', 'adminAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - JUSD: ${contracts.jusdAddress}`)
  console.log(`  - AegisMintingJUSD: ${contracts.aegisMintingJUSDAddress}`)
  console.log(`  - LZ Endpoint: ${contracts.lzEndpoint}`)
  console.log(`  - Admin: ${contracts.adminAddress}`)

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  const adminAddress = deployer.address

  // Deploy JUSDMintBurnOFTAdapter (modified to work directly with AegisMintingJUSD)
  console.log('\n1️⃣ Deploying JUSDMintBurnOFTAdapter...')
  const JUSDMintBurnOFTAdapter = await ethers.getContractFactory('JUSDMintBurnOFTAdapter')
  // throw new Error('test')
  const oftAdapter = await JUSDMintBurnOFTAdapter.deploy(
    contracts.jusdAddress, // JUSD token
    contracts.aegisMintingJUSDAddress, // AegisMintingJUSD contract (directly!)
    contracts.lzEndpoint, // LayerZero endpoint
    adminAddress, // Owner
  )

  await new Promise((resolve) => setTimeout(resolve, 10000))
  await oftAdapter.waitForDeployment()
  const jusdOftAdapterAddress = await oftAdapter.getAddress()
  console.log(`✅ JUSDMintBurnOFTAdapter deployed to: ${jusdOftAdapterAddress}`)

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
    jusdOftAdapterAddress,
  })

  // Create deployment files (always create new to ensure correct args)
  manageDeploymentFiles(networkName, {
    JUSDMintBurnOFTAdapter: {
      address: jusdOftAdapterAddress,
      contract: oftAdapter,
      args: [contracts.jusdAddress, contracts.aegisMintingJUSDAddress, contracts.lzEndpoint, adminAddress],
    },
  }, { createNew: true })

  // Verify deployment
  console.log('\n3️⃣ Verifying deployment...')

  try {
    // Verify adapter
    const aegisMintingJUSDAddr = await oftAdapter.getAegisMinting()
    const tokenAddr = await oftAdapter.token()

    console.log(`  ✅ OFTAdapter.aegisMintingJUSD: ${aegisMintingJUSDAddr}`)
    console.log(`  ✅ OFTAdapter.token: ${tokenAddr}`)

    // Validate configurations
    if (aegisMintingJUSDAddr.toLowerCase() !== contracts.aegisMintingJUSDAddress.toLowerCase()) {
      throw new Error('❌ OFTAdapter AegisMintingJUSD address mismatch')
    }
    if (tokenAddr.toLowerCase() !== contracts.jusdAddress.toLowerCase()) {
      throw new Error('❌ OFTAdapter JUSD address mismatch')
    }

    console.log('\n✅ All verifications passed!')
  } catch (error) {
    console.log(`\n❌ Verification failed: ${error.message}`)
    throw error
  }

  // Summary
  console.log('\n🎉 Deployment completed successfully!')
  console.log('📋 Deployed contracts:')
  console.log(`  - JUSDMintBurnOFTAdapter: ${jusdOftAdapterAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${jusdOftAdapterAddress} "${contracts.jusdAddress}" "${contracts.aegisMintingJUSDAddress}" "${contracts.lzEndpoint}" "${adminAddress}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
