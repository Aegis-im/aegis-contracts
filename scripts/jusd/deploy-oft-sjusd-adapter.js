const { ethers, network } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig, manageDeploymentFiles, cleanOldDeploymentFile } = require('../../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying sJUSD OFT Adapter on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'sJUSDOFTAdapter')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['sJUSDAddress','lzEndpoint', 'adminAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - sJUSD: ${contracts.sJUSDAddress}`)
  console.log(`  - LZ Endpoint: ${contracts.lzEndpoint}`)
  console.log(`  - Admin: ${contracts.adminAddress}`)

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  const adminAddress = deployer.address

  // Deploy sJUSDOFTAdapter
  console.log('\n1️⃣ Deploying sJUSDOFTAdapter...')
  const sJUSDOFTAdapter = await ethers.getContractFactory('sJUSDOFTAdapter')
  const oftAdapter = await sJUSDOFTAdapter.deploy(
    contracts.sJUSDAddress, // sJUSD token
    contracts.lzEndpoint, // LayerZero endpoint
    adminAddress, // Owner
  )

  await new Promise((resolve) => setTimeout(resolve, 10000))
  await oftAdapter.waitForDeployment()
  const oftAdapterAddress = await oftAdapter.getAddress()
  console.log(`✅ sJUSDOFTAdapter deployed to: ${oftAdapterAddress}`)

  // Setup permissions
  console.log('\n2️⃣ Setting up permissions...')

  // Connect to AegisMintingJUSD contract
  // const AegisMintingJUSD = await ethers.getContractAt('AegisMintingJUSD', contracts.aegisMintingJusdAddress)

  // Set OFTAdapter as THE cross-chain operator (only 1 operator allowed!)
  // console.log('Setting OFTAdapter as cross-chain operator...')
  // const setOperatorTx = await AegisMintingJUSD.setCrossChainOperator(oftAdapterAddress)
  // await setOperatorTx.wait()
  // console.log('✅ Set OFTAdapter as cross-chain operator')

  // Update networks.json
  updateNetworksConfig(networkName, {
    sjusdOftAdapterAddress: oftAdapterAddress,
  })

  // Create deployment files (always create new to ensure correct args)
  manageDeploymentFiles(networkName, {
    sJUSDOFTAdapter: {
      address: oftAdapterAddress,
      contract: oftAdapter,
      args: [contracts.sJUSDAddress, contracts.lzEndpoint, adminAddress],
    },
  }, { createNew: true })

  // Verify deployment
  console.log('\n3️⃣ Verifying deployment...')

  try {
    // Verify adapter
    const tokenAddr = await oftAdapter.token()

    console.log(`  ✅ OFTAdapter.token: ${tokenAddr}`)

    if (tokenAddr.toLowerCase() !== contracts.sJUSDAddress.toLowerCase()) {
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
  console.log(`  - sJUSDOFTAdapter: ${oftAdapterAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} --contract contracts/sJUSDOFTAdapter.sol:sJUSDOFTAdapter ${oftAdapterAddress} "${contracts.sJUSDAddress}" "${contracts.lzEndpoint}" "${adminAddress}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
