// scripts/generate-test-events.js
// Generate events for testing aegis-server event processing
// Includes comprehensive AegisRewardsV2 testing
//
// To enable database verification, install mongodb:
//   npm install mongodb
//
const { ethers } = require('hardhat')
const fs = require('fs')

// Try to load MongoDB (optional)
let MongoClient = null
try {
  MongoClient = require('mongodb').MongoClient
} catch (e) {
  console.log('Note: mongodb package not installed. DB verification disabled.')
  console.log('Install with: npm install mongodb\n')
}

// Configuration
const MONGODB_URI = 'mongodb://127.0.0.1:27017/aegis_local_test?authSource=admin&replicaSet=rs0&directConnection=true'
const POLL_INTERVAL_MS = 2000
const MAX_WAIT_TIME_MS = 60000

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function getProcessedBlockFromDB() {
  if (!MongoClient) return 0
  const client = new MongoClient(MONGODB_URI)
  try {
    await client.connect()
    const db = client.db('aegis_local_test')
    const stateCollection = db.collection('blockchain_state')
    const state = await stateCollection.findOne({ chain_id: 1337 })
    return state?.last_processed_block || 0
  } catch (e) {
    return 0
  } finally {
    await client.close()
  }
}

async function waitForBlock(targetBlock) {
  if (!MongoClient) {
    // No MongoDB - just wait a fixed time
    console.log('\nWaiting 10 seconds for background service to process events...')
    await sleep(10000)
    return true
  }

  const startTime = Date.now()
  console.log(`\nWaiting for block ${targetBlock} to be processed...`)

  while (Date.now() - startTime < MAX_WAIT_TIME_MS) {
    const processedBlock = await getProcessedBlockFromDB()
    if (processedBlock >= targetBlock) {
      console.log(`Block ${targetBlock} processed! (current: ${processedBlock})`)
      return true
    }
    process.stdout.write(`.`)
    await sleep(POLL_INTERVAL_MS)
  }
  console.log('\nTimeout - continuing anyway')
  return false
}

async function checkDatabaseEvents() {
  if (!MongoClient) {
    console.log('\nDatabase verification skipped (mongodb not installed)')
    console.log('Check aegis-server logs to verify events were processed')
    return
  }

  const client = new MongoClient(MONGODB_URI)
  try {
    await client.connect()
    const db = client.db('aegis_local_test')
    const txCollection = db.collection('transactions')

    const totalTx = await txCollection.countDocuments({})
    console.log(`\nTotal transactions in DB: ${totalTx}`)

    // Group by type
    const pipeline = [
      { $group: { _id: '$type', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]
    const byType = await txCollection.aggregate(pipeline).toArray()

    if (byType.length > 0) {
      console.log('Transactions by type:')
      for (const item of byType) {
        console.log(`  ${item._id}: ${item.count}`)
      }
    }

    // Recent transactions
    const recent = await txCollection.find({}).sort({ created_at: -1 }).limit(10).toArray()
    if (recent.length > 0) {
      console.log('\nRecent transactions:')
      for (const tx of recent) {
        console.log(`  [${tx.type}] block ${tx.block_number} - ${tx.tx_hash?.slice(0, 20)}...`)
      }
    }
  } catch (e) {
    console.log('Database check error:', e.message)
  } finally {
    await client.close()
  }
}

async function main() {
  const deploymentPath = 'deployment-local.json'
  if (!fs.existsSync(deploymentPath)) {
    console.error('Error: deployment-local.json not found')
    process.exit(1)
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath))
  console.log('=== Comprehensive Event & Rewards Testing ===\n')

  const [deployer, user1, user2, user3] = await ethers.getSigners()
  const startBlock = await ethers.provider.getBlockNumber()
  console.log('Starting block:', startBlock)
  console.log('Deployer:', deployer.address)
  console.log('User1:', user1.address)
  console.log('User2:', user2.address)

  // Connect to contracts
  const yusd = await ethers.getContractAt('YUSD', deployment.yusdSystem.yusd)
  const syusd = await ethers.getContractAt('sYUSD', deployment.yusdSystem.syusd)
  const jusd = await ethers.getContractAt('JUSD', deployment.jusdSystem.jusd)
  const sjusd = await ethers.getContractAt('sJUSD', deployment.jusdSystem.sjusd)
  const aegisOracle = await ethers.getContractAt('AegisOracle', deployment.yusdSystem.aegisOracle)
  const aegisOracleJUSD = await ethers.getContractAt('AegisOracleJUSD', deployment.jusdSystem.aegisOracleJUSD)
  const aegisMinting = await ethers.getContractAt('AegisMinting', deployment.yusdSystem.aegisMinting)

  let aegisRewardsV2 = null
  if (deployment.newContracts.aegisRewardsV2 !== ethers.ZeroAddress) {
    aegisRewardsV2 = await ethers.getContractAt('AegisRewardsV2', deployment.newContracts.aegisRewardsV2)
    console.log('AegisRewardsV2:', deployment.newContracts.aegisRewardsV2)
  }

  // Impersonate minter addresses (AegisMinting has YUSD minter role, AegisMintingJUSD has JUSD minter role)
  const yusdMinterAddress = deployment.yusdSystem.aegisMinting
  const jusdMinterAddress = deployment.jusdSystem.aegisMintingJUSD
  await ethers.provider.send('hardhat_impersonateAccount', [yusdMinterAddress])
  await ethers.provider.send('hardhat_impersonateAccount', [jusdMinterAddress])
  // Fund impersonated accounts with ETH for gas
  await ethers.provider.send('hardhat_setBalance', [yusdMinterAddress, ethers.toQuantity(ethers.parseEther('10'))])
  await ethers.provider.send('hardhat_setBalance', [jusdMinterAddress, ethers.toQuantity(ethers.parseEther('10'))])
  const yusdMinter = await ethers.getSigner(yusdMinterAddress)
  const jusdMinter = await ethers.getSigner(jusdMinterAddress)
  console.log('Impersonating YUSD minter:', yusdMinterAddress)
  console.log('Impersonating JUSD minter:', jusdMinterAddress)

  const events = []

  // ============================================
  // PHASE 1: Basic Token Events
  // ============================================
  console.log('\n========== PHASE 1: Token Events ==========')

  // Mint tokens to users (using impersonated minter accounts)
  let tx = await yusd.connect(yusdMinter).mint(user1.address, ethers.parseUnits('50000', 18))
  await tx.wait()
  events.push({ type: 'yusd_mint', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] YUSD Mint: 50,000 to user1`)

  tx = await yusd.connect(yusdMinter).mint(user2.address, ethers.parseUnits('30000', 18))
  await tx.wait()
  events.push({ type: 'yusd_mint', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] YUSD Mint: 30,000 to user2`)

  tx = await jusd.connect(jusdMinter).mint(user1.address, ethers.parseUnits('40000', 18))
  await tx.wait()
  events.push({ type: 'jusd_mint', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] JUSD Mint: 40,000 to user1`)

  tx = await jusd.connect(jusdMinter).mint(user2.address, ethers.parseUnits('20000', 18))
  await tx.wait()
  events.push({ type: 'jusd_mint', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] JUSD Mint: 20,000 to user2`)

  // Transfers
  tx = await yusd.connect(user1).transfer(user2.address, ethers.parseUnits('5000', 18))
  await tx.wait()
  events.push({ type: 'yusd_transfer', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] YUSD Transfer: user1 -> user2 (5,000)`)

  // ============================================
  // PHASE 2: Staking Events
  // ============================================
  console.log('\n========== PHASE 2: Staking Events ==========')

  // sYUSD staking
  await yusd.connect(user1).approve(syusd.target, ethers.parseUnits('20000', 18))
  tx = await syusd.connect(user1).deposit(ethers.parseUnits('20000', 18), user1.address)
  await tx.wait()
  events.push({ type: 'syusd_deposit', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] sYUSD Deposit: user1 staked 20,000 YUSD`)

  await yusd.connect(user2).approve(syusd.target, ethers.parseUnits('15000', 18))
  tx = await syusd.connect(user2).deposit(ethers.parseUnits('15000', 18), user2.address)
  await tx.wait()
  events.push({ type: 'syusd_deposit', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] sYUSD Deposit: user2 staked 15,000 YUSD`)

  // sJUSD staking
  await jusd.connect(user1).approve(sjusd.target, ethers.parseUnits('15000', 18))
  tx = await sjusd.connect(user1).deposit(ethers.parseUnits('15000', 18), user1.address)
  await tx.wait()
  events.push({ type: 'sjusd_deposit', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] sJUSD Deposit: user1 staked 15,000 JUSD`)

  await jusd.connect(user2).approve(sjusd.target, ethers.parseUnits('10000', 18))
  tx = await sjusd.connect(user2).deposit(ethers.parseUnits('10000', 18), user2.address)
  await tx.wait()
  events.push({ type: 'sjusd_deposit', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] sJUSD Deposit: user2 staked 10,000 JUSD`)

  // ============================================
  // PHASE 3: Cooldown Events
  // ============================================
  console.log('\n========== PHASE 3: Cooldown Events ==========')

  try {
    tx = await syusd.connect(user1).cooldownShares(ethers.parseUnits('5000', 18), user1.address)
    await tx.wait()
    events.push({ type: 'cooldown_started', block: tx.blockNumber })
    console.log(`[Block ${tx.blockNumber}] sYUSD CooldownStarted: user1 (5,000 shares)`)
  } catch (e) {
    console.log('sYUSD Cooldown skipped:', e.message.slice(0, 60))
  }

  try {
    tx = await sjusd.connect(user2).cooldownShares(ethers.parseUnits('3000', 18), user2.address)
    await tx.wait()
    events.push({ type: 'cooldown_started', block: tx.blockNumber })
    console.log(`[Block ${tx.blockNumber}] sJUSD CooldownStarted: user2 (3,000 shares)`)
  } catch (e) {
    console.log('sJUSD Cooldown skipped:', e.message.slice(0, 60))
  }

  // ============================================
  // PHASE 4: Oracle Price Updates
  // ============================================
  console.log('\n========== PHASE 4: Oracle Price Updates ==========')

  const priceUpdates = [
    { contract: aegisOracle, fn: 'updateYUSDPrice', price: '1.005', label: 'YUSD', type: 'update_yusd_price' },
    { contract: aegisOracle, fn: 'updateYUSDPrice', price: '1.01', label: 'YUSD', type: 'update_yusd_price' },
    { contract: aegisOracleJUSD, fn: 'updateJUSDPrice', price: '1.015', label: 'JUSD', type: 'update_jusd_price' },
  ]
  for (const update of priceUpdates) {
    try {
      tx = await update.contract[update.fn](ethers.parseUnits(update.price, 8))
      await tx.wait()
      events.push({ type: update.type, block: tx.blockNumber })
      console.log(`[Block ${tx.blockNumber}] ${update.label} Price Update: $${update.price}`)
    } catch (e) {
      console.log(`${update.label} Price Update ($${update.price}) skipped:`, e.shortMessage || e.message.slice(0, 80))
    }
  }

  // ============================================
  // PHASE 5: AegisRewardsV2 Testing
  // ============================================
  if (aegisRewardsV2) {
    console.log('\n========== PHASE 5: AegisRewardsV2 Events ==========')

    try {
      // Role constants
      const REWARDS_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('REWARDS_MANAGER_ROLE'))
      const DAILY_UPDATER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('DAILY_UPDATER_ROLE'))
      const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'

      // Grant roles
      const hasAdmin = await aegisRewardsV2.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)
      if (hasAdmin) {
        await aegisRewardsV2.grantRole(REWARDS_MANAGER_ROLE, deployer.address)
        await aegisRewardsV2.grantRole(DAILY_UPDATER_ROLE, deployer.address)
        console.log('Granted REWARDS_MANAGER_ROLE and DAILY_UPDATER_ROLE to deployer')

        // Set staking contract
        const currentStaking = await aegisRewardsV2.stakingContract()
        if (currentStaking === ethers.ZeroAddress) {
          tx = await aegisRewardsV2.setStakingContract(syusd.target)
          await tx.wait()
          console.log(`[Block ${tx.blockNumber}] Set staking contract to sYUSD`)
        }

        // Set aegisMinting to allow deposits (IMPORTANT for depositRewards)
        tx = await aegisRewardsV2.setAegisMintingAddress(deployer.address) // Temporarily set deployer
        await tx.wait()
        console.log(`[Block ${tx.blockNumber}] Set aegisMinting to deployer (for testing)`)

        // Create snapshot ID (weekly format)
        const now = Math.floor(Date.now() / 1000)
        const weekStart = now - (now % (7 * 24 * 60 * 60))
        const snapshotIdString = `week-${weekStart}`
        const snapshotId = ethers.encodeBytes32String(snapshotIdString)
        console.log(`Snapshot ID: ${snapshotIdString}`)

        // Mint YUSD rewards and transfer to AegisRewardsV2
        const rewardAmount = ethers.parseUnits('10000', 18) // 10,000 YUSD rewards
        await yusd.connect(yusdMinter).mint(deployer.address, rewardAmount)
        await yusd.approve(aegisRewardsV2.target, rewardAmount)
        await yusd.transfer(aegisRewardsV2.target, rewardAmount)
        console.log('Transferred 10,000 YUSD to AegisRewardsV2')

        // Deposit rewards (as deployer who is now set as aegisMinting)
        const requestIdEncoded = ethers.AbiCoder.defaultAbiCoder().encode(['string'], [snapshotIdString])
        tx = await aegisRewardsV2.depositRewards(requestIdEncoded, rewardAmount)
        await tx.wait()
        events.push({ type: 'deposit_rewards', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] DepositRewards: 10,000 YUSD`)

        // Update daily rewards
        const stakingBalance = await syusd.totalAssets() // Total YUSD in sYUSD
        const totalEligible = stakingBalance + ethers.parseUnits('50000', 18) // staking + estimated user holdings
        tx = await aegisRewardsV2.updateDailyRewards(snapshotId, stakingBalance, totalEligible)
        await tx.wait()
        events.push({ type: 'daily_rewards_update', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] DailyRewardsUpdate`)

        // Set user rewards
        const rewardUsers = [user1.address, user2.address]
        const rewardAmounts = [
          ethers.parseUnits('2000', 18), // 2,000 YUSD for user1
          ethers.parseUnits('1500', 18)  // 1,500 YUSD for user2
        ]
        tx = await aegisRewardsV2.setUserRewards(snapshotId, rewardUsers, rewardAmounts)
        await tx.wait()
        events.push({ type: 'set_user_rewards', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] SetUserRewards: user1=2000, user2=1500`)

        // Send staking rewards to sYUSD
        const stakingRewardAmount = ethers.parseUnits('3000', 18) // 3,000 YUSD to staking
        tx = await aegisRewardsV2.sendToStaking(snapshotId, stakingRewardAmount)
        await tx.wait()
        events.push({ type: 'send_to_staking', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] SendToStaking: 3,000 YUSD to sYUSD`)

        // Check new sYUSD share price after rewards
        const newSharePrice = await syusd.convertToAssets(ethers.parseUnits('1', 18))
        console.log(`sYUSD share price after rewards: ${ethers.formatUnits(newSharePrice, 18)} YUSD`)

        // Finalize rewards
        const claimDuration = 30 * 24 * 60 * 60 // 30 days to claim
        tx = await aegisRewardsV2.finalizeRewards(snapshotId, claimDuration)
        await tx.wait()
        events.push({ type: 'finalize_rewards', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] FinalizeRewards: snapshot finalized`)

        // User1 claims on-chain rewards
        tx = await aegisRewardsV2.connect(user1).claimOnChainRewards(snapshotId)
        await tx.wait()
        events.push({ type: 'claim_rewards', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] ClaimOnChainRewards: user1 claimed rewards`)

        // Check user1 balance increased
        const user1Balance = await yusd.balanceOf(user1.address)
        console.log(`User1 YUSD balance after claim: ${ethers.formatUnits(user1Balance, 18)}`)

        // User2 claims
        tx = await aegisRewardsV2.connect(user2).claimOnChainRewards(snapshotId)
        await tx.wait()
        events.push({ type: 'claim_rewards', block: tx.blockNumber })
        console.log(`[Block ${tx.blockNumber}] ClaimOnChainRewards: user2 claimed rewards`)

        // Reset aegisMinting to actual contract
        await aegisRewardsV2.setAegisMintingAddress(aegisMinting.target)
        console.log('Reset aegisMinting to actual contract')

      } else {
        console.log('Deployer does not have admin role on AegisRewardsV2')
      }
    } catch (e) {
      console.log('AegisRewardsV2 testing error:', e.message)
    }
  }

  // ============================================
  // PHASE 6: Additional Yield Distribution
  // ============================================
  console.log('\n========== PHASE 6: Yield Distribution ==========')

  // Add more YUSD yield to sYUSD
  const yusdYield = ethers.parseUnits('1000', 18)
  await yusd.connect(yusdMinter).mint(deployer.address, yusdYield)
  tx = await yusd.transfer(syusd.target, yusdYield)
  await tx.wait()
  events.push({ type: 'yield_distribution', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] YUSD Yield to sYUSD: 1,000 YUSD`)

  // Add JUSD yield to sJUSD
  const jusdYield = ethers.parseUnits('800', 18)
  await jusd.connect(jusdMinter).mint(deployer.address, jusdYield)
  tx = await jusd.transfer(sjusd.target, jusdYield)
  await tx.wait()
  events.push({ type: 'yield_distribution', block: tx.blockNumber })
  console.log(`[Block ${tx.blockNumber}] JUSD Yield to sJUSD: 800 JUSD`)

  // ============================================
  // Wait and Verify
  // ============================================
  const endBlock = await ethers.provider.getBlockNumber()
  console.log('\n========== EVENT SUMMARY ==========')
  console.log(`Block range: ${startBlock} -> ${endBlock}`)
  console.log(`Total events generated: ${events.length}`)

  // Wait for processing
  await waitForBlock(endBlock)

  // Check database
  await checkDatabaseEvents()

  // ============================================
  // Final State
  // ============================================
  console.log('\n========== FINAL STATE ==========')
  console.log('YUSD total supply:', ethers.formatUnits(await yusd.totalSupply(), 18))
  console.log('JUSD total supply:', ethers.formatUnits(await jusd.totalSupply(), 18))
  console.log('sYUSD total assets:', ethers.formatUnits(await syusd.totalAssets(), 18))
  console.log('sJUSD total assets:', ethers.formatUnits(await sjusd.totalAssets(), 18))

  const syusdPrice = await syusd.convertToAssets(ethers.parseUnits('1', 18))
  const sjusdPrice = await sjusd.convertToAssets(ethers.parseUnits('1', 18))
  console.log('sYUSD share price:', ethers.formatUnits(syusdPrice, 18), 'YUSD per share')
  console.log('sJUSD share price:', ethers.formatUnits(sjusdPrice, 18), 'JUSD per share')

  if (aegisRewardsV2) {
    const totalReserved = await aegisRewardsV2.totalReservedRewards()
    console.log('AegisRewardsV2 reserved:', ethers.formatUnits(totalReserved, 18), 'YUSD')
  }

  console.log('\nUser balances:')
  console.log('  User1 YUSD:', ethers.formatUnits(await yusd.balanceOf(user1.address), 18))
  console.log('  User1 sYUSD:', ethers.formatUnits(await syusd.balanceOf(user1.address), 18))
  console.log('  User2 YUSD:', ethers.formatUnits(await yusd.balanceOf(user2.address), 18))
  console.log('  User2 sYUSD:', ethers.formatUnits(await syusd.balanceOf(user2.address), 18))

  console.log('\n========== TESTING COMPLETE ==========')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
