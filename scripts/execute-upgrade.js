const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Executing upgrade with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get required addresses from environment variables
  const proxyAddress = process.env.PROXY_ADDRESS
  const timelockAddress = process.env.TIMELOCK_ADDRESS
  const operationId = process.env.OPERATION_ID

  if (!proxyAddress) {
    throw new Error('Please provide PROXY_ADDRESS environment variable')
  }

  if (!timelockAddress) {
    throw new Error('Please provide TIMELOCK_ADDRESS environment variable')
  }

  if (!operationId) {
    throw new Error('Please provide OPERATION_ID environment variable')
  }

  console.log('Proxy Address:', proxyAddress)
  console.log('Timelock Address:', timelockAddress)
  console.log('Operation ID:', operationId)

  // Load timelock contract
  const timelock = await ethers.getContractAt('TimelockControllerWrapper', timelockAddress)

  // Check if the caller has the executor role
  const EXECUTOR_ROLE = await timelock.EXECUTOR_ROLE()
  const isExecutor = await timelock.hasRole(EXECUTOR_ROLE, deployer.address) 

  if (!isExecutor) {
    console.error('Error: The deployer account does not have the EXECUTOR_ROLE')
    console.log(`Please grant the EXECUTOR_ROLE to ${deployer.address} or use an account that has this role`)
    process.exit(1)
  }

  // Check operation status
  const isReady = await timelock.isOperationReady(operationId)
  const isPending = await timelock.isOperationPending(operationId)
  const isDone = await timelock.isOperationDone(operationId)

  console.log('Operation status:')
  console.log('- Ready:', isReady)
  console.log('- Pending:', isPending)
  console.log('- Done:', isDone)

  if (isDone) {
    console.log('This operation has already been executed.')
    process.exit(0)
  }

  if (!isReady) {
    if (isPending) {
      const timestamp = await timelock.getTimestamp(operationId)
      const readyDate = new Date(Number(timestamp) * 1000)
      console.error('Error: The operation is not ready for execution yet.')
      console.log(`It will be ready after: ${readyDate.toLocaleString()}`)
    } else {
      console.error('Error: Operation not found or has been cancelled.')
    }
    process.exit(1)
  }

  // Get operation details
  console.log('\nRetrieving operation details...')

  // We need to reconstruct the parameters used when scheduling
  // This is typically stored off-chain or retrieved from events
  // For simplicity, we're assuming we know the target, value, and data

  try {
    // Execute the operation
    console.log('Executing the upgrade...')

    // Find the operation from events
    const filter = timelock.filters.CallScheduled(operationId)
    const events = await timelock.queryFilter(filter)

    if (events.length === 0) {
      console.error('Error: Could not find scheduled call events for this operation ID')
      process.exit(1)
    }

    const event = events[0]
    const { target, value, data, predecessor, salt } = event.args

    // Execute the operation
    const tx = await timelock.execute(
      target,
      value,
      data,
      predecessor,
      salt,
    )

    await tx.wait()

    console.log('Upgrade executed successfully!')
    console.log('Transaction hash:', tx.hash)

    // Get the new implementation address
    const sYUSD = await ethers.getContractAt('sYUSDUpgradeable', proxyAddress)
    const newImplementation = await upgrades.erc1967.getImplementationAddress(proxyAddress)

    console.log('\nNew implementation address:', newImplementation)

  } catch (error) {
    console.error('Error executing upgrade:', error.message)
    process.exit(1)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })