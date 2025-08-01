const { ethers, network } = require('hardhat')
const { getNetworksConfig } = require('../utils/helpers')
const readline = require('readline')

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

// Function to get user input with confirmation
function askQuestion(question, defaultValue = '') {
  return new Promise((resolve) => {
    const prompt = defaultValue ? `${question} (${defaultValue}): ` : `${question}: `
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultValue)
    })
  })
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

// Get network info by name
function getNetworkByName(networkName) {
  return SUPPORTED_NETWORKS[networkName]
}

// Get network configuration
function getNetworkConfig(networkName) {
  const networksConfig = getNetworksConfig()
  if (!networksConfig) return null
  return networksConfig.networks[networkName]
}

async function main() {
  try {
    console.log('🚀 Interactive Cross-Chain Transfer Test')
    console.log('=====================================\n')
    console.log('Debug: Starting script...')

    // Use network from --network parameter
    const sourceNetworkName = network.name
    console.log(`Debug: Network name: ${sourceNetworkName}`)
    const sourceNetworkInfo = getNetworkByName(sourceNetworkName)
    const sourceConfig = getNetworkConfig(sourceNetworkName)

    if (!sourceConfig) {
      throw new Error(`Network configuration not found for ${sourceNetworkName}`)
    }

    console.log(`📍 Source Network: ${sourceNetworkName} (${sourceNetworkInfo.name})`)

    // Get target network interactively
    const allNetworks = Object.keys(SUPPORTED_NETWORKS)
    const availableNetworks = allNetworks.filter((name) => name !== sourceNetworkName)
    console.log('Available target networks:')
    availableNetworks.forEach((name, index) => {
      console.log(`  ${index + 1}. ${name} - ${SUPPORTED_NETWORKS[name].name}`)
    })

    let targetNetworkName
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const targetNumber = await askQuestion('Enter target network number', '1')
      const targetIndex = parseInt(targetNumber) - 1

      if (targetIndex >= 0 && targetIndex < availableNetworks.length) {
        targetNetworkName = availableNetworks[targetIndex]
        break
      } else {
        console.log('❌ Invalid network number. Try again.')
      }
    }

    // Get transfer amount interactively
    let transferAmount
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const amountStr = await askQuestion('Enter transfer amount (in YUSD)', '1.0')
      try {
        transferAmount = ethers.parseEther(amountStr)
        break
      } catch (error) {
        console.log('❌ Invalid amount format. Try again.')
      }
    }

    // Get recipient address interactively
    const [signer] = await ethers.getSigners()
    let recipientAddress
    // eslint-disable-next-line no-constant-condition
    while (true) {
      recipientAddress = await askQuestion('Enter recipient address', signer.address)

      if (ethers.isAddress(recipientAddress)) {
        break
      } else {
        console.log('❌ Invalid address. Try again.')
      }
    }

    // Get gas price interactively
    const provider = ethers.provider
    const currentGasPrice = await provider.getFeeData()
    const gasPriceGwei = ethers.formatUnits(currentGasPrice.gasPrice || 0n, 'gwei')

    let gasPrice
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const gasPriceStr = await askQuestion('Enter gas price (in Gwei)', gasPriceGwei)
      try {
        gasPrice = ethers.parseUnits(gasPriceStr, 'gwei')
        break
      } catch (error) {
        console.log('❌ Invalid gas price format. Try again.')
      }
    }

    // Display summary
    console.log('\n📋 Parameters Summary:')
    console.log(`📍 Source Network: ${sourceNetworkName}`)
    console.log(`📍 Target Network: ${targetNetworkName}`)
    console.log(`📍 Amount: ${ethers.formatEther(transferAmount)} YUSD`)
    console.log(`📍 Recipient: ${recipientAddress}`)
    console.log(`📍 Sender: ${signer.address}`)
    console.log(`📍 Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} Gwei`)

    const finalConfirmation = await askQuestion('Confirm transfer execution (y/n)', 'n')
    if (finalConfirmation.toLowerCase() !== 'y' && finalConfirmation.toLowerCase() !== 'yes') {
      console.log('❌ Transfer cancelled by user')
      return
    }

    console.log('✅ Parameters confirmed. Starting execution...')

    // Get contract addresses
    const YUSD_ADDRESS = sourceConfig.contracts.yusdAddress || sourceConfig.contracts.yusdOftAddress
    const OFT_ADAPTER_ADDRESS = sourceConfig.contracts.oftAdapterAddress || sourceConfig.contracts.yusdOftAddress

    if (!YUSD_ADDRESS || !OFT_ADAPTER_ADDRESS) {
      throw new Error(`Missing contract addresses in configuration for ${sourceNetworkName}`)
    }

    // Get contracts
    const yusd = await ethers.getContractAt('IERC20', YUSD_ADDRESS)
    const oftAdapter = await ethers.getContractAt('YUSDMintBurnOFTAdapter', OFT_ADAPTER_ADDRESS)

    // Check balance
    const balance = await yusd.balanceOf(signer.address)
    console.log(`💰 YUSD Balance: ${ethers.formatEther(balance)}`)

    if (balance < transferAmount) {
      console.log('❌ Insufficient YUSD balance for transfer')
      return
    }

    // Check allowance
    const allowance = await yusd.allowance(signer.address, OFT_ADAPTER_ADDRESS)
    console.log(`📝 Current allowance: ${ethers.formatEther(allowance)}`)

    if (allowance < transferAmount) {
      console.log('📝 Approving tokens...')
      const approveTx = await yusd.approve(OFT_ADAPTER_ADDRESS, transferAmount, {
        gasPrice: gasPrice,
      })
      console.log(`📝 Approve transaction: ${approveTx.hash}`)
      await approveTx.wait()
      console.log('✅ Approve completed')

      // Check allowance again after approve
      console.log('🔍 Checking allowance after approve...')
      const newAllowance = await yusd.allowance(signer.address, OFT_ADAPTER_ADDRESS)
      console.log(`📝 New allowance: ${ethers.formatEther(newAllowance)}`)

      if (newAllowance < transferAmount) {
        console.log('❌ Allowance still insufficient after approve. Waiting for indexing...')
        // Wait additional time for indexing
        await new Promise((resolve) => setTimeout(resolve, 10000))

        const finalAllowance = await yusd.allowance(signer.address, OFT_ADAPTER_ADDRESS)
        console.log(`📝 Final allowance: ${ethers.formatEther(finalAllowance)}`)

        if (finalAllowance < transferAmount) {
          console.log('❌ Allowance still insufficient. Approve may have failed.')
          return
        }
      }
    } else {
      console.log('✅ Sufficient allowance already exists')
    }

    console.log('✅ Approve completed. Starting transfer...')

    // Get target network info
    const targetNetworkInfo = getNetworkByName(targetNetworkName)
    const TARGET_EID = targetNetworkInfo.lzEndpointId

    // Get quote
    const sendParam = {
      dstEid: TARGET_EID,
      to: ethers.zeroPadValue(recipientAddress, 32),
      amountLD: transferAmount,
      minAmountLD: transferAmount,
      extraOptions: '0x',
      composeMsg: '0x',
      oftCmd: '0x',
    }

    const quote = await oftAdapter.quoteSend(sendParam, false)
    const currentNetworkInfo = SUPPORTED_NETWORKS[sourceNetworkName]
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
          gasPrice: gasPrice,
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
  } catch (error) {
    console.error('❌ Ошибка:', error.message)
  } finally {
    rl.close()
  }
}

main().catch(console.error)
