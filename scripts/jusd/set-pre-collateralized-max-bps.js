const { ethers, network } = require('hardhat')
const networks = require('../../config/networks.json')

function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

async function main() {
  const networkName = network.name
  const networkConfig = getNetworkByName(networkName)

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in config`)
  }

  if (!networkConfig.contracts.aegisMintingJUSDAddress) {
    throw new Error(`aegisMintingJUSDAddress not found in network config for ${networkName}`)
  }

  const [deployer] = await ethers.getSigners()
  const aegisMinting = await ethers.getContractAt('AegisMintingJUSD', networkConfig.contracts.aegisMintingJUSDAddress)

  console.log(`Setting pre-collateralized max BPS on ${networkName}`)
  console.log(`Contract: ${await aegisMinting.getAddress()}`)
  console.log(`Caller: ${deployer.address}`)

  const maxBps = process.env.PRE_COLLATERALIZED_MAX_BPS
  if (!maxBps) {
    throw new Error('Please provide PRE_COLLATERALIZED_MAX_BPS environment variable')
  }

  const maxBpsValue = Number(maxBps)
  if (isNaN(maxBpsValue) || maxBpsValue < 0 || maxBpsValue > 10000) {
    throw new Error(`Invalid PRE_COLLATERALIZED_MAX_BPS value: ${maxBps}. Must be between 0 and 10000`)
  }

  const currentMaxBps = await aegisMinting.preCollateralizedMaxBps()
  console.log(`\nCurrent pre-collateralized max BPS: ${currentMaxBps}`)
  console.log(`New pre-collateralized max BPS: ${maxBpsValue}`)

  // Check if caller has SETTINGS_MANAGER_ROLE
  const SETTINGS_MANAGER_ROLE = ethers.id('SETTINGS_MANAGER_ROLE')
  const hasRole = await aegisMinting.hasRole(SETTINGS_MANAGER_ROLE, deployer.address)
  if (!hasRole) {
    throw new Error(`Caller ${deployer.address} does not have SETTINGS_MANAGER_ROLE. Use scripts/grant-role.js to grant the role first.`)
  }

  if (currentMaxBps === maxBpsValue) {
    console.log('Value is already set correctly')
    return
  }

  console.log('\nSetting pre-collateralized max BPS...')
  const tx = await aegisMinting.setPreCollateralizedMaxBps(maxBpsValue)
  await tx.wait()

  const newMaxBps = await aegisMinting.preCollateralizedMaxBps()
  console.log(`✅ Pre-collateralized max BPS set: ${newMaxBps}`)
  console.log(`Transaction hash: ${tx.hash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

