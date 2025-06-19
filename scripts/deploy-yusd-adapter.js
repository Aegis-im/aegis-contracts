const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network info
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name, 'Chain ID:', network.chainId)

  // Configuration
  const config = {
    yusdTokenAddress: process.env.YUSD_ADDRESS,
    lzEndpointAddress: process.env.LZ_ENDPOINT,
    adminAddress: process.env.ADMIN_ADDRESS || deployer.address,
  }

  if (!config.yusdTokenAddress) {
    throw new Error('Please provide YUSD_ADDRESS environment variable')
  }
  if (!config.lzEndpointAddress) {
    throw new Error('Please provide LZ_ENDPOINT environment variable')
  }

  console.log('Configuration:')
  console.log('- YUSD Token:', config.yusdTokenAddress)
  console.log('- LZ Endpoint:', config.lzEndpointAddress)
  console.log('- Admin:', config.adminAddress)
  console.log()

  // Deploy YUSDMintBurnOFTAdapter
  console.log('Deploying YUSDMintBurnOFTAdapter...')
  const YUSDAdapter = await ethers.getContractFactory('YUSDMintBurnOFTAdapter')
  const oftAdapter = await YUSDAdapter.deploy(
    config.yusdTokenAddress,
    config.lzEndpointAddress,
    config.adminAddress,
  )
  await oftAdapter.waitForDeployment()
  const oftAdapterAddress = await oftAdapter.getAddress()
  console.log('YUSDMintBurnOFTAdapter deployed to:', oftAdapterAddress)

  // Verify setup
  console.log('Verifying setup...')
  const oftToken = await oftAdapter.innerToken()
  console.log('- OFT inner token:', oftToken)
  console.log('- Expected YUSD token:', config.yusdTokenAddress)
  console.log('- Tokens match:', oftToken.toLowerCase() === config.yusdTokenAddress.toLowerCase())

  const yusdTokenRef = await oftAdapter.yusdToken()
  console.log('- YUSD token reference:', yusdTokenRef)

  // Print deployment summary
  console.log('\n=== DEPLOYMENT SUMMARY ===')
  console.log('Network:', network.name)
  console.log('Chain ID:', network.chainId)
  console.log('YUSD Token:', config.yusdTokenAddress)
  console.log('YUSDMintBurnOFTAdapter:', oftAdapterAddress)
  console.log('LayerZero Endpoint:', config.lzEndpointAddress)
  console.log('Admin:', config.adminAddress)

  console.log('\n=== NEXT STEPS ===')
  console.log('1. Set YUSDMintBurnOFTAdapter as minter in YUSD contract:')
  console.log(`   yusd.setMinter("${oftAdapterAddress}")`)
  console.log('2. Configure peer connections for cross-chain transfers')
  console.log('3. Set enforced options if needed')

  console.log('\n=== VERIFICATION COMMAND ===')
  console.log(`npx hardhat verify --network ${network.name} ${oftAdapterAddress} ${config.yusdTokenAddress} ${config.lzEndpointAddress} ${config.adminAddress}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })