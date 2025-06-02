// scripts/deploy-sYUSD-upgradeable.js
const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  let yusdAddress = process.env.YUSD_ADDRESS

  // Deploy YUSD if on hardhat network
  if (network.name === 'hardhat' || network.name === 'localhost') {
    console.log('\nDeploying YUSD token for local testing...')
    const YUSD = await ethers.getContractFactory('YUSD')
    const yusd = await YUSD.deploy(deployer.address)
    await yusd.waitForDeployment()
    yusdAddress = await yusd.getAddress()

    // Set deployer as minter
    const setMinterTx = await yusd.setMinter(deployer.address)
    await setMinterTx.wait()

    // Mint some tokens to the deployer
    const mintAmount = ethers.parseUnits('1000000', 18) // 1M YUSD
    const mintTx = await yusd.mint(deployer.address, mintAmount)
    await mintTx.wait()

    console.log(`YUSD deployed to: ${yusdAddress}`)
    console.log(`Minted ${ethers.formatUnits(mintAmount, 18)} YUSD to ${deployer.address}`)
  } else if (!yusdAddress) {
    throw new Error('Please provide YUSD_ADDRESS environment variable')
  }

  // Get admin address from command line or use defaults
  const adminAddress = process.env.ADMIN_ADDRESS || deployer.address
  const proposerAddress = process.env.PROPOSER_ADDRESS || deployer.address
  const executorAddress = process.env.EXECUTOR_ADDRESS || deployer.address

  console.log('YUSD Token Address:', yusdAddress)
  console.log('Admin Address:', adminAddress)
  console.log('Proposer Address:', proposerAddress)
  console.log('Executor Address:', executorAddress)

  // Step 1: Deploy TimelockController
  console.log('\nDeploying TimelockController...')
  const TimelockController = await ethers.getContractFactory('TimelockControllerWrapper')

  // Set minimum delay for timelock (60 seconds for testing)
  const minDelay = 60
  const proposers = [proposerAddress]
  const executors = [executorAddress]

  const timelock = await TimelockController.deploy(minDelay, proposers, executors, adminAddress)
  await timelock.waitForDeployment()

  const timelockAddress = await timelock.getAddress()
  console.log('TimelockController deployed to:', timelockAddress)
  console.log('Minimum delay:', minDelay, 'seconds')

  // Step 2: Deploy sYUSDUpgradeable implementation and proxy
  console.log('\nDeploying sYUSDUpgradeable...')
  const sYUSDUpgradeable = await ethers.getContractFactory('sYUSDUpgradeable')

  // Set up proxy admin to be the timelock controller
  const sYUSDProxy = await upgrades.deployProxy(
    sYUSDUpgradeable,
    [yusdAddress, timelockAddress],
    {
      kind: 'uups',
      initializer: 'initialize',
      unsafeAllow: ['constructor', 'delegatecall'], // Allow creating new contracts in initializer
    },
  )

  await sYUSDProxy.waitForDeployment()

  const sYUSDAddress = await sYUSDProxy.getAddress()
  console.log('sYUSD proxy deployed to:', sYUSDAddress)

  // Verify deployment parameters
  console.log('\nVerifying deployment parameters:')
  console.log(`Asset address: ${await sYUSDProxy.asset()}`)

  // Get silo address
  const siloAddress = await sYUSDProxy.silo()
  console.log(`Silo address: ${siloAddress}`)

  // Check cooldown duration
  const cooldownDuration = await sYUSDProxy.cooldownDuration()
  console.log(`Cooldown duration: ${cooldownDuration} seconds (${cooldownDuration / 86400n} days)`)

  // Get roles by hashing the strings
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ADMIN_ROLE = ethers.id('ADMIN_ROLE')
  const UPGRADER_ROLE = ethers.id('UPGRADER_ROLE')

  // Explicitly grant roles to timelock
  console.log('\nChecking and granting roles to timelock...')

  // Check if deployer has admin role to be able to grant roles
  const deployerHasAdminRole = await sYUSDProxy.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)
  console.log(`Deployer has DEFAULT_ADMIN_ROLE: ${deployerHasAdminRole}`)

  if (deployerHasAdminRole) {
    try {
      // First check current role status
      const timelockHasUpgraderRole = await sYUSDProxy.hasRole(UPGRADER_ROLE, timelockAddress)
      console.log(`Timelock currently has UPGRADER_ROLE: ${timelockHasUpgraderRole}`)

      if (!timelockHasUpgraderRole) {
        console.log(`Granting UPGRADER_ROLE to timelock at ${timelockAddress}...`)
        const grantTx = await sYUSDProxy.grantRole(UPGRADER_ROLE, timelockAddress)
        await grantTx.wait()
        console.log('UPGRADER_ROLE granted to timelock')
      }

      // Check if timelock has ADMIN_ROLE
      const timelockHasAdminRole = await sYUSDProxy.hasRole(ADMIN_ROLE, timelockAddress)
      console.log(`Timelock currently has ADMIN_ROLE: ${timelockHasAdminRole}`)

      if (!timelockHasAdminRole) {
        console.log(`Granting ADMIN_ROLE to timelock at ${timelockAddress}...`)
        const grantAdminTx = await sYUSDProxy.grantRole(ADMIN_ROLE, timelockAddress)
        await grantAdminTx.wait()
        console.log('ADMIN_ROLE granted to timelock')
      }
    } catch (error) {
      console.error('Error granting roles to timelock:', error.message)
    }
  } else {
    console.log('Deployer does not have DEFAULT_ADMIN_ROLE, cannot grant roles')
  }

  // Display final role status
  console.log('\nFinal role status for timelock:')
  console.log(`- DEFAULT_ADMIN_ROLE: ${await sYUSDProxy.hasRole(DEFAULT_ADMIN_ROLE, timelockAddress)}`)
  console.log(`- ADMIN_ROLE: ${await sYUSDProxy.hasRole(ADMIN_ROLE, timelockAddress)}`)
  console.log(`- UPGRADER_ROLE: ${await sYUSDProxy.hasRole(UPGRADER_ROLE, timelockAddress)}`)

  // Make initial deposit to bootstrap liquidity
  console.log('\nMaking initial deposit of 100 YUSD...')
  try {
    // Get YUSD token instance
    const YUSD = await ethers.getContractFactory('YUSD')
    const yusd = YUSD.attach(yusdAddress)

    // Amount to deposit (100 YUSD with 18 decimals)
    const depositAmount = ethers.parseUnits('100', 18)

    // Approve sYUSD contract to spend YUSD
    console.log('Approving YUSD spend...')
    const approveTx = await yusd.connect(deployer).approve(sYUSDAddress, depositAmount)
    await approveTx.wait()
    console.log('Approval confirmed in transaction:', approveTx.hash)

    // Make the deposit
    console.log('Depositing YUSD...')
    const depositTx = await sYUSDProxy.connect(deployer).deposit(depositAmount, deployer.address)
    await depositTx.wait()
    console.log('Deposit confirmed in transaction:', depositTx.hash)

    // Verify the deposit
    const sYusdBalance = await sYUSDProxy.balanceOf(deployer.address)
    console.log(`Deposited successfully. sYUSD balance: ${ethers.formatUnits(sYusdBalance, 18)} sYUSD`)
  } catch (error) {
    console.error('Error making initial deposit:', error.message)
    console.log('Make sure the deployer has sufficient YUSD balance and correct permissions')
  }

  // Get implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(sYUSDAddress)
  console.log('\nImplementation contract address:', implementationAddress)

  console.log('\nDeployment completed successfully!')

  // For verification on block explorers like Etherscan
  console.log('\nVerification commands:')
  console.log(`npx hardhat verify --network ${network.name} ${timelockAddress} ${minDelay} ${JSON.stringify([proposerAddress])} ${JSON.stringify([executorAddress])} ${adminAddress}`)
  console.log(`npx hardhat verify --network ${network.name} ${implementationAddress}`)

  // Add YUSD contract verification command if deployed on this run
  if (network.name === 'hardhat' || network.name === 'localhost') {
    console.log(`npx hardhat verify --network ${network.name} ${yusdAddress} ${deployer.address}`)
    // Add silo contract verification if deployed
    if (siloAddress) {
      console.log(`npx hardhat verify --network ${network.name} ${siloAddress} ${sYUSDAddress} ${yusdAddress}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
