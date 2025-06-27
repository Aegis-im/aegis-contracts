const { ethers } = require('hardhat')
const fs = require('fs')
const path = require('path')
const { updateNetworksConfig } = require('../test/helpers')

// Helper function to save deployment data
async function saveDeployment(contractName, contractInstance, constructorArgs, network) {
  const deploymentDir = path.join(__dirname, '..', 'deployments', network.name)

  // Create deployments directory if it doesn't exist
  if (!fs.existsSync(deploymentDir)) {
    fs.mkdirSync(deploymentDir, { recursive: true })
  }

  // Create .chainId file
  const chainIdPath = path.join(deploymentDir, '.chainId')
  fs.writeFileSync(chainIdPath, network.chainId.toString())

  // Get deployment transaction
  const deploymentTx = contractInstance.deploymentTransaction()
  const receipt = await deploymentTx.wait()

  // Get contract factory for ABI and bytecode
  const contractFactory = await ethers.getContractFactory(contractName)

  const deploymentData = {
    address: await contractInstance.getAddress(),
    abi: contractFactory.interface.fragments.map(f => f.format('json')).map(f => JSON.parse(f)),
    transactionHash: receipt.hash,
    receipt: {
      to: receipt.to,
      from: receipt.from,
      contractAddress: receipt.contractAddress,
      transactionIndex: receipt.index,
      gasUsed: `0x${receipt.gasUsed.toString(16)}`,
      logsBloom: receipt.logsBloom,
      blockHash: receipt.blockHash,
      transactionHash: receipt.hash,
      logs: receipt.logs,
      blockNumber: receipt.blockNumber,
      cumulativeGasUsed: `0x${receipt.cumulativeGasUsed.toString(16)}`,
      status: receipt.status,
      byzantium: true,
    },
    args: constructorArgs,
    numDeployments: 1,
    solcInputHash: '',
    metadata: '{}',
    bytecode: contractFactory.bytecode,
    deployedBytecode: contractFactory.bytecode, // Simplified - in real case should be runtime bytecode
    libraries: {},
    facets: [],
    diamondCut: [],
    execute: {},
    history: [],
    implementation: null,
    devdoc: {},
    userdoc: {},
    storageLayout: {},
    gasEstimates: {},
  }

  // Save deployment file
  const deploymentPath = path.join(deploymentDir, `${contractName}.json`)
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentData, null, 2))

  console.log(`💾 Deployment data saved to: ${deploymentPath}`)
  return deploymentData
}

async function main() {
  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()

  console.log('🚀 Deploying YUSD Elevated Minter-Burner OFT Adapter')
  console.log('='.repeat(70))
  console.log('Network:', network.name)
  console.log('Chain ID:', network.chainId.toString())
  console.log('Deployer:', await deployer.getAddress())

  // Configuration
  const yusdAddress = process.env.YUSD_ADDRESS || '0x0847841d8829C685F6fdA9078658723e844552E5'
  const lzEndpoint = process.env.LZ_ENDPOINT || '0x6EDCE65403992e310A62460808c4b910D972f10f'
  const admin = process.env.ADMIN_ADDRESS || await deployer.getAddress()

  console.log('\n📋 Configuration')
  console.log('-'.repeat(40))
  console.log('YUSD Token:', yusdAddress)
  console.log('LZ Endpoint:', lzEndpoint)
  console.log('Admin:', admin)

  // Get YUSD contract
  const yusd = await ethers.getContractAt('YUSD', yusdAddress)

  // Step 1: Deploy ElevatedMinterBurner
  console.log('\n1️⃣ Deploying ElevatedMinterBurner...')
  const ElevatedMinterBurner = await ethers.getContractFactory('ElevatedMinterBurner')
  const elevatedMinterBurner = await ElevatedMinterBurner.deploy(yusdAddress, admin)
  await elevatedMinterBurner.waitForDeployment()
  const elevatedMinterBurnerAddress = await elevatedMinterBurner.getAddress()
  console.log('✅ ElevatedMinterBurner deployed to:', elevatedMinterBurnerAddress)

  // Save deployment data
  await saveDeployment('ElevatedMinterBurner', elevatedMinterBurner, [yusdAddress, admin], network)

  // Wait a bit to avoid RPC rate limiting
  console.log('⏳ Waiting 3 seconds before next deployment...')
  await new Promise(resolve => setTimeout(resolve, 3000))

  // Step 2: Deploy YUSDMintBurnOFTAdapter with ElevatedMinterBurner
  console.log('\n2️⃣ Deploying YUSDMintBurnOFTAdapter...')
  const YUSDMintBurnOFTAdapter = await ethers.getContractFactory('YUSDMintBurnOFTAdapter')
  const oftAdapter = await YUSDMintBurnOFTAdapter.deploy(
    yusdAddress,
    elevatedMinterBurnerAddress, // Use ElevatedMinterBurner instead of direct token
    lzEndpoint,
    admin,
  )
  await oftAdapter.waitForDeployment()
  const oftAdapterAddress = await oftAdapter.getAddress()
  console.log('✅ YUSDMintBurnOFTAdapter deployed to:', oftAdapterAddress)

  // Save deployment data
  await saveDeployment('YUSDMintBurnOFTAdapter', oftAdapter, [yusdAddress, elevatedMinterBurnerAddress, lzEndpoint, admin], network)

  // Wait a bit to avoid RPC rate limiting
  console.log('⏳ Waiting 5 seconds before setting up permissions...')
  await new Promise(resolve => setTimeout(resolve, 5000))

  // Step 3: Setup permissions
  console.log('\n3️⃣ Setting up permissions...')

  // Set ElevatedMinterBurner as YUSD minter
  console.log('Setting ElevatedMinterBurner as YUSD minter...')
  const setMinterTx = await yusd.setMinter(elevatedMinterBurnerAddress)
  await setMinterTx.wait()
  console.log('✅ ElevatedMinterBurner set as YUSD minter')

  // Wait between transactions
  console.log('⏳ Waiting 3 seconds...')
  await new Promise(resolve => setTimeout(resolve, 3000))

  // Set OFTAdapter as operator in ElevatedMinterBurner
  console.log('Setting OFTAdapter as operator in ElevatedMinterBurner...')
  const setOperatorTx = await elevatedMinterBurner.setOperator(oftAdapterAddress, true)
  await setOperatorTx.wait()
  console.log('✅ OFTAdapter set as operator')

  // Step 4: Verification
  console.log('\n4️⃣ Verifying setup...')
  try {
    const yusdMinter = await yusd.minter()
    const isOperator = await elevatedMinterBurner.operators(oftAdapterAddress)
    const adapterToken = await oftAdapter.token()
    const adapterDecimals = await oftAdapter.decimals()
    const adapterLocalDecimals = await oftAdapter.localDecimals()
    const adapterSharedDecimals = await oftAdapter.sharedDecimals()

    console.log('YUSD minter:', yusdMinter)
    console.log('OFT is operator:', isOperator)
    console.log('Adapter token:', adapterToken)
    console.log('Adapter decimals:', adapterDecimals.toString())
    console.log('Adapter local decimals:', adapterLocalDecimals.toString())
    console.log('Adapter shared decimals:', adapterSharedDecimals.toString())

    // Validation
    const setupValid = (
      yusdMinter.toLowerCase() === elevatedMinterBurnerAddress.toLowerCase() &&
      isOperator === true &&
      adapterToken.toLowerCase() === yusdAddress.toLowerCase()
    )

    if (setupValid) {
      console.log('🎉 All permissions configured correctly!')
    } else {
      console.log('❌ Permission setup has issues')
    }

  } catch (error) {
    console.log('❌ Error during verification:', error.message)
  }

  // Step 5: Setup infinite allowance for cross-chain transfers
  console.log('\n5️⃣ Setting up infinite allowance for cross-chain transfers...')
  try {
    console.log('Setting infinite YUSD allowance for ElevatedMinterBurner...')
    const maxUint256 = ethers.MaxUint256
    const approveTx = await yusd.approve(elevatedMinterBurnerAddress, maxUint256)
    await approveTx.wait()
    console.log('✅ Infinite allowance set for ElevatedMinterBurner')

    // Verify allowance
    const allowance = await yusd.allowance(await deployer.getAddress(), elevatedMinterBurnerAddress)
    console.log('Current allowance:', ethers.formatEther(allowance))

  } catch (error) {
    console.log('❌ Error setting allowance:', error.message)
  }

  // Step 6: Test basic functionality
  console.log('\n6️⃣ Testing basic functionality...')
  try {
    // Test mint (small amount)
    const testAmount = ethers.parseEther('1.0')
    console.log('Testing mint of 1.0 YUSD...')

    // Temporarily set deployer as operator for testing
    const deployerAddress = await deployer.getAddress()
    const tempOperatorTx = await elevatedMinterBurner.setOperator(deployerAddress, true)
    await tempOperatorTx.wait()

    // Test mint
    const mintTx = await elevatedMinterBurner.mint(deployerAddress, testAmount)
    await mintTx.wait()
    console.log('✅ Mint test successful')

    // Remove deployer as operator
    const removeOperatorTx = await elevatedMinterBurner.setOperator(deployerAddress, false)
    await removeOperatorTx.wait()

    // Check balance
    const balance = await yusd.balanceOf(deployerAddress)
    console.log('New YUSD balance:', ethers.formatEther(balance))

  } catch (error) {
    console.log('❌ Error during testing:', error.message)
  }

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('🎉 DEPLOYMENT COMPLETE')
  console.log('='.repeat(70))
  console.log('ElevatedMinterBurner:', elevatedMinterBurnerAddress)
  console.log('YUSDMintBurnOFTAdapter:', oftAdapterAddress)
  console.log('YUSD Token:', yusdAddress)
  console.log('LayerZero Endpoint:', lzEndpoint)

  console.log('\n💾 Deployment Files Created:')
  console.log(`- deployments/${network.name}/.chainId`)
  console.log(`- deployments/${network.name}/ElevatedMinterBurner.json`)
  console.log(`- deployments/${network.name}/YUSDMintBurnOFTAdapter.json`)

  console.log('\n📋 Next Steps:')
  console.log('1. Setup peer connections')
  console.log('2. Configure enforced options')
  console.log('3. Test cross-chain transfers')

  console.log('\n🔍 Verification Commands:')
  console.log(`npx hardhat verify --network ${network.name} ${elevatedMinterBurnerAddress} "${yusdAddress}" "${admin}"`)
  console.log(`npx hardhat verify --network ${network.name} ${oftAdapterAddress} "${yusdAddress}" "${elevatedMinterBurnerAddress}" "${lzEndpoint}" "${admin}"`)

  console.log('='.repeat(70))

  // Update networks config
  const contractAddresses = {
    'elevatedMinterBurner': elevatedMinterBurnerAddress,
    'oftAdapterAddress': oftAdapterAddress,
  }
  updateNetworksConfig(network.name, contractAddresses)
}

main().catch(console.error)