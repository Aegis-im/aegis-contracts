// scripts/initialize-sYUSD-v2.js
// Use this script to initialize V2 functionality after upgrade
const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Initializing sYUSD V2 with account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get proxy address from environment
  const proxyAddress = process.env.PROXY_ADDRESS
  if (!proxyAddress) {
    throw new Error('Please provide PROXY_ADDRESS environment variable')
  }

  // Get initialization parameters
  const instantUnstakingFee = process.env.INSTANT_UNSTAKING_FEE || '50' // 0.5% default
  const insuranceFund = process.env.INSURANCE_FUND
  if (!insuranceFund) {
    throw new Error('Please provide INSURANCE_FUND environment variable')
  }

  console.log('sYUSD Proxy Address:', proxyAddress)
  console.log('Instant Unstaking Fee:', instantUnstakingFee, 'bps (', (parseInt(instantUnstakingFee) / 100).toFixed(2), '%)')
  console.log('Insurance Fund:', insuranceFund)

  // Connect to the contract
  const sYUSDContract = await ethers.getContractAt('sYUSD', proxyAddress)

  // Check current state
  console.log('\n📊 Current State:')
  try {
    const currentFee = await sYUSDContract.INSTANT_UNSTAKING_FEE()
    const currentInsuranceFund = await sYUSDContract.INSURANCE_FUND()
    const cooldownDuration = await sYUSDContract.cooldownDuration()

    console.log('   Current Fee:', currentFee.toString(), 'bps')
    console.log('   Current Insurance Fund:', currentInsuranceFund)
    console.log('   Cooldown Duration:', cooldownDuration.toString(), 'seconds')

    if (currentFee > 0 || currentInsuranceFund !== ethers.ZeroAddress) {
      console.log('\n⚠️  V2 already initialized!')
      console.log('   If you want to update values, use the setter functions:')
      console.log('   - setInstantUnstakingFee(newFee)')
      console.log('   - setInsuranceFund(newAddress)')
      return
    }
  } catch (error) {
    console.error('❌ Error checking current state:', error.message)
    console.log('   The contract might not be upgraded yet')
    return
  }

  // Validate parameters
  const feeNumber = parseInt(instantUnstakingFee)
  if (feeNumber > 10000) {
    throw new Error('Instant unstaking fee cannot exceed 10000 bps (100%)')
  }

  if (!ethers.isAddress(insuranceFund)) {
    throw new Error('Invalid insurance fund address')
  }

  // Check if deployer has admin role
  console.log('\n🔐 Checking permissions...')
  try {
    const ADMIN_ROLE = await sYUSDContract.ADMIN_ROLE()
    const hasAdminRole = await sYUSDContract.hasRole(ADMIN_ROLE, deployer.address)

    if (!hasAdminRole) {
      console.error('❌ Deployer does not have ADMIN_ROLE')
      console.log('   Current deployer:', deployer.address)
      console.log('   Required role:', ADMIN_ROLE)
      console.log('   Please use an account with admin privileges')
      return
    }

    console.log('✅ Deployer has admin privileges')
  } catch (error) {
    console.error('❌ Error checking admin role:', error.message)
    return
  }

  // Initialize V2
  console.log('\n🚀 Initializing V2 functionality...')
  try {
    const initTx = await sYUSDContract.initializeV2(
      feeNumber,
      insuranceFund,
    )

    console.log('Transaction hash:', initTx.hash)
    console.log('Waiting for confirmation...')

    const receipt = await initTx.wait()
    console.log('✅ Transaction confirmed! Block:', receipt.blockNumber)

    // Verify initialization
    console.log('\n📊 Verification:')
    const finalFee = await sYUSDContract.INSTANT_UNSTAKING_FEE()
    const finalInsuranceFund = await sYUSDContract.INSURANCE_FUND()

    console.log('   Instant Unstaking Fee:', finalFee.toString(), 'bps')
    console.log('   Insurance Fund:', finalInsuranceFund)
    console.log('   ✅ V2 initialization completed successfully!')

    // Check if instant unstaking is available
    const cooldownDuration = await sYUSDContract.cooldownDuration()
    if (cooldownDuration > 0) {
      console.log('\n🎉 Instant unstaking is now available!')
      console.log('   Users can withdraw immediately with', (feeNumber / 100).toFixed(2), '% fee')
      console.log('   Or use traditional cooldown process (no fee)')
    } else {
      console.log('\n💡 Cooldown is disabled - direct withdrawals available (no fee)')
      console.log('   To enable instant unstaking with fees, set cooldown duration > 0')
    }

  } catch (error) {
    console.error('❌ Initialization failed:', error.message)

    if (error.message.includes('Already initialized')) {
      console.log('   V2 was already initialized by another transaction')
    } else if (error.message.includes('InvalidFee')) {
      console.log('   Fee exceeds maximum allowed (10000 bps)')
    } else if (error.message.includes('ZeroAddress')) {
      console.log('   Insurance fund address cannot be zero')
    } else {
      console.log('   Check that you have admin privileges and parameters are correct')
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
