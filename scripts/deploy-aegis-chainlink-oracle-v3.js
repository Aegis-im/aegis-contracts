const { ethers } = require('hardhat')
const { updateNetworksConfig } = require('../utils/helpers')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying AegisChainlinkOracleV3 with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get parameters from environment variables or use defaults
  // --------------------------------------------------------------------

  // Initial owner (defaults to deployer)
  const initialOwner = process.env.INITIAL_OWNER || deployer.address
  console.log('Initial Owner:', initialOwner)

  // Initial operators (can be empty array)
  const operators = process.env.OPERATORS ? process.env.OPERATORS.split(',') : []
  console.log('Initial Operators:', operators)

  // --------------------------------------------------------------------
  // DEPLOYMENT
  // --------------------------------------------------------------------

  console.log('\nDeploying AegisChainlinkOracleV3...')
  const AegisChainlinkOracleV3 = await ethers.getContractFactory('AegisChainlinkOracleV3')
  const aegisChainlinkOracleV3Contract = await AegisChainlinkOracleV3.deploy(operators, initialOwner)
  await aegisChainlinkOracleV3Contract.waitForDeployment()
  const aegisChainlinkOracleV3Address = await aegisChainlinkOracleV3Contract.getAddress()
  console.log('AegisChainlinkOracleV3 deployed to:', aegisChainlinkOracleV3Address)

  // --------------------------------------------------------------------
  // VERIFICATION
  // --------------------------------------------------------------------

  console.log('\nVerifying deployment...')

  // Check if contract is deployed correctly
  const decimals = await aegisChainlinkOracleV3Contract.decimals()
  console.log('Decimals:', decimals)

  const owner = await aegisChainlinkOracleV3Contract.owner()
  console.log('Owner:', owner)

  // Check operators (note: _operators is private, so we can't verify directly)
  console.log('Initial operators set:', operators.length > 0 ? operators : 'None')

  // --------------------------------------------------------------------
  // UPDATE CONFIGURATION
  // --------------------------------------------------------------------

  console.log('\nUpdating networks configuration...')

  // Update networks.json with the new contract address
  const contractAddresses = { aegisChainlinkOracleV3Address: aegisChainlinkOracleV3Address }

  updateNetworksConfig(network.name, contractAddresses)

  // --------------------------------------------------------------------
  // DEPLOYMENT SUMMARY
  // --------------------------------------------------------------------

  console.log('\n' + '='.repeat(60))
  console.log('DEPLOYMENT SUMMARY')
  console.log('='.repeat(60))
  console.log('Network:', network.name)
  console.log('Deployer:', deployer.address)
  console.log('Initial Owner:', initialOwner)
  console.log('Initial Operators:', operators.length > 0 ? operators : 'None')
  console.log('AegisChainlinkOracleV3 Address:', aegisChainlinkOracleV3Address)
  console.log('Decimals:', decimals)
  console.log('Scale Factor: 1e28 (immutable)')
  console.log('='.repeat(60))

  console.log('\n📝 Contract verification command:')

  if (operators.length === 0) {
    // For empty arrays, use constructor-args file approach
    console.log(`npx hardhat verify --network ${network.name} ${aegisChainlinkOracleV3Address} --constructor-args verify-args-${network.name}.js`)
    console.log('Create verify-args-' + network.name + '.js with content:')
    console.log(`module.exports = [
  [],
  "${initialOwner}"
];`)
  } else {
    // For non-empty arrays, use direct command line arguments
    console.log(
      `npx hardhat verify --network ${network.name} ${aegisChainlinkOracleV3Address} "[${operators.map((addr) => `"${addr}"`).join(', ')}]" "${initialOwner}"`,
    )
  }

  // Return contract addresses for potential use in other scripts
  return { aegisChainlinkOracleV3Address, deployer: deployer.address, initialOwner, operators }
}

// Handle script execution
if (require.main === module) {
  main()
    .then(() => {
      console.log('\n✅ Deployment completed successfully!')
      process.exit(0)
    })
    .catch((error) => {
      console.error('\n❌ Deployment failed:', error)
      process.exit(1)
    })
}