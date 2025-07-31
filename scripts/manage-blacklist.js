const { ethers, network } = require('hardhat')
const networks = require('../config/networks.json')

// Get network info by name
function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

async function main() {
  const networkName = network.name
  const networkConfig = getNetworkByName(networkName)

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in config`)
  }

  if (!networkConfig.contracts.yusdOftAddress && !networkConfig.contracts.yusdAddress) {
    throw new Error(`yusdOftAddress or yusdAddress not found in network config for ${networkName}`)
  }

  const [deployer] = await ethers.getSigners()
  const isOFT = networkConfig.contracts.yusdOftAddress
  const yusd = await ethers.getContractAt(
    isOFT ? 'YUSDOFT' : 'YUSD',
    isOFT ? networkConfig.contracts.yusdOftAddress : networkConfig.contracts.yusdAddress,
  )

  console.log(`🔧 Managing YUSDOFT blacklist on ${networkName}`)
  console.log(`📄 Contract address: ${await yusd.getAddress()}`)
  console.log(`👤 Deployer: ${deployer.address}`)

  // Check if deployer is owner
  const owner = await yusd.owner()
  if (owner !== deployer.address) {
    throw new Error('Deployer is not the owner of the contract')
  }

  // Parse environment variables
  const addAddress = process.env.ADD
  const removeAddress = process.env.REMOVE

  if (!addAddress && !removeAddress) {
    console.log(
      '❌ Usage: ADD=<address> REMOVE=<address> npx hardhat run scripts/manage-blacklist.js --network <network>',
    )
    console.log('⚠️  At least one of ADD or REMOVE must be provided')
    return
  }

  if (addAddress) {
    console.log(`\n🚫 Adding ${addAddress} to blacklist...`)
    const tx = await yusd.addBlackList(addAddress)
    await tx.wait()
    console.log('✅ Address added to blacklist successfully')

    const status = await yusd.getBlackListStatus(addAddress)
    console.log(`📊 ${addAddress} blacklist status: ${status}`)
  }

  if (removeAddress) {
    console.log(`\n✅ Removing ${removeAddress} from blacklist...`)
    const tx = await yusd.removeBlackList(removeAddress)
    await tx.wait()
    console.log('✅ Address removed from blacklist successfully')

    const status = await yusd.getBlackListStatus(removeAddress)
    console.log(`📊 ${removeAddress} blacklist status: ${status}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
