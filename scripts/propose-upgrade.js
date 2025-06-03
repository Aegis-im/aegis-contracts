const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Proposing upgrade with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get required addresses from environment variables
  const proxyAddress = process.env.PROXY_ADDRESS
  const timelockAddress = process.env.TIMELOCK_ADDRESS


  if (!proxyAddress) {
    throw new Error('Please provide PROXY_ADDRESS environment variable')
  }

  if (!timelockAddress) {
    throw new Error('Please provide TIMELOCK_ADDRESS environment variable')
  }

  console.log('Proxy Address:', proxyAddress)
  console.log('Timelock Address:', timelockAddress)

  // Load contracts
  const sYUSDUpgradeable = await ethers.getContractFactory('sYUSDUpgradeable')
  const timelock = await ethers.getContractAt('TimelockControllerWrapper', timelockAddress)
  const sYUSD = await ethers.getContractAt('sYUSDUpgradeable', proxyAddress)

  // Check if the caller has the proposer role
  const PROPOSER_ROLE = await timelock.PROPOSER_ROLE()
  const isProposer = await timelock.hasRole(PROPOSER_ROLE, deployer.address)

  if (!isProposer) {
    console.error('Error: The deployer account does not have the PROPOSER_ROLE')
    console.log(`Please grant the PROPOSER_ROLE to ${deployer.address} or use an account that has this role`)
    process.exit(1)
  }

  // Check if the timelock has the upgrader role on the proxy
  const UPGRADER_ROLE = ethers.id('UPGRADER_ROLE')
  const canUpgrade = await sYUSD.hasRole(UPGRADER_ROLE, timelockAddress)

  if (!canUpgrade) {
    console.error('Error: The timelock does not have the UPGRADER_ROLE on the proxy')
    console.log(`Please grant the UPGRADER_ROLE to the timelock at ${timelockAddress}`)
    process.exit(1)
  }

  // Prepare upgrade
  console.log('\nPreparing upgrade proposal...')
  const sYUSDImplementation = await upgrades.prepareUpgrade(proxyAddress, sYUSDUpgradeable, {
    kind: 'uups',
    unsafeAllow: ['constructor', 'delegatecall'],
  })

  console.log('New implementation address:', sYUSDImplementation)

  // Create upgrade data - this is the call data for the upgradeToAndCall function
  const iface = new ethers.Interface(['function upgradeTo(address newImplementation)'])
  const data = iface.encodeFunctionData('upgradeTo', [sYUSDImplementation])

  // Schedule the proposal in the timelock
  console.log('\nScheduling upgrade proposal in timelock...')

  // Parameters for the proposal
  const delay = await timelock.getMinDelay() // Use the minimum delay
  const predecessor = ethers.ZeroHash // No predecessor
  const salt = ethers.id(`sYUSD-upgrade-${Date.now()}`) // Unique salt

  // Schedule the transaction
  const tx = await timelock.schedule(
    proxyAddress, // target = proxy contract
    0, // value = 0 ETH
    data, // data = upgrade function call
    predecessor, // predecessor = none
    salt, // salt for uniqueness
    delay, // delay = minimum delay
  )

  await tx.wait()

  // Calculate operation ID
  const operationId = await timelock.hashOperation(
    proxyAddress,
    0,
    data,
    predecessor,
    salt,
  )

  console.log('Upgrade proposal scheduled successfully!')
  console.log('Operation ID:', operationId)

  // Get the timestamp when the operation will be executable
  const timestamp = await timelock.getTimestamp(operationId)
  const readyDate = new Date(Number(timestamp) * 1000)

  console.log(`The upgrade can be executed after: ${readyDate.toLocaleString()}`)
  console.log(`(Timestamp: ${timestamp})`)

  // Instructions for executing the upgrade
  console.log('\nTo execute the upgrade after the delay has passed, run:')
  console.log(`OPERATION_ID=${operationId} TIMELOCK_ADDRESS=${timelockAddress} PROXY_ADDRESS=${proxyAddress} npx hardhat run scripts/execute-upgrade.js --network ${network.name}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })