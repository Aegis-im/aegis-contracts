// scripts/deploy-aegis-rewards-manual.js
const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying AegisRewardsManual with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get parameters from environment variables or use defaults
  // --------------------------------------------------------------------

  // 1. YUSD parameters
  const yusdAddress = process.env.YUSD_ADDRESS
  if (!yusdAddress) {
    throw new Error('Please provide YUSD_ADDRESS environment variable')
  }
  console.log('YUSD Address:', yusdAddress)

  // 2. AegisConfig parameters
  const aegisConfigAddress = process.env.AEGIS_CONFIG_ADDRESS
  if (!aegisConfigAddress) {
    throw new Error('Please provide AEGIS_CONFIG_ADDRESS environment variable')
  }
  console.log('AegisConfig Address:', aegisConfigAddress)

  // 3. Admin parameters
  const admin = process.env.ADMIN_ADDRESS || deployer.address
  console.log('Admin Address:', admin)

  // --------------------------------------------------------------------
  // DEPLOYMENT
  // --------------------------------------------------------------------

  // Deploy AegisRewardsManual
  console.log('\nDeploying AegisRewardsManual...')
  const AegisRewardsManual = await ethers.getContractFactory('AegisRewardsManual')
  const aegisRewardsManualContract = await AegisRewardsManual.deploy(yusdAddress, aegisConfigAddress, admin)
  await aegisRewardsManualContract.waitForDeployment()
  const aegisRewardsManualAddress = await aegisRewardsManualContract.getAddress()
  console.log('AegisRewardsManual deployed to:', aegisRewardsManualAddress)

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisRewardsManual:', aegisRewardsManualAddress)

  console.log('\nVerification command:')
  console.log(
    `npx hardhat verify --network ${network.name} ${aegisRewardsManualAddress} "${yusdAddress}" "${aegisConfigAddress}" "${admin}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
