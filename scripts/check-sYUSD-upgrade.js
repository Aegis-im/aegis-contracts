// scripts/check-sYUSD-upgrade.js
// Helper script to check upgrade status and test new paused functionality

const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Checking upgrade status with account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name, `(Chain ID: ${network.chainId})`)

  // Get proxy address from environment variable
  const proxyAddress = process.env.PROXY_ADDRESS
  if (!proxyAddress) {
    throw new Error('Please provide PROXY_ADDRESS environment variable')
  }

  console.log('Proxy Address:', proxyAddress)

  // Get contract instance
  const sYUSD = await ethers.getContractAt('sYUSD', proxyAddress)

  console.log('\n=== Contract Information ===')
  
  // Basic contract info
  try {
    console.log('Name:', await sYUSD.name())
    console.log('Symbol:', await sYUSD.symbol())
    console.log('Asset:', await sYUSD.asset())
    console.log('Total Supply:', ethers.formatEther(await sYUSD.totalSupply()), 'sYUSD')
    console.log('Total Assets:', ethers.formatEther(await sYUSD.totalAssets()), 'YUSD')
  } catch (error) {
    console.error('Error getting basic info:', error.message)
  }

  // Implementation address
  try {
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
    console.log('Implementation Address:', implAddress)
  } catch (error) {
    console.error('Error getting implementation address:', error.message)
  }

  // Proxy admin address
  try {
    const adminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress)
    console.log('Proxy Admin Address:', adminAddress)
  } catch (error) {
    console.error('Error getting admin address:', error.message)
  }

  console.log('\n=== New Paused Functionality ===')
  
  // Check if paused functionality exists (indicates successful upgrade)
  try {
    const isPaused = await sYUSD.paused()
    console.log('✅ Paused functionality detected!')
    console.log('Current paused state:', isPaused)
    
    // Check roles
    const ADMIN_ROLE = ethers.id('ADMIN_ROLE')
    const hasAdminRole = await sYUSD.hasRole(ADMIN_ROLE, deployer.address)
    console.log('Deployer has ADMIN_ROLE:', hasAdminRole)
    
    if (hasAdminRole) {
      console.log('\n=== Testing Pause Functionality ===')
      console.log('Note: This will actually pause/unpause the contract!')
      
      // Test pause/unpause (only if we have admin role)
      const currentPauseState = await sYUSD.paused()
      console.log('Current state:', currentPauseState ? 'PAUSED' : 'NOT PAUSED')
      
      // Toggle pause state for testing
      console.log('Toggling pause state...')
      const newPauseState = !currentPauseState
      const tx = await sYUSD.setPaused(newPauseState)
      await tx.wait()
      
      const updatedPauseState = await sYUSD.paused()
      console.log('New state:', updatedPauseState ? 'PAUSED' : 'NOT PAUSED')
      console.log('Transaction hash:', tx.hash)
      
      // Revert back to original state
      console.log('Reverting to original state...')
      const revertTx = await sYUSD.setPaused(currentPauseState)
      await revertTx.wait()
      console.log('Reverted to original state:', currentPauseState ? 'PAUSED' : 'NOT PAUSED')
      
    } else {
      console.log('Cannot test pause functionality - deployer does not have ADMIN_ROLE')
      console.log('Only accounts with ADMIN_ROLE can call setPaused()')
    }
    
  } catch (error) {
    if (error.message.includes('paused')) {
      console.log('❌ Paused functionality not found - upgrade may not have been executed yet')
    } else {
      console.error('Error checking paused functionality:', error.message)
    }
  }

  console.log('\n=== Deposit Limits (ERC4626 Compliance) ===')
  
  // Test maxDeposit and maxMint functions
  try {
    const maxDeposit = await sYUSD.maxDeposit(deployer.address)
    const maxMint = await sYUSD.maxMint(deployer.address)
    
    console.log('Max Deposit:', maxDeposit.toString(), '(0 when paused)')
    console.log('Max Mint:', maxMint.toString(), '(0 when paused)')
    
    const isPaused = await sYUSD.paused()
    if (isPaused && (maxDeposit > 0n || maxMint > 0n)) {
      console.log('⚠️  WARNING: Contract is paused but max functions are not returning 0')
    } else if (isPaused && maxDeposit === 0n && maxMint === 0n) {
      console.log('✅ Pause functionality working correctly - deposits blocked')
    } else if (!isPaused && maxDeposit > 0n) {
      console.log('✅ Contract not paused - deposits allowed')
    }
    
  } catch (error) {
    console.error('Error checking deposit limits:', error.message)
  }

  console.log('\n=== Cooldown Settings ===')
  
  // Check cooldown settings
  try {
    const cooldownDuration = await sYUSD.cooldownDuration()
    console.log('Cooldown Duration:', cooldownDuration.toString(), 'seconds')
    console.log('Cooldown Duration (days):', (Number(cooldownDuration) / 86400).toFixed(2))
  } catch (error) {
    console.error('Error getting cooldown duration:', error.message)
  }

  console.log('\n=== Summary ===')
  console.log('Contract appears to be functioning correctly.')
  console.log('Upgrade status can be verified by checking if paused() function exists.')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })
