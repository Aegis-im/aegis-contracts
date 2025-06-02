// scripts/upgrade-sYUSD.js
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

  console.log('Proxy Address:', proxyAddress)

  // Get the current implementation address before upgrading
  const currentImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('Current implementation address:', currentImplAddress)

  // Deploy a new implementation contract
  console.log('\nDeploying new implementation...')
  const sYUSDUpgradeable = await ethers.getContractFactory('sYUSDUpgradeable')

  // Prepare the upgrade
  console.log('Preparing upgrade...')
  const upgraded = await upgrades.upgradeProxy(proxyAddress, sYUSDUpgradeable, {
    kind: 'uups',
    unsafeAllow: ['constructor', 'delegatecall'],
  })

  await upgraded.waitForDeployment()

  // Get the new implementation address
  const newImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('New implementation address:', newImplAddress)

  if (currentImplAddress.toLowerCase() === newImplAddress.toLowerCase()) {
    console.log('Warning: Implementation address did not change. This may be because:')
    console.log('1. No changes were made to the contract')
    console.log('2. Only comments or non-functional changes were made')
  } else {
    console.log('Upgrade completed successfully!')
  }

  // For verification on block explorers like Etherscan
  console.log('\nVerification command:')
  console.log(`npx hardhat verify --network ${network.name} ${newImplAddress}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })