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

  console.log(`Setting pre-collateralized mint limits on ${networkName}`)
  console.log(`Contract: ${await aegisMinting.getAddress()}`)
  console.log(`Caller: ${deployer.address}`)

  const periodDuration = process.env.PERIOD_DURATION
  const maxPeriodAmountBps = process.env.MAX_PERIOD_AMOUNT_BPS

  if (!periodDuration) {
    throw new Error('Please provide PERIOD_DURATION environment variable (in seconds)')
  }

  if (!maxPeriodAmountBps) {
    throw new Error('Please provide MAX_PERIOD_AMOUNT_BPS environment variable (0-10000)')
  }

  const periodDurationValue = Number(periodDuration)
  if (isNaN(periodDurationValue) || periodDurationValue < 0) {
    throw new Error(`Invalid PERIOD_DURATION value: ${periodDuration}. Must be >= 0`)
  }

  const maxPeriodAmountBpsValue = Number(maxPeriodAmountBps)
  if (isNaN(maxPeriodAmountBpsValue) || maxPeriodAmountBpsValue < 0 || maxPeriodAmountBpsValue > 10000) {
    throw new Error(`Invalid MAX_PERIOD_AMOUNT_BPS value: ${maxPeriodAmountBps}. Must be between 0 and 10000`)
  }

  const currentLimits = await aegisMinting.preCollateralizedMintLimit()
  console.log('Current limits:')
  console.log(`  Period duration: ${currentLimits[0]} seconds`)
  console.log(`  Max period amount BPS: ${currentLimits[2]}`)
  console.log('New limits:')
  console.log(`  Period duration: ${periodDurationValue} seconds`)
  console.log(`  Max period amount BPS: ${maxPeriodAmountBpsValue}`)

  // Check if caller has SETTINGS_MANAGER_ROLE
  const SETTINGS_MANAGER_ROLE = ethers.id('SETTINGS_MANAGER_ROLE')
  const hasRole = await aegisMinting.hasRole(SETTINGS_MANAGER_ROLE, deployer.address)
  if (!hasRole) {
    throw new Error(`Caller ${deployer.address} does not have SETTINGS_MANAGER_ROLE. Use scripts/grant-role.js to grant the role first.`)
  }

  if (currentLimits[0] === periodDurationValue && currentLimits[2] === BigInt(maxPeriodAmountBpsValue)) {
    console.log('Values are already set correctly')
    return
  }

  console.log('\nSetting pre-collateralized mint limits...')
  const tx = await aegisMinting.setPreCollateralizedMintLimits(periodDurationValue, maxPeriodAmountBpsValue)
  await tx.wait()

  const newLimits = await aegisMinting.preCollateralizedMintLimit()
  console.log('✅ Pre-collateralized mint limits set:')
  console.log(`  Period duration: ${newLimits[0]} seconds`)
  console.log(`  Max period amount BPS: ${newLimits[2]}`)
  console.log(`Transaction hash: ${tx.hash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

