const { ethers, network } = require('hardhat')
const { getNetworksConfig } = require('../utils/helpers')

// Function to decode custom errors
function decodeCustomError(errorData) {
  if (!errorData || errorData === '0x') return null

  const errorSignatures = {
    '0xffa4e618': 'Blacklisted(address)',
    '0x4e487b71': 'Panic(uint256)',
    '0x08c379a0': 'Error(string)',
  }

  const selector = errorData.slice(0, 10)
  const signature = errorSignatures[selector]

  if (signature) {
    try {
      const iface = new ethers.Interface([`error ${signature}`])
      const decoded = iface.parseError(errorData)
      return { signature, decoded }
    } catch (e) {
      return { signature, raw: errorData }
    }
  }

  return { signature: 'Unknown error', raw: errorData }
}

// Network configurations with LayerZero endpoints
const SUPPORTED_NETWORKS = {
  mainnet: {
    chainId: 1,
    name: 'Ethereum Mainnet',
    nativeToken: 'ETH',
    lzEndpointId: 30101,
    explorer: 'https://etherscan.io',
  },
  bnbMainnet: {
    chainId: 56,
    name: 'BNB Smart Chain Mainnet',
    nativeToken: 'BNB',
    lzEndpointId: 30102,
    explorer: 'https://bscscan.com',
  },
  arbitrum: {
    chainId: 42161,
    name: 'Arbitrum Mainnet',
    nativeToken: 'ETH',
    lzEndpointId: 30110,
    explorer: 'https://arbiscan.io',
  },
  katana: {
    chainId: 747474,
    name: 'Katana Mainnet',
    nativeToken: 'ETH',
    lzEndpointId: 30375,
    explorer: 'https://katanascan.com',
  },
  base: {
    chainId: 8453,
    name: 'Base Mainnet',
    nativeToken: 'ETH',
    lzEndpointId: 30184,
    explorer: 'https://basescan.org',
  },
  avalanche: {
    chainId: 43114,
    rpcUrl: 'https://api.avax.network/ext/bc/C/rpc',
    nativeToken: 'AVAX',
    lzEndpointId: 30106,
    explorer: 'https://snowtrace.io',
  },
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
  optimismSepolia: {
    chainId: 11155420,
    name: 'Optimism Sepolia Testnet',
    nativeToken: 'ETH',
    lzEndpointId: 40232,
    explorer: 'https://sepolia-optimism.etherscan.io',
  },
}

// Get network info by name
function getNetworkByName(networkName) {
  return SUPPORTED_NETWORKS[networkName]
}

async function main() {
  // Get network configuration
  function getNetworkConfig(networkName) {
    const networksConfig = getNetworksConfig()
    if (!networksConfig) return null
    return networksConfig.networks[networkName]
  }

  const sourceConfig = getNetworkConfig(network.name)
  if (!sourceConfig) {
    throw new Error(`Network configuration not found for ${network.name}`)
  }

  // Get target network from environment
  const targetNetworkName = process.env.TARGET_NETWORK
  if (!targetNetworkName) {
    console.log('❌ TARGET_NETWORK environment variable is required')
    console.log('Available target networks:')
    Object.keys(SUPPORTED_NETWORKS)
      .filter((name) => name !== network.name)
      .forEach((name) => console.log(`  - ${name}`))
    console.log('\nExample: TARGET_NETWORK=bnbTestnet npx hardhat run scripts/transfer-test.js --network avalancheFuji')
    return
  }

  const targetNetworkInfo = getNetworkByName(targetNetworkName)
  if (!targetNetworkInfo) {
    console.log(`❌ Invalid target network: ${targetNetworkName}`)
    return
  }

  // Parse transfer amount
  const transferAmountStr = process.env.TRANSFER_AMOUNT || '1.0'
  const AMOUNT = ethers.parseEther(transferAmountStr)

  // Read addresses from configuration
  // IF the network is satelite, use the yusdOftAddress for both YUSD_ADDRESS and OFT_ADAPTER_ADDRESS
  const YUSD_ADDRESS = sourceConfig.contracts.yusdAddress || sourceConfig.contracts.yusdOftAddress
  const OFT_ADAPTER_ADDRESS = sourceConfig.contracts.oftAdapterAddress || sourceConfig.contracts.yusdOftAddress

  if (!YUSD_ADDRESS || !OFT_ADAPTER_ADDRESS) {
    throw new Error(`Missing contract addresses in configuration for ${network.name}`)
  }

  const TARGET_EID = targetNetworkInfo.lzEndpointId

  const [signer] = await ethers.getSigners()
  console.log(`🚀 Cross-Chain Transfer Test: ${signer.address}`)
  console.log(`📍 Source Network: ${network.name}`)
  console.log(`📍 Target Network: ${targetNetworkInfo.name}`)
  console.log(`📍 Transfer Amount: ${transferAmountStr} YUSD`)
  console.log(`📍 YUSD Address: ${YUSD_ADDRESS}`)
  console.log(`📍 OFT Adapter Address: ${OFT_ADAPTER_ADDRESS}`)

  // Get contracts
  const yusd = await ethers.getContractAt('IERC20', YUSD_ADDRESS)
  const oftAdapter = await ethers.getContractAt('YUSDMintBurnOFTAdapter', OFT_ADAPTER_ADDRESS)

  // Check balance
  const balance = await yusd.balanceOf(signer.address)
  console.log(`💰 YUSD Balance: ${ethers.formatEther(balance)}`)

  // Validate prerequisites
  if (balance < AMOUNT) {
    console.log('❌ Insufficient YUSD balance for transfer')
    return
  }

  // Approve tokens
  // console.log('📝 Approving tokens...')
  // await yusd.approve(OFT_ADAPTER_ADDRESS, AMOUNT)

  // // Wait 5 seconds between transactions
  // console.log('⏳ Waiting 5 seconds...')
  // await new Promise((resolve) => setTimeout(resolve, 5000))

  // Get quote
  const sendParam = {
    dstEid: TARGET_EID,
    to: ethers.zeroPadValue(signer.address, 32),
    amountLD: AMOUNT,
    minAmountLD: AMOUNT,
    extraOptions: '0x',
    composeMsg: '0x',
    oftCmd: '0x',
  }
  const quote = await oftAdapter.quoteSend(sendParam, false)
  console.log(sendParam)
  const currentNetworkInfo = SUPPORTED_NETWORKS[network.name]
  const nativeToken = currentNetworkInfo?.nativeToken || 'ETH'
  console.log(`💸 Fee: ${ethers.formatEther(quote.nativeFee)} ${nativeToken}`)

  // Estimate gas
  console.log('⛽ Estimating gas...')
  try {
    const gasEstimate = await oftAdapter.send.estimateGas(
      sendParam,
      { nativeFee: quote.nativeFee, lzTokenFee: quote.lzTokenFee },
      signer.address,
      { value: quote.nativeFee },
    )
    console.log(`⛽ Gas Estimate: ${gasEstimate.toString()}`)
    // Execute transfer
    console.log('🔄 Executing transfer...')
    const refundAddress = signer.address
    const tx = await oftAdapter.send(
      sendParam,
      { nativeFee: quote.nativeFee, lzTokenFee: quote.lzTokenFee },
      refundAddress,
      {
        value: quote.nativeFee,
        gasLimit: (gasEstimate * 120n) / 100n, // 20% buffer
      },
    )

    console.log(`✅ Transaction: ${tx.hash}`)
    console.log('LayerZero Scan:', `https://testnet.layerzeroscan.com/tx/${tx.hash}`)
    if (currentNetworkInfo?.explorer) {
      console.log(`${currentNetworkInfo.name} Explorer: ${currentNetworkInfo.explorer}/tx/${tx.hash}`)
    }
    await tx.wait()
    console.log('🎉 Transfer completed!')

    // Check final balance
    const finalBalance = await yusd.balanceOf(signer.address)
    console.log(`💰 Final Balance: ${ethers.formatEther(finalBalance)}`)
    console.log(`💰 YUSD Transferred: ${ethers.formatEther(balance - finalBalance)}`)
  } catch (error) {
    console.log('❌ Gas estimation failed')
    if (error.message.includes('execution reverted')) {
      console.log('🔍 Error data: ', error)
      // Try to decode error data if available
      if (error.data) {
        console.log(`🔍 Error data: ${error.data}`)
        const decodedError = decodeCustomError(error.data)
        if (decodedError) {
          console.log(`🔍 Decoded error: ${decodedError.signature}`)
          if (decodedError.decoded) {
            console.log(`🔍 Error details: ${decodedError.decoded.args}`)
          }
        }
      }
    }
    console.log(`📄 Error details: ${error.message}`)
  }
}

main().catch(console.error)
