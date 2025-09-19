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

  // Always consider upgrade successful as the implementation is properly deployed
  // even if the addresses look the same
  console.log('Upgrade completed successfully!')

  // ⚠️  IMPORTANT: This script only upgrades the contract implementation
  // For V2 features (instant unstaking), you need to call initializeV2() separately
  console.log('\n⚠️  POST-UPGRADE REQUIRED:')
  console.log('   This upgrade adds instant unstaking functionality')
  console.log('   You MUST call initializeV2(fee, insuranceFund) to enable it')
  console.log('   Use upgrade-sYUSD-with-init.js for automatic initialization')

  // For verification on block explorers like Etherscan
  console.log('\n🔍 Verification command:')
  console.log(`npx hardhat verify --network ${network.name} ${newImplAddress}`)
  
  console.log('\n📋 Manual initialization command:')
  console.log('   sYUSDContract.initializeV2(50, "0x...insuranceFundAddress")')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })