// scripts/deploy-implementation-only.js
// Deploy just the implementation contract with minimal gas usage

const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying implementation with account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name, `(Chain ID: ${network.chainId})`)

  // Check balance
  const balance = await ethers.provider.getBalance(deployer.address)
  console.log('Balance:', ethers.formatEther(balance), 'BNB')

  // Deploy implementation only
  console.log('\n=== Deploying sYUSD Implementation ===')
  const sYUSD = await ethers.getContractFactory('sYUSD')

  // BSC requires 0.1 gwei as specified
  let gasOptions = {}
  if (network.chainId === 56n || network.chainId === 97n) {
    gasOptions = {
      type: 0, // Use legacy transaction type to avoid EIP-1559 issues
      gasPrice: ethers.parseUnits('0.1', 'gwei'),
      gasLimit: 2000000, // Standard gas limit
    }
    console.log('Using gas price:', ethers.formatUnits(gasOptions.gasPrice, 'gwei'), 'gwei')
    console.log('Estimated cost:', ethers.formatEther(gasOptions.gasPrice * BigInt(gasOptions.gasLimit)), 'BNB')
  }

  try {
    const implementation = await sYUSD.deploy(gasOptions)
    await implementation.waitForDeployment()

    const implAddress = await implementation.getAddress()
    console.log('✅ Implementation deployed at:', implAddress)

    console.log('\n=== Next Steps ===')
    console.log('Use this implementation address in your upgrade:')
    console.log(`Implementation Address: ${implAddress}`)

    console.log('\nVerification command:')
    console.log(`npx hardhat verify --network ${network.name} ${implAddress}`)

  } catch (error) {
    console.error('Deployment failed:', error.message)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })