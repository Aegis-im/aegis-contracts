const { ethers, network } = require('hardhat')
const { getNetworksConfig } = require('../utils/helpers')

async function main() {
  const networkName = network.name
  console.log(`🔄 Transferring sYUSD OFT ownership on ${networkName}...`)

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts

  // Validate required addresses exist
  const requiredAddresses = ['syusdOftAddress']
  for (const addr of requiredAddresses) {
    if (!contracts[addr]) {
      throw new Error(`❌ ${addr} not found in config for ${networkName}`)
    }
  }

  // Get new owner from environment variable or prompt
  const newOwner = process.env.NEW_OWNER
  if (!newOwner) {
    throw new Error('❌ Please provide NEW_OWNER environment variable with the new owner address')
  }

  // Validate new owner address
  if (!ethers.isAddress(newOwner)) {
    throw new Error(`❌ Invalid new owner address: ${newOwner}`)
  }

  console.log('📋 Using addresses from config:')
  console.log(`  - sYUSD OFT: ${contracts.syusdOftAddress}`)
  console.log(`  - New Owner: ${newOwner}`)

  // Get current signer
  const [signer] = await ethers.getSigners()
  console.log(`👤 Using account: ${signer.address}`)

  // Connect to sYUSD OFT contract
  console.log('\n1️⃣ Connecting to sYUSD OFT contract...')
  const sYUSDOFT = await ethers.getContractFactory('sYUSDOFT')
  const syusdOft = sYUSDOFT.attach(contracts.syusdOftAddress)

  // Verify current ownership
  console.log('\n2️⃣ Verifying current ownership...')
  try {
    const currentOwner = await syusdOft.owner()
    console.log('  ✅ Current owner: ' + currentOwner)

    // Check if signer is the current owner
    if (currentOwner.toLowerCase() !== signer.address.toLowerCase()) {
      throw new Error(`❌ Signer (${signer.address}) is not the current owner (${currentOwner})`)
    }

    // Check if new owner is different from current owner
    if (currentOwner.toLowerCase() === newOwner.toLowerCase()) {
      throw new Error(`❌ New owner is the same as current owner: ${newOwner}`)
    }

    console.log('  ✅ Signer is authorized to transfer ownership')
  } catch (error) {
    console.log(`❌ Failed to verify ownership: ${error.message}`)
    throw error
  }

  // Confirm transfer details
  console.log('\n3️⃣ Transfer details:')
  console.log('  - Contract: sYUSDOFT')
  console.log('  - Address: ' + contracts.syusdOftAddress)
  console.log('  - Current Owner: ' + signer.address)
  console.log('  - New Owner: ' + newOwner)
  console.log('  - Network: ' + networkName)

  // Perform ownership transfer
  console.log('\n4️⃣ Transferring ownership...')
  let tx
  try {
    tx = await syusdOft.transferOwnership(newOwner)
    console.log('  📝 Transaction submitted: ' + tx.hash)

    console.log('  ⏳ Waiting for confirmation...')
    const receipt = await tx.wait()
    console.log('  ✅ Transaction confirmed in block ' + receipt.blockNumber)

    // Verify the transfer
    console.log('\n5️⃣ Verifying ownership transfer...')
    const updatedOwner = await syusdOft.owner()
    if (updatedOwner.toLowerCase() === newOwner.toLowerCase()) {
      console.log('  ✅ Ownership successfully transferred to: ' + updatedOwner)
    } else {
      throw new Error('❌ Ownership transfer failed. Current owner: ' + updatedOwner)
    }

  } catch (error) {
    console.log(`❌ Transfer failed: ${error.message}`)
    throw error
  }

  // Summary
  console.log('\n🎉 Ownership transfer completed successfully!')
  console.log('📋 Summary:')
  console.log('  - Contract: sYUSDOFT')
  console.log('  - Address: ' + contracts.syusdOftAddress)
  console.log('  - New Owner: ' + newOwner)
  console.log('  - Transaction: ' + tx.hash)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
