const { ethers, network } = require('hardhat')
const { getNetworksConfig } = require('../utils/helpers')

function getNetworkConfig(networkName) {
  const networksConfig = getNetworksConfig()
  if (!networksConfig) return null
  return networksConfig.networks[networkName]
}

async function main() {
  const cfg = getNetworkConfig(network.name)
  if (!cfg) throw new Error(`Network configuration not found for ${network.name}`)

  const yusdAddress = cfg.contracts.yusdAddress || cfg.contracts.yusdOftAddress
  const rewardsManualAddress = cfg.contracts.aegisRewardsManualAddress

  if (!yusdAddress) throw new Error(`yusdAddress is missing in config for ${network.name}`)
  if (!rewardsManualAddress) throw new Error(`aegisRewardsManualAddress is missing in config for ${network.name}`)

  // Validate input parameters
  const amountStr = process.env.AMOUNT || process.env.TRANSFER_AMOUNT

  if (!amountStr || amountStr.trim() === '') {
    throw new Error('AMOUNT environment variable is required and cannot be empty (e.g. AMOUNT=10.5)')
  }

  // Validate amount is a valid number
  let amount
  try {
    amount = ethers.parseEther(amountStr)
    if (amount <= 0) {
      throw new Error('AMOUNT must be greater than 0')
    }
  } catch (error) {
    throw new Error(`Invalid AMOUNT format: ${amountStr}. Must be a valid number (e.g. 10.5)`)
  }

  const [signer] = await ethers.getSigners()
  const yusd = await ethers.getContractAt('IERC20', yusdAddress)

  // Check sender's YUSD balance
  const balance = await yusd.balanceOf(signer.address)
  if (balance < amount) {
    throw new Error(
      `Insufficient YUSD balance. Required: ${ethers.formatEther(amount)}, Available: ${ethers.formatEther(balance)}`,
    )
  }

  console.log(`💰 Transferring YUSD to AegisRewardsManual on ${network.name}...`)
  console.log(`From: ${signer.address}`)
  console.log(`To (AegisRewardsManual): ${rewardsManualAddress}`)
  console.log(`Amount: ${amountStr} YUSD`)

  // Set gas price if configured
  const overrides = {}
  if (cfg.gasPrice) {
    try {
      overrides.gasPrice = BigInt(cfg.gasPrice)
    } catch (_) {
      // Ignore invalid gas price
    }
  }

  // Execute transfer
  console.log('\nExecuting transfer...')
  const tx = await yusd.transfer(rewardsManualAddress, amount, overrides)
  console.log(`Transaction hash: ${tx.hash}`)

  console.log('Waiting for confirmation...')
  const receipt = await tx.wait()
  console.log(`✅ Transfer completed successfully in block ${receipt.blockNumber}`)

  // Verify final balance
  const finalBalance = await yusd.balanceOf(signer.address)
  console.log(`Final balance: ${ethers.formatEther(finalBalance)} YUSD`)
}

main().catch((e) => {
  console.error(e.message || e)
  process.exitCode = 1
})
