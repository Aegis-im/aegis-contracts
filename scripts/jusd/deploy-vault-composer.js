const { ethers, network } = require('hardhat')
const {
  getNetworksConfig,
  updateNetworksConfig,
  manageDeploymentFiles,
  cleanOldDeploymentFile,
} = require('../../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying JUSDVaultComposer on ${networkName}...`)

  // Remove old deployment file to ensure clean deployment
  cleanOldDeploymentFile(networkName, 'JUSDVaultComposer')

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['sJUSDAddress', 'jusdOftAdapterAddress', 'sjusdOftAdapterAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - sJUSD Vault: ${contracts.sJUSDAddress}`)
  console.log(`  - JUSD OFT Adapter (asset): ${contracts.jusdOftAdapterAddress}`)
  console.log(`  - sJUSD OFT Adapter (share): ${contracts.sjusdOftAdapterAddress}`)

  // Get deployer
  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deploying with account: ${deployer.address}`)

  // Deploy JUSDVaultComposer (extends VaultComposerSync)
  console.log('\n1️⃣ Deploying JUSDVaultComposer...')
  const JUSDVaultComposer = await ethers.getContractFactory('JUSDVaultComposer')
  const composer = await JUSDVaultComposer.deploy(
    contracts.sJUSDAddress, // ERC4626 vault (sJUSD)
    contracts.jusdOftAdapterAddress, // Asset OFT (JUSDMintBurnOFTAdapter)
    contracts.sjusdOftAdapterAddress, // Share OFT (sJUSDOFTAdapter)
  )

  await new Promise((resolve) => setTimeout(resolve, 10000))
  await composer.waitForDeployment()
  const composerAddress = await composer.getAddress()
  console.log(`✅ JUSDVaultComposer deployed to: ${composerAddress}`)

  // Update networks.json
  updateNetworksConfig(networkName, {
    vaultComposerAddress: composerAddress,
  })

  // Create deployment files
  manageDeploymentFiles(
    networkName,
    {
      JUSDVaultComposer: {
        address: composerAddress,
        contract: composer,
        args: [contracts.sJUSDAddress, contracts.jusdOftAdapterAddress, contracts.sjusdOftAdapterAddress],
      },
    },
    { createNew: true },
  )

  // Verify deployment
  console.log('\n2️⃣ Verifying deployment...')

  try {
    const vault = await composer.VAULT()
    const assetOft = await composer.ASSET_OFT()
    const shareOft = await composer.SHARE_OFT()
    const assetErc20 = await composer.ASSET_ERC20()
    const shareErc20 = await composer.SHARE_ERC20()
    const endpoint = await composer.ENDPOINT()
    const vaultEid = await composer.VAULT_EID()

    console.log(`  ✅ VAULT: ${vault}`)
    console.log(`  ✅ ASSET_OFT: ${assetOft}`)
    console.log(`  ✅ SHARE_OFT: ${shareOft}`)
    console.log(`  ✅ ASSET_ERC20 (JUSD): ${assetErc20}`)
    console.log(`  ✅ SHARE_ERC20 (sJUSD): ${shareErc20}`)
    console.log(`  ✅ ENDPOINT: ${endpoint}`)
    console.log(`  ✅ VAULT_EID: ${vaultEid}`)

    if (vault.toLowerCase() !== contracts.sJUSDAddress.toLowerCase()) {
      throw new Error('❌ Vault address mismatch')
    }
    if (assetOft.toLowerCase() !== contracts.jusdOftAdapterAddress.toLowerCase()) {
      throw new Error('❌ Asset OFT address mismatch')
    }
    if (shareOft.toLowerCase() !== contracts.sjusdOftAdapterAddress.toLowerCase()) {
      throw new Error('❌ Share OFT address mismatch')
    }
    // SHARE_ERC20 must equal VAULT (sJUSD IS both the vault and the share token)
    if (shareErc20.toLowerCase() !== contracts.sJUSDAddress.toLowerCase()) {
      throw new Error('❌ Share ERC20 should be the vault (sJUSD)')
    }
    // ASSET_ERC20 must equal JUSD
    if (assetErc20.toLowerCase() !== contracts.jusdAddress.toLowerCase()) {
      throw new Error('❌ Asset ERC20 should be JUSD')
    }

    console.log('\n✅ All verifications passed!')
  } catch (error) {
    console.log(`\n❌ Verification failed: ${error.message}`)
    throw error
  }

  // Summary
  console.log('\n🎉 Deployment completed successfully!')
  console.log('📋 Deployed contracts:')
  console.log(`  - JUSDVaultComposer: ${composerAddress}`)

  console.log('\n📝 Contract verification command:')
  console.log(
    `npx hardhat verify --network ${networkName} --contract contracts/JUSDVaultComposer.sol:JUSDVaultComposer ${composerAddress} "${contracts.sJUSDAddress}" "${contracts.jusdOftAdapterAddress}" "${contracts.sjusdOftAdapterAddress}"`,
  )

  console.log('\n📋 Next steps:')
  console.log('1. Verify contract on explorer')
  console.log('2. Register composer as compose delegate on LZ Endpoint')
  console.log('   - Call endpoint.setDelegate(composerAddress) on both OFT adapters')
  console.log('   - Or set composer as lzCompose receiver via OFT adapter owner')
  console.log('3. Configure OFT send options to include compose gas on both JUSD and sJUSD OFT adapters')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
