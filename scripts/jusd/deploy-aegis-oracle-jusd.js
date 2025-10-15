// scripts/jusd/deploy-aegis-oracle-jusd.js
const { ethers } = require('hardhat')
const { updateNetworksConfig } = require('../../utils/helpers')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get parameters from environment variables or use defaults
  // --------------------------------------------------------------------

  const initialOwner = process.env.INITIAL_OWNER || deployer.address
  console.log('Initial Owner:', initialOwner)

  // Initial operators (can be empty array)
  const operators = process.env.OPERATORS ? process.env.OPERATORS.split(',') : []
  console.log('Initial Operators:', operators)

  // --------------------------------------------------------------------
  // DEPLOYMENT
  // --------------------------------------------------------------------

  console.log('\nDeploying AegisOracleJUSD...')
  const AegisOracleJUSD = await ethers.getContractFactory('AegisOracleJUSD')
  const aegisOracleJUSDContract = await AegisOracleJUSD.deploy(operators, initialOwner)
  await aegisOracleJUSDContract.waitForDeployment()
  const aegisOracleJUSDAddress = await aegisOracleJUSDContract.getAddress()
  console.log('AegisOracleJUSD deployed to:', aegisOracleJUSDAddress)

  // Update networks.json
  updateNetworksConfig(network.name, {
    aegisOracleJUSDAddress: aegisOracleJUSDAddress,
  })

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisOracleJUSD:', aegisOracleJUSDAddress)

  console.log('\nVerification command:')
  if (operators.length === 0) {
    console.log(`npx hardhat verify --network ${network.name} --contract contracts/AegisOracleJUSD.sol:AegisOracleJUSD ${aegisOracleJUSDAddress} --constructor-args aegis-oracle-jusd-args.js`)
    console.log('\nCreate aegis-oracle-jusd-args.js with content:')
    console.log(`module.exports = [
  [],
  "${initialOwner}"
];`)
  } else {
    console.log(`npx hardhat verify --network ${network.name} --contract contracts/AegisOracleJUSD.sol:AegisOracleJUSD ${aegisOracleJUSDAddress} "[${operators.map(op => `"${op}"`).join(',')}]" "${initialOwner}"`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

