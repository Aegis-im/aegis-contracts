// scripts/update-syusd-oracle.js
const { ethers } = require('hardhat')
const fs = require('fs')
const path = require('path')

// Load network configuration
const configPath = path.join(__dirname, '../config/networks.json')
const networksConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))

/**
 * Script to fetch sYUSD/YUSD exchange rate from mainnet and post it to sYUSD oracles on Avalanche and Katana
 *
 * The script fetches the sYUSD to YUSD conversion rate using ERC4626 convertToAssets() function
 * and posts this ratio (scaled to 8 decimals) to oracle contracts on target networks.
 *
 * Usage:
 * npx hardhat run scripts/update-syusd-oracle.js --network mainnet
 *
 * Environment Variables:
 * - PRIVATE_KEY: Private key of the oracle operator account
 * - DRY_RUN: Set to 'true' to simulate without sending transactions
 * - TARGET_NETWORKS: Comma-separated list of networks to update (default: avalanche,katana)
 */

async function main() {
  // Validate environment variables
  if (!process.env.PRIVATE_KEY && process.env.DRY_RUN !== 'true') {
    throw new Error('PRIVATE_KEY environment variable is required for live updates')
  }

  const isDryRun = process.env.DRY_RUN === 'true'
  const targetNetworks = (process.env.TARGET_NETWORKS || 'avalanche,katana').split(',').map(n => n.trim())

  console.log('🚀 Starting sYUSD Oracle Update Script')
  console.log(`📊 Mode: ${isDryRun ? 'DRY RUN' : 'LIVE'}`)
  console.log(`🎯 Target networks: ${targetNetworks.join(', ')}`)
  console.log('=' .repeat(60))

  // Validate target networks exist in configuration
  for (const network of targetNetworks) {
    if (!networksConfig.networks[network]) {
      throw new Error(`Network '${network}' not found in configuration. Available networks: ${Object.keys(networksConfig.networks).join(', ')}`)
    }
  }

  // Step 1: Get sYUSD/YUSD exchange rate from mainnet
  const exchangeRate = await fetchSYUSDExchangeRateFromMainnet()

  if (!exchangeRate) {
    console.error('❌ Failed to fetch sYUSD exchange rate from mainnet')
    process.exit(1)
  }

  console.log(`💰 sYUSD/YUSD Exchange Rate: ${exchangeRate.toFixed(8)}`)

  // Convert to 8 decimal format for oracle (multiply by 1e8)
  const rateWith8Decimals = Math.floor(exchangeRate * 1e8)
  console.log(`🔢 Rate (8 decimals): ${rateWith8Decimals}`)

  if (isDryRun) {
    console.log('\n🔍 DRY RUN: Would update oracles with exchange rate:', rateWith8Decimals)
    console.log('Set DRY_RUN=false to execute actual transactions')
    return
  }

  // Step 2: Update oracles on target networks
  const results = []
  for (const network of targetNetworks) {
    try {
      const result = await updateOracleOnNetwork(network, rateWith8Decimals)
      results.push({ network, success: true, txHash: result.txHash })
    } catch (error) {
      console.error(`❌ Failed to update oracle on ${network}:`, error.message)
      results.push({ network, success: false, error: error.message })
    }
  }

  // Step 3: Summary
  console.log('\n📋 Update Summary:')
  console.log('=' .repeat(60))
  results.forEach(result => {
    if (result.success) {
      console.log(`✅ ${result.network}: Success (tx: ${result.txHash})`)
    } else {
      console.log(`❌ ${result.network}: Failed - ${result.error}`)
    }
  })

  const successCount = results.filter(r => r.success).length
  console.log(`\n🎉 Successfully updated ${successCount}/${results.length} oracles`)
}

/**
 * Fetches sYUSD/YUSD exchange rate from mainnet
 * @returns {Promise<number>} sYUSD to YUSD exchange rate
 */
async function fetchSYUSDExchangeRateFromMainnet() {
  try {
    console.log('\n📡 Fetching sYUSD/YUSD exchange rate from mainnet...')

    // Connect to mainnet
    const mainnetProvider = new ethers.JsonRpcProvider(networksConfig.networks.mainnet.rpcUrl)

    // Get contract addresses
    const mainnetConfig = networksConfig.networks.mainnet.contracts
    const syusdAddress = mainnetConfig.syusdAddress

    if (!syusdAddress) {
      throw new Error('Missing sYUSD address in mainnet config')
    }

    // Create sYUSD contract instance
    const sYUSD = new ethers.Contract(
      syusdAddress,
      [
        'function convertToAssets(uint256 shares) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
      ],
      mainnetProvider,
    )

    // Get sYUSD to YUSD exchange rate
    // convertToAssets(1e18) returns how much YUSD you get for 1 sYUSD
    const oneToken = ethers.parseEther('1') // 1e18
    const yusdPerSYUSD = await sYUSD.convertToAssets(oneToken)

    // Convert to float for easier handling
    const exchangeRate = Number(ethers.formatEther(yusdPerSYUSD))

    console.log(`📊 1 sYUSD = ${exchangeRate.toFixed(8)} YUSD`)
    console.log(`💰 Exchange rate: ${exchangeRate}`)

    return exchangeRate

  } catch (error) {
    console.error('❌ Error fetching sYUSD exchange rate from mainnet:', error)
    return null
  }
}

/**
 * Updates oracle on a specific network
 * @param {string} networkName - Network name (avalanche, katana)
 * @param {number} rateWith8Decimals - Exchange rate with 8 decimal places
 * @returns {Promise<object>} Transaction result
 */
async function updateOracleOnNetwork(networkName, rateWith8Decimals) {
  console.log(`\n🔄 Updating oracle on ${networkName}...`)

  // Get network configuration
  const networkConfig = networksConfig.networks[networkName]
  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in configuration`)
  }

  const syusdOracleAddress = networkConfig.contracts.syusdOracle
  if (!syusdOracleAddress) {
    throw new Error(`sYUSD oracle address not configured for ${networkName}. Please run deploy-syusd-oracle.js first.`)
  }

  // Connect to the network
  const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl)
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider)

  console.log(`👤 Using operator account: ${wallet.address}`)

  // Create oracle contract instance
  const oracle = new ethers.Contract(
    syusdOracleAddress,
    [
      'function updateYUSDPrice(int256 price) external',
      'function yusdUSDPrice() external view returns (int256)',
      'function lastUpdateTimestamp() external view returns (uint32)',
    ],
    wallet,
  )

  // Get current price for comparison
  try {
    const currentPrice = await oracle.yusdUSDPrice()
    const lastUpdate = await oracle.lastUpdateTimestamp()
    const lastUpdateDate = new Date(Number(lastUpdate) * 1000)

    console.log(`📊 Current oracle price: ${Number(currentPrice)} (8 decimals)`)
    console.log(`⏰ Last update: ${lastUpdateDate.toISOString()}`)
  } catch (error) {
    console.log('ℹ️  Could not fetch current oracle state (may be first update)')
  }

  // Update the exchange rate
  console.log(`🔄 Updating exchange rate to: ${rateWith8Decimals}`)

  // Estimate gas first
  let gasEstimate
  try {
    gasEstimate = await oracle.updateYUSDPrice.estimateGas(rateWith8Decimals)
    console.log(`⛽ Estimated gas: ${gasEstimate.toString()}`)
  } catch (error) {
    console.warn('⚠️  Could not estimate gas, using default')
  }

  const txOptions = {
    gasPrice: networkConfig.gasPrice,
  }

  // Add gas limit with 20% buffer if we have an estimate
  if (gasEstimate) {
    txOptions.gasLimit = (gasEstimate * 120n) / 100n
  }

  const tx = await oracle.updateYUSDPrice(rateWith8Decimals, txOptions)

  console.log(`📤 Transaction sent: ${tx.hash}`)
  console.log('⏳ Waiting for confirmation (timeout: 300s)...')

  // Wait for transaction with timeout
  const receipt = await Promise.race([
    tx.wait(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Transaction confirmation timeout')), 300000),
    ),
  ])

  if (receipt.status === 1) {
    console.log(`✅ Transaction confirmed on ${networkName}`)
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`)
    return { txHash: tx.hash, gasUsed: receipt.gasUsed.toString() }
  } else {
    throw new Error('Transaction failed')
  }
}

// Handle script execution
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('💥 Script failed:', error)
      process.exit(1)
    })
}

module.exports = {
  fetchSYUSDExchangeRateFromMainnet,
  updateOracleOnNetwork,
}
