const { ethers, network } = require('hardhat')
const networks = require('../config/networks.json')

function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

function stringToBytes32(str) {
  const bytes = ethers.toUtf8Bytes(str)
  if (bytes.length === 0) {
    return '0x0000000000000000000000000000000000000000000000000000000000000000'
  }

  const padded = new Uint8Array(32)
  padded.set(bytes.slice(0, 32))

  return ethers.hexlify(padded)
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
  const rewardsContract = await ethers.getContractAt(
    'AegisRewardsManual',
    networkConfig.contracts.aegisRewardsManualAddress,
  )

  console.log(`🎯 Finalizing reward on ${networkName}`)
  console.log(`📄 Contract address: ${await rewardsContract.getAddress()}`)
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

  // Convert string to bytes32
  const rewardIdBytes32 = stringToBytes32(rewardId)

  console.log('\n📋 Finalization parameters:')
  console.log(`   - Reward ID: ${rewardId}`)
  console.log(`   - Reward ID (bytes32): ${rewardIdBytes32}`)
  console.log(`   - Claim duration: ${claimDuration} seconds (${claimDuration / (24 * 60 * 60)} days)`)

  try {
    // Check role
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
      `   - Expiry time: ${rewardInfo.expiry === 0n ? 'Not set' : new Date(Number(rewardInfo.expiry) * 1000).toISOString()}`,
    )
    console.log(`   - Finalized: ${rewardInfo.finalized}`)

    if (rewardInfo.finalized) {
      console.log('⚠️ Reward is already finalized!')
      return
    }

    if (rewardInfo.amount === 0n) {
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

    // Check new reward state
    const newRewardInfo = await rewardsContract.rewardById(rewardId)
    console.log('\n✨ New reward state:')
    console.log(`   - Amount: ${ethers.formatEther(newRewardInfo.amount)} YUSD`)
    console.log(
      `   - Expiry time: ${newRewardInfo.expiry === 0n ? 'Not set' : new Date(Number(newRewardInfo.expiry) * 1000).toISOString()}`,
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
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
