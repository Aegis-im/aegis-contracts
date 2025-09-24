// scripts/deploy-aegis-config-only.js
const { ethers } = require('hardhat')
const { updateNetworksConfig } = require('../utils/helpers')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get parameters from environment variables or use defaults
  // --------------------------------------------------------------------

  // AegisConfig parameters
  const initialOwner = process.env.INITIAL_OWNER || deployer.address
  console.log('Initial Owner:', initialOwner)
  const trustedSigner = process.env.TRUSTED_SIGNER_ADDRESS || deployer.address
  if (!trustedSigner) {
    throw new Error('Please provide TRUSTED_SIGNER_ADDRESS environment variable')
  }
  console.log('Trusted Signer:', trustedSigner)

  // Initial operators (can be empty array)
  const operators = process.env.OPERATORS ? process.env.OPERATORS.split(',') : [deployer.address]
  console.log('Initial Operators:', operators)

  // --------------------------------------------------------------------
  // DEPLOYMENT SEQUENCE
  // --------------------------------------------------------------------

  // Deploy AegisConfig
  console.log('\nDeploying AegisConfig...')
  const AegisConfig = await ethers.getContractFactory('AegisConfig')
  const aegisConfigContract = await AegisConfig.deploy(trustedSigner, operators, initialOwner)
  await aegisConfigContract.waitForDeployment()
  const aegisConfigAddress = await aegisConfigContract.getAddress()
  console.log('AegisConfig deployed to:', aegisConfigAddress)

  // Update networks.json with new AegisConfig address
  updateNetworksConfig(network.name, {
    aegisConfigAddress: aegisConfigAddress,
  })

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisConfig:', aegisConfigAddress)

  console.log('\nVerification commands:')
  console.log(`npx hardhat verify --network ${network.name} ${aegisConfigAddress} "${trustedSigner}" "[${operators.map(op => `"${op}"`).join(',')}]" "${initialOwner}"`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
