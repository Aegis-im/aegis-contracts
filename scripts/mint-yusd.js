const { ethers, network } = require('hardhat')
const { getNetworksConfig } = require('../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🪙 Minting YUSD tokens on ${networkName}...`)

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  if (!contracts.yusdAddress) {
    throw new Error(`❌ yusdAddress not found in config for ${networkName}`)
  }

  console.log(`📋 Using YUSD address: ${contracts.yusdAddress}`)

  // Get signer
  const [signer] = await ethers.getSigners()
  console.log(`👤 Minting to account: ${signer.address}`)

  // Connect to YUSD contract
  const yusd = await ethers.getContractAt('YUSD', contracts.yusdAddress)

  // Amount to mint (1000 YUSD with 18 decimals)
  const MINT_AMOUNT = ethers.parseEther('1000')
  console.log('💰 Amount to mint: 1000 YUSD')

  try {
    // Check current balance
    const initialBalance = await yusd.balanceOf(signer.address)
    console.log('📊 Initial balance: ' + ethers.formatEther(initialBalance) + ' YUSD')

    // Get current minter
    const currentMinter = await yusd.minter()
    console.log('🔍 Current minter: ' + currentMinter)

    const isAlreadyMinter = currentMinter.toLowerCase() === signer.address.toLowerCase()

    if (!isAlreadyMinter) {
      console.log('🔑 Setting minter to ' + signer.address + '...')

      // Check if signer is owner to set minter
      const owner = await yusd.owner()
      const isOwner = owner.toLowerCase() === signer.address.toLowerCase()

      if (!isOwner) {
        throw new Error('❌ Signer is not owner. Current owner: ' + owner)
      }

      // Set signer as minter
      const setMinterTx = await yusd.setMinter(signer.address)
      await setMinterTx.wait()
      console.log('✅ Minter set to signer')
    } else {
      console.log('✅ Signer is already the minter')
    }

    // Mint tokens
    console.log('🔨 Minting ' + ethers.formatEther(MINT_AMOUNT) + ' YUSD...')
    const mintTx = await yusd.mint(signer.address, MINT_AMOUNT)
    await mintTx.wait()
    console.log('✅ Minted successfully! TX: ' + mintTx.hash)

    // Check new balance
    const finalBalance = await yusd.balanceOf(signer.address)
    console.log('📊 Final balance: ' + ethers.formatEther(finalBalance) + ' YUSD')
    console.log('📈 Minted: ' + ethers.formatEther(finalBalance - initialBalance) + ' YUSD')

    // Restore original minter if it was different
    if (!isAlreadyMinter) {
      console.log('🔄 Restoring original minter: ' + currentMinter)
      const restoreMinterTx = await yusd.setMinter(currentMinter)
      await restoreMinterTx.wait()
      console.log('✅ Original minter restored - system back to normal')
    }

    console.log('\n🎉 Mint completed successfully!')
    console.log('💰 Total YUSD balance: ' + ethers.formatEther(finalBalance) + ' YUSD')
  } catch (error) {
    console.error('❌ Error during minting:', error.message)

    // Try to clean up - restore original minter if we changed it
    try {
      const currentMinter = await yusd.minter()

      if (currentMinter.toLowerCase() === signer.address.toLowerCase()) {
        // We need to restore the original minter, but we need to know what it was
        // This is a limitation - we can't always restore if we don't know the original
        console.log('🧹 Cleanup: Current minter is signer, but original minter unknown')
        console.log('⚠️  Manual intervention may be required to set correct minter')
      }
    } catch (cleanupError) {
      console.error('⚠️  Cleanup failed:', cleanupError.message)
    }

    throw error
  }
}

main().catch(console.error)
