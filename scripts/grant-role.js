const { ethers, network } = require('hardhat')
const networks = require('../config/networks.json')

function getNetworkByName(networkName) {
  return networks.networks[networkName]
}

async function grantRoleToContract(contract, contractName, roleHash, roleName, targetAddress) {
  const hasRole = await contract.hasRole(roleHash, targetAddress)
  console.log(`\n${targetAddress} has ${roleName} in ${contractName}: ${hasRole}`)

  if (hasRole) {
    console.log(`✅ Address already has ${roleName} in ${contractName}`)
    return true
  }

  console.log(`Granting ${roleName} in ${contractName}...`)
  const tx = await contract.grantRole(roleHash, targetAddress)
  await tx.wait()

  const newHasRole = await contract.hasRole(roleHash, targetAddress)
  console.log(`✅ ${roleName} granted in ${contractName}: ${newHasRole}`)
  return newHasRole
}

async function main() {
  const networkName = network.name
  const networkConfig = getNetworkByName(networkName)

  if (!networkConfig) {
    throw new Error(`Network ${networkName} not found in config`)
  }

  const [deployer] = await ethers.getSigners()
  console.log(`Granting roles on ${networkName}`)
  console.log(`Deployer: ${deployer.address}`)

  const targetAddress = process.env.TARGET_ADDRESS || deployer.address
  const roleName = process.env.ROLE || 'SETTINGS_MANAGER_ROLE'
  const contractType = process.env.CONTRACT || 'both' // 'aegisMinting', 'aegisMintingJUSD', or 'both'

  if (!targetAddress) {
    console.log('\nUsage: TARGET_ADDRESS=<address> ROLE=<role_name> CONTRACT=<contract_type> npx hardhat run scripts/grant-role.js --network <network>')
    console.log('\nAvailable roles:')
    console.log('- SETTINGS_MANAGER_ROLE (default)')
    console.log('- FUNDS_MANAGER_ROLE')
    console.log('- COLLATERAL_MANAGER_ROLE')
    console.log('\nAvailable contracts:')
    console.log('- aegisMinting')
    console.log('- aegisMintingJUSD')
    console.log('- both (default)')
    return
  }

  const ROLES = {
    SETTINGS_MANAGER_ROLE: ethers.id('SETTINGS_MANAGER_ROLE'),
    FUNDS_MANAGER_ROLE: ethers.id('FUNDS_MANAGER_ROLE'),
    COLLATERAL_MANAGER_ROLE: ethers.id('COLLATERAL_MANAGER_ROLE'),
  }

  const roleHash = ROLES[roleName]
  if (!roleHash) {
    throw new Error(`Unknown role: ${roleName}`)
  }

  console.log(`\nTarget Address: ${targetAddress}`)
  console.log(`Role: ${roleName}`)
  console.log(`Contract: ${contractType}`)

  // Grant role to AegisMinting contract
  if ((contractType === 'aegisMinting' || contractType === 'both') && networkConfig.contracts.aegisMintingAddress) {
    console.log('\n=== AegisMinting Contract ===')
    const aegisMinting = await ethers.getContractAt('AegisMinting', networkConfig.contracts.aegisMintingAddress)
    console.log(`Contract: ${await aegisMinting.getAddress()}`)

    await grantRoleToContract(aegisMinting, 'AegisMinting', roleHash, roleName, targetAddress)
  } else if (contractType === 'aegisMinting') {
    console.log('⚠️  AegisMinting contract not found in network config')
  }

  // Grant role to AegisMintingJUSD contract
  if ((contractType === 'aegisMintingJUSD' || contractType === 'both') && networkConfig.contracts.aegisMintingJUSDAddress) {
    console.log('\n=== AegisMintingJUSD Contract ===')
    const aegisMintingJUSD = await ethers.getContractAt('AegisMintingJUSD', networkConfig.contracts.aegisMintingJUSDAddress)
    console.log(`Contract: ${await aegisMintingJUSD.getAddress()}`)

    await grantRoleToContract(aegisMintingJUSD, 'AegisMintingJUSD', roleHash, roleName, targetAddress)
  } else if (contractType === 'aegisMintingJUSD') {
    console.log('⚠️  AegisMintingJUSD contract not found in network config')
  }

  console.log('\n=======================================')
  console.log('ROLE GRANTING SUMMARY')
  console.log('=======================================')
  console.log(`Target Address: ${targetAddress}`)
  console.log(`Role: ${roleName}`)
  console.log(`Network: ${networkName}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

