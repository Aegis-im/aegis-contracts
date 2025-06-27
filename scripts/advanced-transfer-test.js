const { ethers } = require('hardhat')
const { getNetworksConfig } = require('../test/helpers')

/**
 * Advanced Cross-Chain Transfer Test & Diagnostics
 * 
 * Usage:
 * npx hardhat run scripts/advanced-transfer-test.js --network <source-network>
 * 
 * Environment variables:
 * - TARGET_NETWORK: Target network name (e.g., "sepolia", "bnbTestnet", "avalancheFuji")
 * - TRANSFER_AMOUNT: Amount to transfer in YUSD (default: 1.0)
 * - DRY_RUN: Set to "true" to only show quote without executing transfer (default: false)
 * 
 * Example:
 * TARGET_NETWORK=avalancheFuji TRANSFER_AMOUNT=3.5 npx hardhat run scripts/advanced-transfer-test.js --network sepolia
 */

// Network configurations with LayerZero endpoints
const SUPPORTED_NETWORKS = {
  sepolia: {
    chainId: 11155111,
    name: 'Ethereum Sepolia Testnet',
    nativeToken: 'ETH',
    lzEndpointId: 40161,
    explorer: 'https://sepolia.etherscan.io',
  },
  bnbTestnet: {
    chainId: 97,
    name: 'BNB Smart Chain Testnet',
    nativeToken: 'BNB',
    lzEndpointId: 40102,
    explorer: 'https://testnet.bscscan.com',
  },
  avalancheFuji: {
    chainId: 43113,
    name: 'Avalanche Fuji Testnet',
    nativeToken: 'AVAX',
    lzEndpointId: 40106,
    explorer: 'https://testnet.snowtrace.io',
  },
}

// Get network info by chain ID
function getNetworkInfo(chainId) {
  return Object.values(SUPPORTED_NETWORKS).find(network => network.chainId === parseInt(chainId))
}

// Get network info by name
function getNetworkByName(networkName) {
  return SUPPORTED_NETWORKS[networkName]
}

// Get network config from networks.json
function getNetworkConfig(networkName) {
  const networksConfig = getNetworksConfig()
  if (!networksConfig) return null
  return networksConfig.networks[networkName]
}

async function main() {
  console.log('🧪 Advanced Cross-Chain Transfer Test & Diagnostics')
  console.log('='.repeat(70))

  const [deployer] = await ethers.getSigners()
  const network = await ethers.provider.getNetwork()
  const chainId = Number(network.chainId)

  console.log('Deployer:', await deployer.getAddress())
  console.log('Network:', network.name, 'Chain ID:', chainId)
  console.log('Block Number:', await ethers.provider.getBlockNumber())
  console.log('Timestamp:', new Date().toISOString())

  // Get current network info
  const currentNetworkInfo = getNetworkInfo(chainId)
  if (!currentNetworkInfo) {
    console.log('❌ Unsupported network for this test')
    console.log('Supported networks:')
    Object.entries(SUPPORTED_NETWORKS).forEach(([name, info]) => {
      console.log(`  - ${name}: ${info.name} (${info.chainId})`)
    })
    return
  }

  // Get target network from environment
  const targetNetworkName = process.env.TARGET_NETWORK
  if (!targetNetworkName) {
    console.log('❌ TARGET_NETWORK environment variable is required')
    console.log('Available target networks:')
    Object.keys(SUPPORTED_NETWORKS)
      .filter(name => name !== network.name)
      .forEach(name => console.log(`  - ${name}`))
    console.log('\nExample: TARGET_NETWORK=avalancheFuji npx hardhat run scripts/advanced-transfer-test.js --network sepolia')
    return
  }

  const targetNetworkInfo = getNetworkByName(targetNetworkName)
  if (!targetNetworkInfo) {
    console.log(`❌ Invalid target network: ${targetNetworkName}`)
    return
  }

  if (targetNetworkInfo.chainId === chainId) {
    console.log('❌ Source and target networks cannot be the same')
    return
  }

  // Get network configurations
  const sourceConfig = getNetworkConfig(network.name)
  const targetConfig = getNetworkConfig(targetNetworkName)

  if (!sourceConfig?.contracts || !targetConfig?.contracts) {
    console.log('❌ Network configuration missing for source or target network')
    return
  }

  // Parse transfer amount
  const transferAmountStr = process.env.TRANSFER_AMOUNT || '1.0'
  const transferAmount = ethers.parseEther(transferAmountStr)
  const isDryRun = process.env.DRY_RUN === 'true'

  console.log(`\n📋 Transfer Configuration`)
  console.log('='.repeat(50))
  console.log('Source Network:', currentNetworkInfo.name)
  console.log('Target Network:', targetNetworkInfo.name)
  console.log('Transfer Amount:', transferAmountStr, 'YUSD')
  console.log('Mode:', isDryRun ? 'DRY RUN (quote only)' : 'EXECUTE TRANSFER')
  console.log('Source EID:', currentNetworkInfo.lzEndpointId)
  console.log('Target EID:', targetNetworkInfo.lzEndpointId)

  // Contract instances
  const yusd = await ethers.getContractAt('YUSD', sourceConfig.contracts.yusdAddress)
  const oftAdapter = await ethers.getContractAt('YUSDMintBurnOFTAdapter', sourceConfig.contracts.oftAdapterAddress)

  // Check initial state
  console.log('\n💰 Initial State Check')
  console.log('-'.repeat(40))
  const deployerAddress = await deployer.getAddress()
  const nativeBalance = await ethers.provider.getBalance(deployerAddress)
  const yusdBalance = await yusd.balanceOf(deployerAddress)
  const allowance = await yusd.allowance(deployerAddress, sourceConfig.contracts.oftAdapterAddress)

  console.log(`${currentNetworkInfo.nativeToken} Balance:`, ethers.formatEther(nativeBalance))
  console.log('YUSD Balance:', ethers.formatEther(yusdBalance))
  console.log('YUSD Allowance:', ethers.formatEther(allowance))

  // Validate prerequisites
  if (yusdBalance < transferAmount) {
    console.log('❌ Insufficient YUSD balance for transfer')
    return
  }

  if (allowance < transferAmount) {
    console.log('⚠️  Insufficient allowance. Approving tokens...')
    const approveTx = await yusd.approve(sourceConfig.contracts.oftAdapterAddress, ethers.MaxUint256)
    await approveTx.wait()
    console.log('✅ Tokens approved')
  }

  // Transfer parameters
  const sendParam = {
    dstEid: targetNetworkInfo.lzEndpointId,
    to: ethers.zeroPadValue(deployerAddress, 32),
    amountLD: transferAmount,
    minAmountLD: transferAmount,
    extraOptions: '0x',
    composeMsg: '0x',
    oftCmd: '0x',
  }

  console.log('\n📤 Transfer Parameters')
  console.log('-'.repeat(40))
  console.log('Amount:', transferAmountStr, 'YUSD')
  console.log('Destination EID:', targetNetworkInfo.lzEndpointId)
  console.log('To Address:', deployerAddress)

  // Contract Methods Verification
  console.log('\n🔍 CONTRACT METHODS VERIFICATION')
  console.log('='.repeat(50))

  const tests = [
    { name: 'token()', method: () => oftAdapter.token() },
    { name: 'decimals()', method: () => oftAdapter.decimals() },
    { name: 'localDecimals()', method: () => oftAdapter.localDecimals() },
    { name: 'sharedDecimals()', method: () => oftAdapter.sharedDecimals() },
    { name: `peers(${targetNetworkInfo.lzEndpointId})`, method: () => oftAdapter.peers(targetNetworkInfo.lzEndpointId) },
    { name: 'owner()', method: () => oftAdapter.owner() },
  ]

  let contractsValid = true
  for (const test of tests) {
    try {
      const result = await test.method()
      if (test.name === 'token()') {
        const isValid = result.toLowerCase() === sourceConfig.contracts.yusdAddress.toLowerCase()
        console.log(`${isValid ? '✅' : '❌'} ${test.name}:`, result, isValid ? '' : '(MISMATCH)')
        if (!isValid) contractsValid = false
      } else if (test.name.startsWith('peers(')) {
        const peerAddress = result === '0x0000000000000000000000000000000000000000000000000000000000000000' 
          ? 'Not Set' 
          : ethers.getAddress(ethers.dataSlice(result, 12))
        const expectedPeer = targetConfig.contracts.oftAdapterAddress
        const isValid = peerAddress.toLowerCase() === expectedPeer.toLowerCase()
        console.log(`${isValid ? '✅' : '❌'} ${test.name}:`, peerAddress, isValid ? '' : '(MISMATCH)')
        if (!isValid) contractsValid = false
      } else {
        console.log(`✅ ${test.name}:`, result.toString())
      }
    } catch (error) {
      console.log(`❌ ${test.name}: FAILED`)
      console.log('   Error:', error.message)
      contractsValid = false
    }
  }

  if (!contractsValid) {
    console.log('\n❌ Contract validation failed. Please check configuration.')
    return
  }

  // Quote Send Test
  console.log('\n🔍 QUOTE SEND TEST')
  console.log('='.repeat(50))

  try {
    console.log('Calling quoteSend...')
    const quote = await oftAdapter.quoteSend(sendParam, false)
    console.log('✅ QuoteSend SUCCESS!')
    console.log(`Native Fee: ${ethers.formatEther(quote.nativeFee)} ${currentNetworkInfo.nativeToken}`)
    console.log('LZ Token Fee:', quote.lzTokenFee.toString())

    // Check if user has enough native tokens for fees
    if (nativeBalance < quote.nativeFee) {
      console.log(`❌ Insufficient ${currentNetworkInfo.nativeToken} for LayerZero fees`)
      console.log(`Required: ${ethers.formatEther(quote.nativeFee)} ${currentNetworkInfo.nativeToken}`)
      console.log(`Available: ${ethers.formatEther(nativeBalance)} ${currentNetworkInfo.nativeToken}`)
      return
    }

    if (isDryRun) {
      console.log('\n🏁 DRY RUN COMPLETED')
      console.log('Transfer would succeed with quoted fee')
      return
    }

    // Actual Transfer Execution
    console.log('\n🚀 EXECUTING CROSS-CHAIN TRANSFER')
    console.log('='.repeat(50))

    try {
      // Estimate gas
      console.log('Estimating gas...')
      const gasEstimate = await oftAdapter.send.estimateGas(
        sendParam,
        { nativeFee: quote.nativeFee, lzTokenFee: quote.lzTokenFee },
        deployerAddress,
        { value: quote.nativeFee }
      )
      console.log('Gas Estimate:', gasEstimate.toString())

      // Execute transfer
      console.log('Executing transfer...')
      const tx = await oftAdapter.send(
        sendParam,
        { nativeFee: quote.nativeFee, lzTokenFee: quote.lzTokenFee },
        deployerAddress,
        {
          value: quote.nativeFee,
          gasLimit: gasEstimate * 120n / 100n, // 20% buffer
        }
      )

      console.log('✅ TRANSFER TRANSACTION SUBMITTED!')
      console.log('Transaction Hash:', tx.hash)
      console.log(`Explorer: ${currentNetworkInfo.explorer}/tx/${tx.hash}`)
      console.log('Waiting for confirmation...')

      const receipt = await tx.wait()
      console.log('✅ TRANSACTION CONFIRMED!')
      console.log('Block Number:', receipt.blockNumber)
      console.log('Gas Used:', receipt.gasUsed.toString())

      // Final balances
      console.log('\n💰 Final State')
      console.log('-'.repeat(40))
      const finalNativeBalance = await ethers.provider.getBalance(deployerAddress)
      const finalYusdBalance = await yusd.balanceOf(deployerAddress)

      console.log(`${currentNetworkInfo.nativeToken} Balance:`, ethers.formatEther(finalNativeBalance))
      console.log('YUSD Balance:', ethers.formatEther(finalYusdBalance))
      console.log(`${currentNetworkInfo.nativeToken} Used:`, ethers.formatEther(nativeBalance - finalNativeBalance))
      console.log('YUSD Transferred:', ethers.formatEther(yusdBalance - finalYusdBalance))

      // LayerZero tracking
      console.log('\n🔗 LAYERZERO TRACKING')
      console.log('='.repeat(50))
      console.log('LayerZero Scan:', 'https://testnet.layerzeroscan.com/')
      console.log(`Search by transaction hash: ${tx.hash}`)
      console.log(`Source: ${currentNetworkInfo.name} → Target: ${targetNetworkInfo.name}`)
      console.log('Expected delivery time: 1-5 minutes')

    } catch (sendError) {
      console.log('❌ TRANSFER EXECUTION FAILED')
      await handleTransactionError(sendError, 'send', sourceConfig.contracts.oftAdapterAddress)
    }

  } catch (quoteError) {
    console.log('❌ QUOTE SEND FAILED')
    await handleTransactionError(quoteError, 'quoteSend', sourceConfig.contracts.oftAdapterAddress)
  }
}

async function handleTransactionError(error, operation, contractAddress) {
  console.log(`\n🔍 DETAILED ERROR ANALYSIS - ${operation.toUpperCase()}`)
  console.log('='.repeat(60))

  console.log('Error Type:', error.constructor.name)
  console.log('Error Message:', error.message)

  if (error.data) {
    console.log('\n📜 ERROR DATA ANALYSIS:')
    console.log('Raw Error Data:', error.data)

    try {
      if (error.data.startsWith('0x08c379a0')) {
        // Standard revert with message
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + error.data.slice(10))
        console.log('Decoded Error Message:', decoded[0])
      } else if (error.data.startsWith('0x4e487b71')) {
        // Panic error
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + error.data.slice(10))
        console.log('Panic Code:', decoded[0].toString())
      } else {
        console.log('Custom Error or Unknown Format')
        console.log('Use cast 4byte-decode for analysis:', error.data)
      }
    } catch (decodeError) {
      console.log('Failed to decode error data')
    }
  }

  if (error.transaction) {
    console.log('\n📤 TRANSACTION INFO:')
    console.log('To:', error.transaction.to)
    console.log('Value:', error.transaction.value?.toString() || '0')
    console.log('Gas Limit:', error.transaction.gasLimit?.toString() || 'N/A')
  }

  console.log('\n🔧 DEBUG COMMANDS:')
  console.log(`cast call ${contractAddress} "localDecimals()" --rpc-url <RPC_URL>`)
  console.log(`cast call ${contractAddress} "sharedDecimals()" --rpc-url <RPC_URL>`)
}

main().catch(console.error)