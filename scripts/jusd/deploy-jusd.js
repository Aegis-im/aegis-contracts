// scripts/jusd/deploy-jusd.js
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

  // --------------------------------------------------------------------
  // DEPLOYMENT
  // --------------------------------------------------------------------

  console.log('\nDeploying JUSD token...')
  const JUSD = await ethers.getContractFactory('JUSD')
  const jusdContract = await JUSD.deploy(initialOwner)
  await jusdContract.waitForDeployment()
  const jusdAddress = await jusdContract.getAddress()
  console.log('JUSD deployed to:', jusdAddress)

  // Update networks.json
  updateNetworksConfig(network.name, {
    jusdAddress: jusdAddress,
  })

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('JUSD:', jusdAddress)

  console.log('\nVerification command:')
  console.log(`npx hardhat verify --network ${network.name} --contract contracts/JUSD.sol:JUSD ${jusdAddress} "${initialOwner}"`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

