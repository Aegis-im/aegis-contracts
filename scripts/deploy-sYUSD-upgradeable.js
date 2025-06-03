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

  console.log('YUSD Token Address:', yusdAddress)
  console.log('Admin Address:', deployer.address)

  // Step 1: Deploy sYUSDUpgradeable implementation and proxy
  console.log('\nDeploying sYUSDUpgradeable...')
  const sYUSDUpgradeable = await ethers.getContractFactory('sYUSDUpgradeable')

  // Deploy with deployer as admin instead of timelock
  const sYUSDProxy = await upgrades.deployProxy(
    sYUSDUpgradeable,
    [yusdAddress, deployer.address],
    {
      kind: 'transparent',
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

  // Explicitly check roles for deployer
  console.log('\nChecking deployer roles...')

  // Check if deployer has admin role
  const deployerHasAdminRole = await sYUSDProxy.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)
  console.log(`Deployer has DEFAULT_ADMIN_ROLE: ${deployerHasAdminRole}`)

  // Check if deployer has ADMIN_ROLE
  const deployerHasContractAdminRole = await sYUSDProxy.hasRole(ADMIN_ROLE, deployer.address)
  console.log(`Deployer has ADMIN_ROLE: ${deployerHasContractAdminRole}`)

  // Check if deployer has UPGRADER_ROLE
  const deployerHasUpgraderRole = await sYUSDProxy.hasRole(UPGRADER_ROLE, deployer.address)
  console.log(`Deployer has UPGRADER_ROLE: ${deployerHasUpgraderRole}`)

  // Grant any missing roles to deployer if needed
  if (deployerHasAdminRole) {
    if (!deployerHasContractAdminRole) {
      console.log('Granting ADMIN_ROLE to deployer...')
      const grantAdminTx = await sYUSDProxy.grantRole(ADMIN_ROLE, deployer.address)
      await grantAdminTx.wait()
      console.log('ADMIN_ROLE granted to deployer')
    }

    if (!deployerHasUpgraderRole) {
      console.log('Granting UPGRADER_ROLE to deployer...')
      const grantUpgraderTx = await sYUSDProxy.grantRole(UPGRADER_ROLE, deployer.address)
      await grantUpgraderTx.wait()
      console.log('UPGRADER_ROLE granted to deployer')
    }
  }

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

  // Get proxy admin address (specific to TransparentUpgradeableProxy)
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(sYUSDAddress)
  console.log('Proxy admin address:', proxyAdminAddress)

  console.log('\nDeployment completed successfully!')

  // For verification on block explorers like Etherscan
  console.log('\nVerification commands:')
  console.log('NOTE: Run these commands after deployment to verify contracts on Etherscan or similar explorers')

  // Main implementation contract verification
  console.log('\n# Verify sYUSD implementation contract:')
  console.log(`npx hardhat verify --network ${network.name} ${implementationAddress}`)

  // If on local network, verify the YUSD token and silo contract
  if (network.name === 'hardhat' || network.name === 'localhost') {
    console.log('\n# Verify YUSD token contract:')
    console.log(`npx hardhat verify --network ${network.name} ${yusdAddress} ${deployer.address}`)

    if (siloAddress) {
      console.log('\n# Verify Silo contract:')
      console.log(`npx hardhat verify --network ${network.name} ${siloAddress} ${sYUSDAddress} ${yusdAddress}`)
    }
  }

  console.log('\n# IMPORTANT: For the proxy contract, use the \'Verify as Proxy\' feature in Etherscan')
  console.log(`Proxy address: ${sYUSDAddress}`)
  console.log(`Implementation address: ${implementationAddress}`)
  console.log(`Proxy admin address: ${proxyAdminAddress}`)
  console.log('\nSteps to verify the proxy on Etherscan:')
  console.log('1. First verify the implementation contract (command above)')
  console.log('2. Go to the proxy contract address on Etherscan')
  console.log('3. Under the "Contract" tab, click "More Options" and select "Verify as Proxy"')
  console.log('4. Etherscan should automatically detect the implementation contract if already verified')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
