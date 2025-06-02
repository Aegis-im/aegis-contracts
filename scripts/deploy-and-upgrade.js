const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying and upgrading contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Mock YUSD token address
  const yusdAddress = "0x0000000000000000000000000000000000000001"
  console.log('YUSD Token Address:', yusdAddress)
  console.log('Admin Address:', deployer.address)

  // Step 1: Deploy TimelockController
  console.log('\nDeploying TimelockController...')
  const TimelockController = await ethers.getContractFactory('TimelockControllerWrapper')
  
  // Set minimum delay for timelock (2 days in seconds)
  const minDelay = 2 * 24 * 60 * 60
  const proposers = [deployer.address]
  const executors = [deployer.address]
  
  const timelock = await TimelockController.deploy(minDelay, proposers, executors, deployer.address)
  await timelock.waitForDeployment()
  
  const timelockAddress = await timelock.getAddress()
  console.log('TimelockController deployed to:', timelockAddress)
  console.log('Minimum delay:', minDelay, 'seconds (2 days)')

  // Step 2: Deploy simple upgradeable contract V1
  console.log('\nDeploying Simple Upgradeable contract V1...')
  const SimpleUpgradeable = await ethers.getContractFactory('sYUSDUpgradeableSimple')
  
  // Deploy proxy
  const proxy = await upgrades.deployProxy(
    SimpleUpgradeable, 
    [yusdAddress, deployer.address], // Use deployer as admin for testing
    { 
      kind: 'uups',
      initializer: 'initialize',
    }
  )
  
  await proxy.waitForDeployment()
  
  const proxyAddress = await proxy.getAddress()
  console.log('Proxy deployed to:', proxyAddress)
  
  // Verify deployment
  console.log('\nVerifying deployment parameters:')
  console.log(`Asset address: ${await proxy.asset()}`)
  
  // Get roles
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ADMIN_ROLE = ethers.id('ADMIN_ROLE')
  const UPGRADER_ROLE = ethers.id('UPGRADER_ROLE')
  
  console.log(`Default admin role for ${deployer.address}: ${await proxy.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)}`)
  console.log(`Admin role for ${deployer.address}: ${await proxy.hasRole(ADMIN_ROLE, deployer.address)}`)
  console.log(`Upgrader role for ${deployer.address}: ${await proxy.hasRole(UPGRADER_ROLE, deployer.address)}`)

  // Get implementation address
  const implementationAddressV1 = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('\nImplementation contract address (V1):', implementationAddressV1)

  // Step 3: Upgrade to V2
  console.log('\nUpgrading to V2...')
  const SimpleUpgradeableV2 = await ethers.getContractFactory('sYUSDUpgradeableSimpleV2')
  
  // Prepare the upgrade
  const upgradedContract = await upgrades.upgradeProxy(proxyAddress, SimpleUpgradeableV2, {
    call: { fn: 'initializeV2' },
    kind: 'uups',
  })
  
  await upgradedContract.waitForDeployment()
  
  // Get the new implementation address
  const implementationAddressV2 = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('Implementation contract address (V2):', implementationAddressV2)

  // Check if upgrade was successful
  if (implementationAddressV1.toLowerCase() === implementationAddressV2.toLowerCase()) {
    console.log('Warning: Implementation address did not change.')
  } else {
    console.log('Upgrade completed successfully!')
  }

  // Check new version
  const version = await upgradedContract.version()
  console.log('New contract version:', version)

  console.log('\nDeployment and upgrade completed successfully!')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  }) 