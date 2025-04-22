// scripts/deploy-stYUSD.js
const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get YUSD token address from command line or use a default for testing
  const yusdAddress = process.env.YUSD_ADDRESS
  if (!yusdAddress) {
    throw new Error('Please provide YUSD_ADDRESS environment variable')
  }

  // Get admin address from command line or use defaults
  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address

  console.log('YUSD Token Address:', yusdAddress)
  console.log('Admin Address:', adminAddress)

  // Deploy StYUSD
  console.log('Deploying StYUSD token...')
  const StYUSD = await ethers.getContractFactory('StYUSD')
  const deployTx = await StYUSD.deploy(yusdAddress, adminAddress)
  await deployTx.waitForDeployment()
  const stYusd = deployTx

  console.log('StYUSD deployed to:', await stYusd.getAddress())

  // Verify deployment parameters
  console.log('\nVerifying deployment parameters:')
  console.log(`Asset address: ${await stYusd.asset()}`)
  console.log(`Default admin role for ${adminAddress}: ${await stYusd.hasRole(await stYusd.DEFAULT_ADMIN_ROLE(), adminAddress)}`)

  // Get ADMIN_ROLE by hashing the string
  const adminRole = ethers.id('ADMIN_ROLE')
  console.log(`Admin role for ${adminAddress}: ${await stYusd.hasRole(adminRole, adminAddress)}`)

  // Print configuration values
  console.log('\nInitial configuration:')
  console.log(`Lockup period: ${await stYusd.lockupPeriod()} seconds (${await stYusd.lockupPeriod() / 86400n} days)`)

  console.log('\nDeployment completed successfully!')

  // For verification on block explorers like Etherscan
  console.log('\nVerification command:')
  console.log(`npx hardhat verify --network ${network.name} ${await stYusd.getAddress()} ${yusdAddress} ${adminAddress}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
