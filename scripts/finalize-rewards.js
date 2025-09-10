const { ethers, network } = require('hardhat')
const networks = require('../config/networks.json')

// Get network info by name
function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

// Convert string to bytes32 (same as _stringToBytes32 in contract)
function stringToBytes32(str) {
  // Pad string to 32 bytes and take first 32 bytes
  const padded = str.padEnd(32, '\0')
  return ethers.hexlify(ethers.toUtf8Bytes(padded).slice(0, 32))
}

async function main() {
  const networkName = network.name
  const networkConfig = getNetworkByName(networkName)

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in config`)
  }

  if (!networkConfig.contracts.aegisRewardsAddress) {
    throw new Error(`aegisRewardsAddress not found in network config for ${networkName}`)
  }

  const [deployer] = await ethers.getSigners()
  const rewardsContract = await ethers.getContractAt('AegisRewards', networkConfig.contracts.aegisRewardsAddress)

  console.log(`🎯 Finalizing reward on ${networkName}`)
  console.log(`📄 AegisRewards contract address: ${await rewardsContract.getAddress()}`)
  console.log(`👤 Sender: ${deployer.address}`)

  // Validate input parameters
  const rewardId = process.env.REWARD_ID
  const claimDurationStr = process.env.CLAIM_DURATION

  if (!rewardId || rewardId.trim() === '') {
    throw new Error('REWARD_ID environment variable is required and cannot be empty')
  }

  if (!claimDurationStr || claimDurationStr.trim() === '') {
    throw new Error('CLAIM_DURATION environment variable is required and cannot be empty')
  }

  // Validate claim duration is a valid number (can be 0)
  const claimDuration = parseInt(claimDurationStr, 10)
  if (isNaN(claimDuration) || claimDuration < 0) {
    throw new Error('CLAIM_DURATION must be a valid non-negative number')
  }

  // Convert string to bytes32 (same as in contract)
  const rewardIdBytes32 = stringToBytes32(rewardId)

  console.log('\n📋 Finalization parameters:')
  console.log(`   - Reward ID: ${rewardId}`)
  console.log(`   - Reward ID (bytes32): ${rewardIdBytes32}`)
  console.log(`   - Claim duration: ${claimDuration} seconds (${claimDuration / (24 * 60 * 60)} days)`)

  try {
    // Check if sender has REWARDS_MANAGER_ROLE
    const REWARDS_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('REWARDS_MANAGER_ROLE'))
    const hasRewardsManagerRole = await rewardsContract.hasRole(REWARDS_MANAGER_ROLE, deployer.address)

    console.log(`🔐 Sender has REWARDS_MANAGER_ROLE: ${hasRewardsManagerRole}`)

    if (!hasRewardsManagerRole) {
      throw new Error('Only users with REWARDS_MANAGER_ROLE can finalize rewards')
    }

    // Check current reward state
    const rewardInfo = await rewardsContract.rewardById(rewardId)
    console.log('\n🔍 Current reward state:')
    console.log(`   - Amount: ${ethers.formatEther(rewardInfo.amount)} YUSD`)
    console.log(
      `   - Expiry time: ${rewardInfo.expiry === 0 ? 'Not set' : new Date(Number(rewardInfo.expiry) * 1000).toISOString()}`,
    )
    console.log(`   - Finalized: ${rewardInfo.finalized}`)

    if (rewardInfo.finalized) {
      console.log('⚠️ Reward is already finalized!')
      return
    }

    if (rewardInfo.amount === 0) {
      console.log('⚠️ Reward amount is 0!')
      return
    }

    console.log('\n✅ Finalizing reward...')

    // Call finalizeRewards
    const tx = await rewardsContract.finalizeRewards(rewardIdBytes32, claimDuration)
    console.log(`📝 Transaction sent: ${tx.hash}`)

    // Wait for confirmation
    const receipt = await tx.wait()
    console.log(`✅ Transaction confirmed in block: ${receipt.blockNumber}`)
    console.log(`⛽ Gas used: ${receipt.gasUsed.toString()}`)

    // Check FinalizeRewards event
    const finalizeRewardsEvent = receipt.logs.find((log) => {
      try {
        const parsed = rewardsContract.interface.parseLog(log)
        return parsed.name === 'FinalizeRewards'
      } catch (e) {
        return false
      }
    })

    if (finalizeRewardsEvent) {
      const parsed = rewardsContract.interface.parseLog(finalizeRewardsEvent)
      console.log('📢 FinalizeRewards event:')
      console.log(`   - Reward ID: ${parsed.args.id}`)
      console.log(
        `   - Expiry time: ${parsed.args.expiry === 0 ? 'Not set' : new Date(Number(parsed.args.expiry) * 1000).toISOString()}`,
      )
    }

    // Check new reward state
    const newRewardInfo = await rewardsContract.rewardById(rewardId)
    console.log('\n✨ New reward state:')
    console.log(`   - Amount: ${ethers.formatEther(newRewardInfo.amount)} YUSD`)
    console.log(
      `   - Expiry time: ${newRewardInfo.expiry === 0 ? 'Not set' : new Date(Number(newRewardInfo.expiry) * 1000).toISOString()}`,
    )
    console.log(`   - Finalized: ${newRewardInfo.finalized}`)

    console.log('\n🎉 Reward successfully finalized!')
    console.log('💡 Users can now claim the reward through claimRewards()')

    if (claimDuration > 0) {
      const expiryDate = new Date(Number(newRewardInfo.expiry) * 1000)
      console.log(`⏰ Reward will be available until: ${expiryDate.toISOString()}`)
    }
  } catch (error) {
    console.error(`❌ Error: ${error.message}`)

    if (error.message.includes('AccessControlUnauthorizedAccount')) {
      console.log('⚠️ Sender does not have REWARDS_MANAGER_ROLE')
      console.log('💡 Need to grant REWARDS_MANAGER_ROLE to this address')
    } else if (error.message.includes('UnknownRewards')) {
      console.log('⚠️ Reward is already finalized or does not exist')
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
