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

  console.log(`Setting pre-collateralized minter on ${networkName}`)
  console.log(`Contract: ${await aegisMinting.getAddress()}`)
  console.log(`Caller: ${deployer.address}`)

  const minterAddress = process.env.MINTER_ADDRESS || deployer.address

  if (!ethers.isAddress(minterAddress)) {
    throw new Error(`Invalid address: ${minterAddress}`)
  }

  const currentMinter = await aegisMinting.preCollateralizedMinter()
  console.log(`\nCurrent pre-collateralized minter: ${currentMinter}`)
  console.log(`New pre-collateralized minter: ${minterAddress}`)

  if (currentMinter.toLowerCase() === minterAddress.toLowerCase()) {
    console.log('Address is already set as pre-collateralized minter')
    return
  }

  console.log('\nSetting pre-collateralized minter...')
  const tx = await aegisMinting.setPreCollateralizedMinter(minterAddress)
  await tx.wait()

  const newMinter = await aegisMinting.preCollateralizedMinter()
  console.log(`✅ Pre-collateralized minter set: ${newMinter}`)
  console.log(`Transaction hash: ${tx.hash}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

