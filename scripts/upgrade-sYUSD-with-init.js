// scripts/upgrade-sYUSD-with-init.js
const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Upgrading contract with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get proxy address from command line
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

  console.log('Proxy Address:', proxyAddress)
  console.log('Instant Unstaking Fee:', instantUnstakingFee, 'bps')
  console.log('Insurance Fund:', insuranceFund)

  // Get the current implementation address before upgrading
  const currentImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('Current implementation address:', currentImplAddress)

  // Get proxy admin address
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress)
  console.log('Proxy admin address:', proxyAdminAddress)

  // Deploy a new implementation contract
  console.log('\nDeploying new implementation...')
  const sYUSDUpgradeable = await ethers.getContractFactory('sYUSD')

  // Prepare the upgrade
  console.log('Preparing upgrade...')
  const upgraded = await upgrades.upgradeProxy(proxyAddress, sYUSDUpgradeable, {
    kind: 'transparent',
    unsafeAllow: ['constructor', 'delegatecall'],
  })

  await upgraded.waitForDeployment()

  // Get the new implementation address
  const newImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('New implementation address:', newImplAddress)

  // Check if implementation actually changed
  if (currentImplAddress.toLowerCase() === newImplAddress.toLowerCase()) {
    console.log('⚠️  Implementation address unchanged - possible reasons:')
    console.log('   1. OpenZeppelin reused existing implementation (bytecode identical)')
    console.log('   2. Contract was already upgraded to this version')
    console.log('   3. No significant changes in contract code')
    console.log('   This is usually safe - checking contract functionality...')
  } else {
    console.log('✅ Implementation address changed - upgrade successful!')
  }

  console.log('Upgrade completed successfully!')

  // Initialize V2 functionality
  console.log('\nInitializing V2 functionality...')

  // Connect to the upgraded contract
  const sYUSDContract = await ethers.getContractAt('sYUSD', proxyAddress)

  // Check if contract has new functions (confirms upgrade worked)
  console.log('🔍 Verifying upgrade...')
  try {
    const currentFee = await sYUSDContract.INSTANT_UNSTAKING_FEE()
    const currentInsuranceFund = await sYUSDContract.INSURANCE_FUND()
    console.log('✅ New V2 functions are available')

    if (currentFee > 0 || currentInsuranceFund !== ethers.ZeroAddress) {
      console.log('⚠️  V2 already initialized:')
      console.log('   Current fee:', currentFee.toString(), 'bps')
      console.log('   Current insurance fund:', currentInsuranceFund)
      console.log('   Skipping initialization...')
      return
    }
  } catch (error) {
    console.error('❌ V2 functions not available - upgrade may have failed')
    console.log('   Error:', error.message)
    return
  }

  // Check admin permissions
  console.log('🔐 Checking admin permissions...')
  try {
    const ADMIN_ROLE = await sYUSDContract.ADMIN_ROLE()
    const hasAdminRole = await sYUSDContract.hasRole(ADMIN_ROLE, deployer.address)

    if (!hasAdminRole) {
      console.error('❌ Deployer does not have ADMIN_ROLE')
      console.log('   Deployer address:', deployer.address)
      console.log('   Required role:', ADMIN_ROLE)

      // Try to find who has admin role
      const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
      const hasDefaultAdmin = await sYUSDContract.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)

      if (hasDefaultAdmin) {
        console.log('💡 Deployer has DEFAULT_ADMIN_ROLE, trying to grant ADMIN_ROLE...')
        try {
          const grantTx = await sYUSDContract.grantRole(ADMIN_ROLE, deployer.address)
          await grantTx.wait()
          console.log('✅ ADMIN_ROLE granted successfully')
        } catch (grantError) {
          console.error('❌ Failed to grant ADMIN_ROLE:', grantError.message)
          console.log('📋 Manual initialization required:')
          console.log(`   sYUSDContract.connect(adminAccount).initializeV2(${instantUnstakingFee}, "${insuranceFund}")`)
          return
        }
      } else {
        console.log('📋 Manual initialization required with admin account:')
        console.log(`   sYUSDContract.connect(adminAccount).initializeV2(${instantUnstakingFee}, "${insuranceFund}")`)
        return
      }
    } else {
      console.log('✅ Deployer has admin privileges')
    }
  } catch (error) {
    console.error('❌ Error checking admin permissions:', error.message)
    return
  }

  // Validate parameters
  const feeNumber = parseInt(instantUnstakingFee)
  if (feeNumber > 10000) {
    console.error('❌ Invalid fee: exceeds 10000 bps (100%)')
    return
  }

  if (!ethers.isAddress(insuranceFund)) {
    console.error('❌ Invalid insurance fund address')
    return
  }

  // Initialize V2
  try {
    console.log('🚀 Calling initializeV2...')
    console.log('   Fee:', feeNumber, 'bps (', (feeNumber / 100).toFixed(2), '%)')
    console.log('   Insurance Fund:', insuranceFund)

    const initTx = await sYUSDContract.initializeV2(feeNumber, insuranceFund)
    console.log('   Transaction hash:', initTx.hash)
    console.log('   Waiting for confirmation...')

    const receipt = await initTx.wait()
    console.log('✅ V2 initialization completed! Block:', receipt.blockNumber)

  } catch (error) {
    console.error('❌ V2 initialization failed:', error.message)

    if (error.message.includes('Already initialized')) {
      console.log('   V2 was already initialized by another transaction')
    } else if (error.message.includes('InvalidFee')) {
      console.log('   Fee exceeds maximum allowed (10000 bps)')
    } else if (error.message.includes('ZeroAddress')) {
      console.log('   Insurance fund address cannot be zero')
    } else if (error.message.includes('AccessControl')) {
      console.log('   Account does not have required admin privileges')
    } else {
      console.log('   Unexpected error - check transaction logs')
    }
    return
  }

  // Verify final state
  console.log('\n📊 Final Contract State:')
  try {
    const finalFee = await sYUSDContract.INSTANT_UNSTAKING_FEE()
    const finalInsuranceFund = await sYUSDContract.INSURANCE_FUND()
    const cooldownDuration = await sYUSDContract.cooldownDuration()

    console.log('   Instant Unstaking Fee:', finalFee.toString(), 'bps')
    console.log('   Insurance Fund:', finalInsuranceFund)
    console.log('   Cooldown Duration:', cooldownDuration.toString(), 'seconds')
    console.log('   Instant unstaking available:', cooldownDuration > 0 ? 'Yes (with fee)' : 'No (direct withdrawals)')
  } catch (error) {
    console.log('   Could not verify final state:', error.message)
  }

  // For verification on block explorers like Etherscan
  console.log('\n🔍 Verification command:')
  console.log(`npx hardhat verify --network ${network.name} ${newImplAddress}`)

  console.log('\n📝 Next Steps:')
  console.log('1. Verify the contract on block explorer')
  console.log('2. Test instant unstaking functionality')
  console.log('3. Update documentation with new features')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
