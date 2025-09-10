const { ethers, network } = require('hardhat')
const networks = require('../config/networks.json')

// Get network info by name
function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

async function main() {
  const networkName = network.name
  const networkConfig = getNetworkByName(networkName)

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in config`)
  }

  if (!networkConfig.contracts.aegisRewardsManualAddress) {
    throw new Error(`aegisRewardsManualAddress not found in network config for ${networkName}`)
  }

  const [deployer] = await ethers.getSigners()
  console.log(`💰 Depositing rewards to AegisRewardsManual on ${networkName}...`)
  console.log('Using account:', deployer.address)

  const contractAddress = networkConfig.contracts.aegisRewardsManualAddress
  console.log('AegisRewardsManual address:', contractAddress)

  // Get contract instance
  const aegisRewardsManual = await ethers.getContractAt('AegisRewardsManual', contractAddress)

  // Validate input parameters
  const requestId = process.env.REQUEST_ID
  const amountStr = process.env.AMOUNT

  if (!requestId || requestId.trim() === '') {
    throw new Error('REQUEST_ID environment variable is required and cannot be empty')
  }

  if (!amountStr || amountStr.trim() === '') {
    throw new Error('AMOUNT environment variable is required and cannot be empty')
  }

  // Validate amount is a valid number
  const amount = ethers.parseEther(amountStr)
  if (amount <= 0) {
    throw new Error('AMOUNT must be greater than 0')
  }

  console.log('\nDepositing rewards:')
  console.log(`Request ID: ${requestId}`)
  console.log(`Amount: ${ethers.formatEther(amount)} YUSD`)

  // Encode requestId as bytes
  const encodedRequestId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], [requestId])

  // Check REWARDS_MANAGER_ROLE
  const REWARDS_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('REWARDS_MANAGER_ROLE'))
  const hasRole = await aegisRewardsManual.hasRole(REWARDS_MANAGER_ROLE, deployer.address)
  console.log(`Has REWARDS_MANAGER_ROLE: ${hasRole}`)

  if (!hasRole) {
    throw new Error('Account does not have REWARDS_MANAGER_ROLE')
  }

  // Check available balance before deposit
  const availableBalance = await aegisRewardsManual.availableBalanceForDeposits()
  console.log(`Available balance: ${ethers.formatEther(availableBalance)} YUSD`)

  if (availableBalance < amount) {
    throw new Error('Insufficient contract balance for this deposit')
  }

  // Call depositRewards
  console.log('\nCalling depositRewards...')
  const tx = await aegisRewardsManual.depositRewards(encodedRequestId, amount)

  console.log('Transaction hash:', tx.hash)
  console.log('Waiting for confirmation...')

  const receipt = await tx.wait()
  console.log(`✅ Rewards deposited successfully in block ${receipt.blockNumber}`)

  // Check reward info
  const reward = await aegisRewardsManual.rewardById(requestId)
  console.log('\nReward info:')
  console.log(`Amount: ${ethers.formatEther(reward.amount)} YUSD`)
  console.log(`Finalized: ${reward.finalized}`)
  console.log(`Expiry: ${reward.expiry.toString()}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
