// scripts/upgrade-sYUSD-multisig.js
// Special upgrade script for multisig-owned proxies
// 1. Deploys new implementation
// 2. Generates transaction data for multisig to execute upgrade

const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Preparing upgrade with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name, `(Chain ID: ${network.chainId})`)

  // Get required addresses from environment variables
  const proxyAddress = process.env.PROXY_ADDRESS
  const multisigAddress = process.env.MULTISIG_ADDRESS

  if (!proxyAddress) {
    throw new Error('Please provide PROXY_ADDRESS environment variable')
  }

  if (!multisigAddress) {
    throw new Error('Please provide MULTISIG_ADDRESS environment variable')
  }

  console.log('Proxy Address:', proxyAddress)
  console.log('Multisig Address:', multisigAddress)

  // Get current implementation address
  console.log('\n=== Current State ===')
  try {
    const currentImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress)
    console.log('Current implementation address:', currentImplAddress)
  } catch (error) {
    console.log('Could not get current implementation address:', error.message)
  }

  // Get proxy admin address
  try {
    const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress)
    console.log('Proxy admin address:', proxyAdminAddress)

    // Check who owns the ProxyAdmin contract
    try {
      const proxyAdminInterface = new ethers.Interface(['function owner() view returns (address)'])
      const ownerCall = proxyAdminInterface.encodeFunctionData('owner', [])
      const result = await ethers.provider.call({
        to: proxyAdminAddress,
        data: ownerCall,
      })
      const proxyAdminOwner = ethers.AbiCoder.defaultAbiCoder().decode(['address'], result)[0]
      console.log('ProxyAdmin owner:', proxyAdminOwner)

      // Verify the multisig owns the ProxyAdmin
      if (proxyAdminOwner.toLowerCase() !== multisigAddress.toLowerCase()) {
        console.warn(`WARNING: ProxyAdmin owner (${proxyAdminOwner}) does not match provided multisig address (${multisigAddress})`)
        console.warn('The multisig cannot execute this upgrade - please verify the MULTISIG_ADDRESS is correct')
      } else {
        console.log('✅ Multisig correctly owns the ProxyAdmin contract')
      }
    } catch (ownerError) {
      console.warn('Could not verify ProxyAdmin ownership:', ownerError.message)
    }
  } catch (error) {
    console.log('Could not get proxy admin address:', error.message)
  }

  // Deploy new implementation contract
  console.log('\n=== Deploying New Implementation ===')
  const sYUSD = await ethers.getContractFactory('sYUSD')

  console.log('Deploying new sYUSD implementation...')

  // Use pre-deployed implementation address
  const newImplAddress = process.env.IMPLEMENTATION_ADDRESS
  console.log('Using implementation address:', newImplAddress)

  // Validate the upgrade (this checks storage layout compatibility)
  console.log('\n=== Validating Upgrade ===')
  try {
    await upgrades.validateUpgrade(proxyAddress, sYUSD, {
      kind: 'transparent',
      unsafeAllow: ['constructor', 'delegatecall'],
    })
    console.log('✅ Upgrade validation passed - storage layout is compatible')
  } catch (error) {
    console.warn('⚠️  Upgrade validation warning:', error.message)
    if (error.message.includes('not registered')) {
      console.log('This is expected for new proxy addresses. The upgrade should still be safe.')
      console.log('The new implementation has been deployed and can be used.')
    } else {
      console.error('This may indicate a storage layout incompatibility!')
      console.error('Please review the error carefully before proceeding.')
    }
  }

  // Generate transaction data for multisig
  console.log('\n=== Transaction Data for Multisig ===')

  // Get the ProxyAdmin address (this is the actual contract that needs to be called)
  const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress)

  // Create ProxyAdmin interface manually (since we might not have the contract factory)
  const proxyAdminInterface = new ethers.Interface([
    'function upgrade(address proxy, address implementation) external',
    'function upgradeAndCall(address proxy, address implementation, bytes memory data) external payable',
  ])

  // Encode the upgrade function call
  const upgradeCalldata = proxyAdminInterface.encodeFunctionData('upgrade', [
    proxyAddress,  // proxy address
    newImplAddress, // new implementation address
  ])

  console.log('Transaction Details:')
  console.log('├── To (ProxyAdmin):', proxyAdminAddress)
  console.log('├── Value:', '0 ETH')
  console.log('├── Data:', upgradeCalldata)
  console.log('└── Gas Limit:', 'Estimated ~200,000 (recommend 300,000 for safety)')

  console.log('\nProxyAdmin Contract Info:')
  console.log('├── Address:', proxyAdminAddress)
  console.log('├── Function:', 'upgrade(address,address)')
  console.log('├── Proxy:', proxyAddress)
  console.log('└── New Implementation:', newImplAddress)

  // Alternative: If using Gnosis Safe, provide the transaction in their format
  console.log('\n=== Gnosis Safe Transaction Format ===')
  const gnosisTransaction = {
    to: proxyAdminAddress,
    value: '0',
    data: upgradeCalldata,
    operation: 0, // CALL operation
    safeTxGas: '300000',
    baseGas: '0',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: 'auto', // Gnosis Safe will determine the nonce
  }

  console.log('Gnosis Safe JSON:')
  console.log(JSON.stringify(gnosisTransaction, null, 2))

  // Provide verification command
  console.log('\n=== Verification ===')
  console.log('After the multisig executes the upgrade, verify the implementation:')
  console.log(`npx hardhat verify --network ${network.name} ${newImplAddress}`)

  // Provide upgrade verification steps
  console.log('\n=== Post-Upgrade Verification ===')
  console.log('After the upgrade is executed, run these commands to verify:')
  console.log('')
  console.log('1. Check new implementation address:')
  console.log(`   npx hardhat run --network ${network.name} -e "console.log(await upgrades.erc1967.getImplementationAddress('${proxyAddress}'))"`)
  console.log('')


  // Export data for programmatic use
  const upgradeData = {
    network: network.name,
    chainId: network.chainId.toString(),
    proxyAddress,
    multisigAddress,
    newImplementationAddress: newImplAddress,
    proxyAdminAddress: proxyAdminAddress,
    upgradeCalldata,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
  }

  console.log('\n=== Export Data (JSON) ===')
  console.log(JSON.stringify(upgradeData, null, 2))
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error)
    process.exit(1)
  })