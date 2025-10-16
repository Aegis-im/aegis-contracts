const { ethers, network } = require('hardhat')
const networks = require('../config/networks.json')

function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

async function main() {
  const networkName = network.name
  const networkConfig = getNetworkByName(networkName)

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in config`)
  }

  const [deployer] = await ethers.getSigners()
  console.log(`Adding supported asset on ${networkName}`)
  console.log(`Caller: ${deployer.address}\n`)

  const assetAddress = process.env.ASSET_ADDRESS || networkConfig.contracts.usdtAddress
  const heartbeat = process.env.HEARTBEAT || '86400'
  const contractType = process.env.CONTRACT_TYPE || 'both'

  if (!assetAddress) {
    console.log(
      'Usage: ASSET_ADDRESS=<address> HEARTBEAT=<seconds> CONTRACT_TYPE=<yusd|jusd|both> npx hardhat run scripts/add-supported-asset.js --network <network>',
    )
    console.log('\nParameters:')
    console.log('- ASSET_ADDRESS: Token address (defaults to usdtAddress from config)')
    console.log('- HEARTBEAT: Chainlink feed heartbeat in seconds (default: 86400 = 24h)')
    console.log('- CONTRACT_TYPE: yusd, jusd, or both (default: both)')
    return
  }

  if (!ethers.isAddress(assetAddress)) {
    throw new Error(`Invalid asset address: ${assetAddress}`)
  }

  const asset = await ethers.getContractAt('IERC20Metadata', assetAddress)
  const symbol = await asset.symbol()
  const decimals = await asset.decimals()

  console.log(`Asset: ${symbol}`)
  console.log(`Address: ${assetAddress}`)
  console.log(`Decimals: ${decimals}`)
  console.log(`Heartbeat: ${heartbeat}s\n`)

  // Add to AegisMinting (YUSD)
  if ((contractType === 'yusd' || contractType === 'both') && networkConfig.contracts.aegisMintingAddress) {
    console.log('Adding to AegisMinting (YUSD)...')
    const aegisMinting = await ethers.getContractAt('AegisMinting', networkConfig.contracts.aegisMintingAddress)

    const isSupported = await aegisMinting.isSupportedAsset(assetAddress)
    if (isSupported) {
      console.log('⚠️  Asset already supported in AegisMinting')
    } else {
      const tx = await aegisMinting.addSupportedAsset(assetAddress, heartbeat)
      await tx.wait()
      console.log(`✅ Added to AegisMinting`)
      console.log(`   Tx: ${tx.hash}`)
    }
  }

  // Add to AegisMintingJUSD
  if ((contractType === 'jusd' || contractType === 'both') && networkConfig.contracts.aegisMintingJUSDAddress) {
    console.log('\nAdding to AegisMintingJUSD...')
    const aegisMintingJUSD = await ethers.getContractAt(
      'AegisMintingJUSD',
      networkConfig.contracts.aegisMintingJUSDAddress,
    )

    const isSupported = await aegisMintingJUSD.isSupportedAsset(assetAddress)
    if (isSupported) {
      console.log('⚠️  Asset already supported in AegisMintingJUSD')
    } else {
      const tx = await aegisMintingJUSD.addSupportedAsset(assetAddress, heartbeat)
      await tx.wait()
      console.log(`✅ Added to AegisMintingJUSD`)
      console.log(`   Tx: ${tx.hash}`)
    }
  }

  console.log('\n✅ Done')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
