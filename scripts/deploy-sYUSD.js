// scripts/deploy-sYUSD.js
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

  // Deploy sYUSD
  console.log('Deploying sYUSD token...')
  const sYUSD = await ethers.getContractFactory('sYUSD')
  const deployTx = await sYUSD.deploy(yusdAddress, adminAddress)
  await deployTx.waitForDeployment()
  const sYusd = deployTx

  console.log('sYUSD deployed to:', await sYusd.getAddress())

  // Verify deployment parameters
  console.log('\nVerifying deployment parameters:')
  console.log(`Asset address: ${await sYusd.asset()}`)
  console.log(`Default admin role for ${adminAddress}: ${await sYusd.hasRole(await sYusd.DEFAULT_ADMIN_ROLE(), adminAddress)}`)

  // Get ADMIN_ROLE by hashing the string
  const adminRole = ethers.id('ADMIN_ROLE')
  console.log(`Admin role for ${adminAddress}: ${await sYusd.hasRole(adminRole, adminAddress)}`)

  // Print configuration values
  console.log('\nInitial configuration:')
  console.log(`Lockup period: ${await sYusd.lockupPeriod()} seconds (${await sYusd.lockupPeriod() / 86400n} days)`)

  // Make initial deposit to bootstrap liquidity
  console.log('\nMaking initial deposit of 1 YUSD...')
  try {
    // Get YUSD token instance
    const YUSD = await ethers.getContractFactory('YUSD')
    const yusd = YUSD.attach(yusdAddress)

    // Amount to deposit (1 YUSD)
    const depositAmount = '1000000000001'

    // Approve sYUSD contract to spend YUSD
    console.log('Approving YUSD spend...')
    const approveTx = await yusd.connect(deployer).approve(await sYusd.getAddress(), depositAmount)
    await approveTx.wait()
    console.log('Approval confirmed in transaction:', approveTx.hash)

    // Make the deposit
    console.log('Depositing YUSD...')
    const depositTx = await sYusd.connect(deployer).deposit(depositAmount, deployer.address)
    await depositTx.wait()
    console.log('Deposit confirmed in transaction:', depositTx.hash)

    // Verify the deposit
    const sYusdBalance = await sYusd.balanceOf(deployer.address)
    console.log(`Deposited successfully. sYUSD balance: ${ethers.formatEther(sYusdBalance)} sYUSD`)
  } catch (error) {
    console.error('Error making initial deposit:', error.message)
    console.log('Make sure the deployer has sufficient YUSD balance and correct permissions')
  }

  console.log('\nDeployment completed successfully!')

  // For verification on block explorers like Etherscan
  console.log('\nVerification command:')
  console.log(`npx hardhat verify --network ${network.name} ${await sYusd.getAddress()} ${yusdAddress} ${adminAddress}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
