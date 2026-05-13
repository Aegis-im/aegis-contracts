// scripts/deploy-aegis-rewards-v2-yusd.js
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
  console.log(`Deploying AegisRewardsV2 (YUSD) on ${networkName}...`)
  console.log('Deployer:', deployer.address)

  const networksConfig = getNetworksConfig()
  if (!networksConfig || !networksConfig.networks[networkName]) {
    throw new Error(`Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = networksConfig.networks[networkName]
  const contracts = networkConfig.contracts || {}

  const yusdAddress = contracts.yusdAddress || contracts.yusdOftAddress
  if (!yusdAddress) {
    throw new Error(`YUSD address not found in config for network ${networkName}`)
  }

  const admin = contracts.adminAddress || deployer.address
  const deployment = networkConfig.deployment || {}
  const rescueTo =
    deployment.insuranceFundAddress?.replace('{DEPLOYER_ADDRESS}', deployer.address) ||
    contracts.adminAddress ||
    deployer.address
  // On testnets other than sepolia, this is NOT the main chain (mainnet = Ethereum).
  // For Avalanche Fuji specifically, set isMainChain = false.
  const isMainChain = networkName === 'mainnet' || networkName === 'sepolia'

  console.log('Parameters:')
  console.log(`  YUSD: ${yusdAddress}`)
  console.log(`  Admin: ${admin}`)
  console.log(`  isMainChain: ${isMainChain}`)
  console.log(`  rescueTo: ${rescueTo}`)

  const AegisRewardsV2 = await ethers.getContractFactory('AegisRewardsV2')
  const contract = await AegisRewardsV2.deploy(yusdAddress, admin, isMainChain, rescueTo)
  await contract.waitForDeployment()
  const address = await contract.getAddress()

  console.log('AegisRewardsV2 deployed to:', address)

  updateNetworksConfig(networkName, {
    aegisRewardsV2Address: address,
  })

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisRewardsV2:', address)
  console.log('\nVerification command:')
  console.log(
    `npx hardhat verify --network ${networkName} ${address} "${yusdAddress}" "${admin}" ${isMainChain} "${rescueTo}"`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
