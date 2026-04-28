// scripts/deploy-aegis-rewards-v2.js
const { ethers } = require('hardhat')
const fs = require('fs')
const path = require('path')

function getNetworksConfig() {
  const configPath = path.join(__dirname, '..', 'config', 'networks.json')
  return JSON.parse(fs.readFileSync(configPath, 'utf8'))
}

function updateNetworksConfig(networkName, updates) {
  const configPath = path.join(__dirname, '..', 'config', 'networks.json')
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  Object.assign(config.networks[networkName].contracts, updates)
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const networkName = network.name
  console.log(`Deploying AegisRewardsV2JUSD on ${networkName}...`)
  console.log('Deployer:', deployer.address)

  const networksConfig = getNetworksConfig()
  if (!networksConfig || !networksConfig.networks[networkName]) {
    throw new Error(`Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = networksConfig.networks[networkName]
  const contracts = networkConfig.contracts || {}

  const jusdAddress = contracts.jusdAddress
  if (!jusdAddress) {
    throw new Error(`jusdAddress not found in config for network ${networkName}`)
  }

  const admin = contracts.adminAddress || deployer.address
  const isMainChain = true

  console.log('Parameters:')
  console.log(`  JUSD: ${jusdAddress}`)
  console.log(`  Admin: ${admin}`)
  console.log(`  isMainChain: ${isMainChain}`)

  const AegisRewardsV2JUSD = await ethers.getContractFactory('AegisRewardsV2JUSD')
  const contract = await AegisRewardsV2JUSD.deploy(jusdAddress, admin, isMainChain)
  await contract.waitForDeployment()
  const address = await contract.getAddress()

  console.log('AegisRewardsV2JUSD deployed to:', address)

  updateNetworksConfig(networkName, {
    aegisRewardsV2JUSDAddress: address,
  })

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisRewardsV2JUSD:', address)
  console.log('\nVerification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${address} "${jusdAddress}" "${admin}" ${isMainChain}`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
