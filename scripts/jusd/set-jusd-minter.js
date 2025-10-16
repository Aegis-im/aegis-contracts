// scripts/jusd/set-jusd-minter.js
const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Setting JUSD minter with account:', deployer.address)

  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get addresses from environment variables
  const jusdAddress = process.env.JUSD_ADDRESS
  if (!jusdAddress) {
    throw new Error('Please provide JUSD_ADDRESS environment variable')
  }

  const minterAddress = process.env.MINTER_ADDRESS
  if (!minterAddress) {
    throw new Error('Please provide MINTER_ADDRESS environment variable')
  }

  console.log('\nJUSD:', jusdAddress)
  console.log('New Minter:', minterAddress)

  // Connect to JUSD contract
  const jusd = await ethers.getContractAt('JUSD', jusdAddress)

  // Get current minter
  const currentMinter = await jusd.minter()
  console.log('Current minter:', currentMinter)

  if (currentMinter.toLowerCase() === minterAddress.toLowerCase()) {
    console.log('✅ Minter already set correctly')
    return
  }

  // Set new minter
  console.log('\nSetting new minter...')
  const tx = await jusd.setMinter(minterAddress)
  await tx.wait()

  console.log('✅ Minter set successfully')
  console.log('Transaction hash:', tx.hash)

  // Verify
  const newMinter = await jusd.minter()
  console.log('\nVerification:')
  console.log('New minter:', newMinter)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

