const { ethers, upgrades, network } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Running with the account:', deployer.address)

  // Get network
  const currentNetwork = network.name
  console.log('Network:', currentNetwork)

  // Mock YUSD token address
  const yusdAddress = '0x0000000000000000000000000000000000000001'
  console.log('YUSD Token Address:', yusdAddress)

  // Step 1: Deploy TimelockController with a short delay for testing
  console.log('\nDeploying TimelockController...')
  const TimelockController = await ethers.getContractFactory('TimelockControllerWrapper')

  // Set a short delay for testing (10 seconds)
  const minDelay = 10 // 10 seconds
  const proposers = [deployer.address]
  const executors = [deployer.address]

  const timelock = await TimelockController.deploy(minDelay, proposers, executors, deployer.address)
  await timelock.waitForDeployment()

  const timelockAddress = await timelock.getAddress()
  console.log('TimelockController deployed to:', timelockAddress)
  console.log('Minimum delay:', minDelay, 'seconds')

  // Step 2: Deploy full sYUSDUpgradeable contract
  console.log('\nDeploying sYUSDUpgradeable contract V1...')
  const sYUSDUpgradeable = await ethers.getContractFactory('sYUSDUpgradeable')

  // Deploy proxy with timelock as admin
  const proxy = await upgrades.deployProxy(
    sYUSDUpgradeable,
    [yusdAddress, timelockAddress], // Timelock is the admin
    {
      kind: 'uups',
      initializer: 'initialize',
      unsafeAllow: ['constructor', 'delegatecall'], // Allow creating new contracts in initializer
    },
  )

  await proxy.waitForDeployment()

  const proxyAddress = await proxy.getAddress()
  console.log('Proxy deployed to:', proxyAddress)

  // Verify deployment
  console.log('\nVerifying deployment parameters:')
  console.log(`Asset address: ${await proxy.asset()}`)

  // Get silo address
  const siloAddress = await proxy.silo()
  console.log(`Silo address: ${siloAddress}`)

  // Check cooldown duration
  const cooldownDuration = await proxy.cooldownDuration()
  console.log(`Cooldown duration: ${cooldownDuration} seconds (${cooldownDuration / 86400n} days)`)

  // Get roles
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ADMIN_ROLE = ethers.id('ADMIN_ROLE')
  const UPGRADER_ROLE = ethers.id('UPGRADER_ROLE')

  console.log(`Roles for ${timelockAddress}:`)
  console.log(`- Default admin role: ${await proxy.hasRole(DEFAULT_ADMIN_ROLE, timelockAddress)}`)
  console.log(`- Admin role: ${await proxy.hasRole(ADMIN_ROLE, timelockAddress)}`)
  console.log(`- Upgrader role: ${await proxy.hasRole(UPGRADER_ROLE, timelockAddress)}`)

  // Get implementation address
  const implementationAddressV1 = await upgrades.erc1967.getImplementationAddress(proxyAddress)
  console.log('\nImplementation contract address (V1):', implementationAddressV1)

  // Step 3: Prepare the upgrade
  console.log('\nPreparing upgrade proposal...')

  // Create a V2 version by deploying sYUSDUpgradeableSimpleV2
  // (since we don't have a V2 of the full contract)
  const sYUSDUpgradeableV2 = await ethers.getContractFactory('sYUSDUpgradeableSimpleV2')

  // Prepare new implementation contract
  const newImplementationAddress = await upgrades.prepareUpgrade(proxyAddress, sYUSDUpgradeableV2, {
    kind: 'uups',
    unsafeAllow: ['constructor', 'delegatecall'],
  })
  console.log('New implementation contract deployed at:', newImplementationAddress)

  // Step 4: Create upgrade proposal through timelock
  console.log('\nProposing upgrade through timelock...')

  // Create upgrade function call data
  const iface = new ethers.Interface(['function upgradeToAndCall(address newImplementation, bytes data)'])

  // Create call data for initializeV2
  const initializeV2CallData = sYUSDUpgradeableV2.interface.encodeFunctionData('initializeV2')

  // Create full upgrade call data with initialize
  const data = iface.encodeFunctionData('upgradeToAndCall', [
    newImplementationAddress,
    initializeV2CallData,
  ])

  // Schedule through timelock
  const delay = await timelock.getMinDelay()
  const predecessor = ethers.ZeroHash
  const salt = ethers.id(`upgrade-proposal-${Date.now()}`)

  const scheduleTx = await timelock.schedule(
    proxyAddress, // target = proxy contract
    0, // value = 0 ETH
    data, // data = upgrade call
    predecessor,
    salt,
    delay,
  )

  await scheduleTx.wait()

  // Get operation ID
  const operationId = await timelock.hashOperation(
    proxyAddress,
    0,
    data,
    predecessor,
    salt,
  )

  console.log('Upgrade scheduled through timelock')
  console.log('Operation ID:', operationId)

  // Check if the operation is ready (it shouldn't be yet)
  const isReadyBefore = await timelock.isOperationReady(operationId)
  console.log('Is operation ready?', isReadyBefore)

  // Advance time on the Hardhat network
  console.log(`\nAdvancing time by ${Number(delay) + 1} seconds...`)
  await time.increase(Number(delay) + 1)

  // Check again if ready
  const isReadyAfter = await timelock.isOperationReady(operationId)
  console.log('Is operation ready now?', isReadyAfter)

  if (!isReadyAfter) {
    throw new Error('Operation not ready after delay')
  }

  // Step 5: Execute the upgrade
  console.log('\nExecuting upgrade through timelock...')

  const executeTx = await timelock.execute(
    proxyAddress,
    0,
    data,
    predecessor,
    salt,
  )

  await executeTx.wait()
  console.log('Upgrade executed successfully!')

  // Verify the upgrade worked
  const upgradedContract = await ethers.getContractAt('sYUSDUpgradeableSimpleV2', proxyAddress)
  const implementationAddressV2 = await upgrades.erc1967.getImplementationAddress(proxyAddress)

  console.log('\nVerifying upgrade results:')
  console.log('Original implementation:', implementationAddressV1)
  console.log('New implementation:', implementationAddressV2)
  console.log('New version:', await upgradedContract.version())

  console.log('\nUpgrade through timelock completed successfully!')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })