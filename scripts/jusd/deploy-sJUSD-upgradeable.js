// scripts/jusd/deploy-sJUSD-upgradeable.js
const { ethers, upgrades } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig } = require('../../utils/helpers')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Load network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks[network.name]) {
    throw new Error(`❌ Network ${network.name} not found in config/networks.json`)
  }

  const networkConfig = config.networks[network.name]
  let jusdAddress = networkConfig.contracts?.jusdAddress || process.env.JUSD_ADDRESS

  // Deploy JUSD if on hardhat network
  if (network.name === 'hardhat' || network.name === 'localhost') {
    console.log('\nDeploying JUSD token for local testing...')
    const JUSD = await ethers.getContractFactory('JUSD')
    const jusd = await JUSD.deploy(deployer.address)
    await jusd.waitForDeployment()
    jusdAddress = await jusd.getAddress()

    // Set deployer as minter
    const setMinterTx = await jusd.setMinter(deployer.address)
    await setMinterTx.wait()

    // Mint some tokens to the deployer
    const mintAmount = ethers.parseUnits('1000000', 18) // 1M JUSD
    const mintTx = await jusd.mint(deployer.address, mintAmount)
    await mintTx.wait()

    console.log(`JUSD deployed to: ${jusdAddress}`)
    console.log(`Minted ${ethers.formatUnits(mintAmount, 18)} JUSD to ${deployer.address}`)
  } else if (!jusdAddress) {
    throw new Error('Please provide jusdAddress in config/networks.json or JUSD_ADDRESS environment variable')
  }

  console.log('JUSD Token Address:', jusdAddress)
  console.log('Admin Address:', deployer.address)

  // Step 1: Deploy sJUSD implementation and proxy
  console.log('\nDeploying sJUSD...')
  const sJUSD = await ethers.getContractFactory('sJUSD')

  // Deploy with deployer as admin instead of timelock
  const sJUSDProxy = await upgrades.deployProxy(sJUSD, [jusdAddress, deployer.address], {
    kind: 'transparent',
    initializer: 'initialize',
    unsafeAllow: ['constructor', 'delegatecall'], // Allow creating new contracts in initializer
  })

  await sJUSDProxy.waitForDeployment()

  const sJUSDAddress = await sJUSDProxy.getAddress()
  console.log('sJUSD proxy deployed to:', sJUSDAddress)

  // Verify deployment parameters
  console.log('\nVerifying deployment parameters:')
  console.log(`Asset address: ${await sJUSDProxy.asset()}`)

  // Get silo address
  const siloAddress = await sJUSDProxy.silo()
  console.log(`Silo address: ${siloAddress}`)

  // Check cooldown duration
  const cooldownDuration = await sJUSDProxy.cooldownDuration()
  console.log(`Cooldown duration: ${cooldownDuration} seconds (${cooldownDuration / 86400n} days)`)

  // Get roles by hashing the strings
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ADMIN_ROLE = ethers.id('ADMIN_ROLE')
  const UPGRADER_ROLE = ethers.id('UPGRADER_ROLE')

  // Explicitly check roles for deployer
  console.log('\nChecking deployer roles...')

  // Check if deployer has admin role
  const deployerHasAdminRole = await sJUSDProxy.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)
  console.log(`Deployer has DEFAULT_ADMIN_ROLE: ${deployerHasAdminRole}`)

  // Check if deployer has ADMIN_ROLE
  const deployerHasContractAdminRole = await sJUSDProxy.hasRole(ADMIN_ROLE, deployer.address)
  console.log(`Deployer has ADMIN_ROLE: ${deployerHasContractAdminRole}`)

  // Check if deployer has UPGRADER_ROLE
  const deployerHasUpgraderRole = await sJUSDProxy.hasRole(UPGRADER_ROLE, deployer.address)
  console.log(`Deployer has UPGRADER_ROLE: ${deployerHasUpgraderRole}`)

  // Grant any missing roles to deployer if needed
  if (deployerHasAdminRole) {
    if (!deployerHasContractAdminRole) {
      console.log('Granting ADMIN_ROLE to deployer...')
      const grantAdminTx = await sJUSDProxy.grantRole(ADMIN_ROLE, deployer.address)
      await grantAdminTx.wait()
      console.log('ADMIN_ROLE granted to deployer')
    }

    if (!deployerHasUpgraderRole) {
      console.log('Granting UPGRADER_ROLE to deployer...')
      const grantUpgraderTx = await sJUSDProxy.grantRole(UPGRADER_ROLE, deployer.address)
      await grantUpgraderTx.wait()
      console.log('UPGRADER_ROLE granted to deployer')
    }
  }

  // Make initial deposit to bootstrap liquidity
  console.log('\nMaking initial deposit of 100 JUSD...')
  try {
    // Get JUSD token instance
    const JUSD = await ethers.getContractFactory('JUSD')
    const jusd = JUSD.attach(jusdAddress)

    // Amount to deposit (100 JUSD with 18 decimals)
    const depositAmount = ethers.parseUnits('100', 18)

    // Approve sJUSD contract to spend JUSD
    console.log('Approving JUSD spend...')
    const approveTx = await jusd.connect(deployer).approve(sJUSDAddress, depositAmount)
    await approveTx.wait()
    console.log('Approval confirmed in transaction:', approveTx.hash)

    // Make the deposit
    console.log('Depositing JUSD...')
    const depositTx = await sJUSDProxy.connect(deployer).deposit(depositAmount, deployer.address)
    await depositTx.wait()
    console.log('Deposit confirmed in transaction:', depositTx.hash)

    // Verify the deposit
    const sJusdBalance = await sJUSDProxy.balanceOf(deployer.address)
    console.log(`Deposited successfully. sJUSD balance: ${ethers.formatUnits(sJusdBalance, 18)} sJUSD`)
  } catch (error) {
    console.error('Error making initial deposit:', error.message)
    console.log('Make sure the deployer has sufficient JUSD balance and correct permissions')
  }

  // Get implementation address
  const implementationAddress = await upgrades.erc1967.getImplementationAddress(sJUSDAddress)
  console.log('\nImplementation contract address:', implementationAddress)

  // Get proxy admin address (specific to TransparentUpgradeableProxy)
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(sJUSDAddress)
  console.log('Proxy admin address:', proxyAdminAddress)

  // Update networks.json with new addresses
  console.log('\n📝 Updating networks.json...')
  updateNetworksConfig(network.name, {
    sJUSDAddress: sJUSDAddress,
    sJUSDSiloAddress: siloAddress,
  })

  console.log('\nDeployment completed successfully!')

  // For verification on block explorers like Etherscan
  console.log('\nVerification commands:')
  console.log('NOTE: Run these commands after deployment to verify contracts on Etherscan or similar explorers')

  // Main implementation contract verification
  console.log('\n# Verify sJUSD implementation contract:')
  console.log(`npx hardhat verify --network ${network.name} ${implementationAddress}`)

  // If on local network, verify the JUSD token and silo contract
  if (network.name === 'hardhat' || network.name === 'localhost') {
    console.log('\n# Verify JUSD token contract:')
    console.log(`npx hardhat verify --network ${network.name} ${jusdAddress} ${deployer.address}`)

    if (siloAddress) {
      console.log('\n# Verify Silo contract:')
      console.log(`npx hardhat verify --network ${network.name} ${siloAddress} ${sJUSDAddress} ${jusdAddress}`)
    }
  }

  console.log('IMPORTANT: For the proxy contract, use the \'Verify as Proxy\' feature in Etherscan')
  console.log(`Proxy address: ${sJUSDAddress}`)
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
