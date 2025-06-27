const { ethers } = require('hardhat')
const { getNetworksConfig } = require('../test/helpers')

/**
 * LayerZero Cross-Chain Bridge Diagnostic Report
 *
 * Usage:
 * npx hardhat run scripts/layerzero-diagnostic-report.js --network <source-network>
 *
 * Optional environment variables:
 * - TARGET_NETWORK: Target network name for cross-chain checks (e.g., "sepolia", "bnbTestnet", "avalancheFuji")
 *
 * Supported networks: sepolia, bnbTestnet, avalancheFuji
 */

// Network configurations
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

// Helper function to convert bytes32 to address
function bytes32ToAddress(bytes32) {
  if (bytes32 === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    return 'Not Set'
  }
  return ethers.getAddress(ethers.dataSlice(bytes32, 12))
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
  console.log('🔍 LayerZero Cross-Chain Bridge Diagnostic Report')
  console.log('='.repeat(60))

  try {
    const [deployer] = await ethers.getSigners()
    const network = await ethers.provider.getNetwork()
    const chainId = Number(network.chainId)

    console.log('Executing Account:', await deployer.getAddress())
    console.log('Current Network:', network.name)
    console.log('Chain ID:', chainId)
    console.log('Block Number:', await ethers.provider.getBlockNumber())
    console.log('Timestamp:', new Date().toISOString())

    // Get current network info
    const currentNetworkInfo = getNetworkInfo(chainId)
    if (!currentNetworkInfo) {
      console.log('❌ Unsupported network for this diagnostic')
      console.log('Supported networks:')
      Object.entries(SUPPORTED_NETWORKS).forEach(([name, info]) => {
        console.log(`  - ${name}: ${info.name} (${info.chainId})`)
      })
      return
    }

    // Get network config from networks.json
    const networkConfig = getNetworkConfig(network.name)
    if (!networkConfig || !networkConfig.contracts) {
      console.log(`❌ Network configuration not found for ${network.name}`)
      console.log('Please ensure config/networks.json contains configuration for this network')
      return
    }

    const contracts = networkConfig.contracts

    // Validate required contracts are configured
    if (!contracts.yusdAddress || !contracts.oftAdapterAddress) {
      console.log('❌ Missing required contract addresses in network configuration')
      console.log('Required: yusdAddress, oftAdapterAddress')
      return
    }

    console.log('\n📊 NETWORK CONFIGURATION')
    console.log('-'.repeat(40))
    console.log('Network Name:', currentNetworkInfo.name)
    console.log('YUSD Token Address:', contracts.yusdAddress)
    console.log('OFT Adapter Address:', contracts.oftAdapterAddress)
    console.log('LayerZero Endpoint ID:', currentNetworkInfo.lzEndpointId)
    console.log('Admin Address:', contracts.adminAddress || 'Not Set')
    console.log('Elevated Minter Burner:', contracts.elevatedMinterBurner || 'Not Set')

    // Target network analysis
    const targetNetworkName = process.env.TARGET_NETWORK
    let targetNetworkInfo = null
    let targetNetworkConfig = null

    if (targetNetworkName) {
      targetNetworkInfo = getNetworkByName(targetNetworkName)
      targetNetworkConfig = getNetworkConfig(targetNetworkName)

      if (targetNetworkInfo && targetNetworkConfig) {
        console.log('Target Network:', targetNetworkInfo.name)
        console.log('Target EID:', targetNetworkInfo.lzEndpointId)
        console.log('Target OFT Adapter:', targetNetworkConfig.contracts?.oftAdapterAddress || 'Not Set')
      } else {
        console.log('Target Network: ⚠️ Invalid or not configured')
      }
    } else {
      console.log('Target Network: ℹ️ Not specified (set TARGET_NETWORK env var)')
    }

    // Get contracts
    const yusd = await ethers.getContractAt('YUSD', contracts.yusdAddress)
    const oftAdapter = await ethers.getContractAt('YUSDMintBurnOFTAdapter', contracts.oftAdapterAddress)

    console.log('\n💰 BALANCE INFORMATION')
    console.log('-'.repeat(40))
    const deployerAddress = await deployer.getAddress()
    const nativeBalance = await ethers.provider.getBalance(deployerAddress)
    const yusdBalance = await yusd.balanceOf(deployerAddress)
    const yusdDecimals = await yusd.decimals()
    const yusdTotalSupply = await yusd.totalSupply()

    console.log(`${currentNetworkInfo.nativeToken} Balance:`, ethers.formatEther(nativeBalance))
    console.log('YUSD Balance:', ethers.formatUnits(yusdBalance, yusdDecimals))
    console.log('YUSD Total Supply:', ethers.formatUnits(yusdTotalSupply, yusdDecimals))
    console.log('YUSD Decimals:', yusdDecimals.toString())

    console.log('\n🔑 TOKEN PERMISSIONS')
    console.log('-'.repeat(40))
    const yusdOwner = await yusd.owner()
    const yusdMinter = await yusd.minter()
    const oftAdapterOwner = await oftAdapter.owner()
    const allowance = await yusd.allowance(deployerAddress, contracts.oftAdapterAddress)

    console.log('YUSD Owner:', yusdOwner)
    console.log('YUSD Minter:', yusdMinter)
    console.log('OFT Adapter Owner:', oftAdapterOwner)
    console.log('Token Allowance (User → Adapter):', ethers.formatUnits(allowance, yusdDecimals))

    // Check if minter is elevated minter burner
    const isElevatedMinter = contracts.elevatedMinterBurner &&
                           yusdMinter.toLowerCase() === contracts.elevatedMinterBurner.toLowerCase()
    console.log('YUSD Minter Type:', isElevatedMinter ? 'ElevatedMinterBurner ✅' : 'Direct OFT Adapter')

    console.log('\n📡 LAYERZERO CONFIGURATION')
    console.log('-'.repeat(40))

    // OFT adapter methods with error handling
    let oftToken = 'Not Available'
    let localDecimals = 'Not Available'
    let sharedDecimals = 'Not Available'

    try {
      oftToken = await oftAdapter.token()
      console.log('OFT Token Reference:', oftToken)
      console.log('Token Reference Valid:', oftToken.toLowerCase() === contracts.yusdAddress.toLowerCase() ? '✅' : '❌')
    } catch (error) {
      console.log('OFT Token Reference: ❌ FAILED -', error.message)
    }

    try {
      localDecimals = await oftAdapter.localDecimals()
      console.log('Local Decimals:', localDecimals.toString())
    } catch (error) {
      console.log('Local Decimals: ❌ FAILED -', error.message)
    }

    try {
      sharedDecimals = await oftAdapter.sharedDecimals()
      console.log('Shared Decimals:', sharedDecimals.toString())
    } catch (error) {
      console.log('Shared Decimals: ❌ FAILED -', error.message)
    }

    // Check peer connections for all other networks
    console.log('\n🔗 PEER CONNECTIONS')
    console.log('-'.repeat(40))

    const otherNetworks = Object.entries(SUPPORTED_NETWORKS).filter(([name]) => name !== network.name)

    for (const [peerNetworkName, peerNetworkInfo] of otherNetworks) {
      try {
        const peer = await oftAdapter.peers(peerNetworkInfo.lzEndpointId)
        const peerAddress = bytes32ToAddress(peer)
        const peerConfig = getNetworkConfig(peerNetworkName)
        const expectedPeer = peerConfig?.contracts?.oftAdapterAddress

        console.log(`${peerNetworkInfo.name} (EID ${peerNetworkInfo.lzEndpointId}):`)
        console.log(`  Configured Peer: ${peerAddress}`)
        console.log(`  Expected Peer: ${expectedPeer || 'Not Available'}`)

        if (peerAddress === 'Not Set') {
          console.log('  Status: ❌ NOT CONFIGURED')
        } else if (expectedPeer && peerAddress.toLowerCase() === expectedPeer.toLowerCase()) {
          console.log('  Status: ✅ CORRECTLY CONFIGURED')
        } else {
          console.log('  Status: ⚠️ CONFIGURED BUT MISMATCHED')
        }
      } catch (error) {
        console.log(`${peerNetworkInfo.name}: ❌ FAILED -`, error.message)
      }
    }

    console.log('\n🔍 CONTRACT VERIFICATION')
    console.log('-'.repeat(40))
    const yusdCode = await ethers.provider.getCode(contracts.yusdAddress)
    const adapterCode = await ethers.provider.getCode(contracts.oftAdapterAddress)

    console.log('YUSD Contract Deployed:', yusdCode !== '0x' ? '✅ YES' : '❌ NO')
    console.log('OFT Adapter Contract Deployed:', adapterCode !== '0x' ? '✅ YES' : '❌ NO')
    console.log('YUSD Code Size:', yusdCode.length, 'bytes')
    console.log('OFT Adapter Code Size:', adapterCode.length, 'bytes')

    // Test LayerZero functionality if target network is specified
    if (targetNetworkInfo && targetNetworkConfig?.contracts?.oftAdapterAddress) {
      console.log('\n🧪 LAYERZERO FUNCTIONALITY TEST')
      console.log('-'.repeat(40))

      try {
        const testAmount = ethers.parseEther('0.01') // 0.01 YUSD
        const sendParam = {
          dstEid: targetNetworkInfo.lzEndpointId,
          to: ethers.zeroPadValue(deployerAddress, 32),
          amountLD: testAmount,
          minAmountLD: testAmount,
          extraOptions: '0x',
          composeMsg: '0x',
          oftCmd: '0x',
        }

        const quote = await oftAdapter.quoteSend(sendParam, false)
        console.log('QuoteSend Function:', '✅ WORKING')
        console.log('Estimated Fee:', ethers.formatEther(quote.nativeFee), currentNetworkInfo.nativeToken)
        console.log('LZ Token Fee:', quote.lzTokenFee.toString())
      } catch (error) {
        console.log('QuoteSend Function:', '❌ FAILED')
        console.log('Error:', error.message)
      }
    }

    console.log('\n📋 CROSS-CHAIN READINESS CHECKLIST')
    console.log('-'.repeat(40))

    // Count configured peers
    let configuredPeers = 0
    for (const [, peerNetworkInfo] of otherNetworks) {
      try {
        const peer = await oftAdapter.peers(peerNetworkInfo.lzEndpointId)
        if (bytes32ToAddress(peer) !== 'Not Set') {
          configuredPeers++
        }
      } catch (error) {
        // Ignore errors for counting
      }
    }

    const checks = [
      { name: 'YUSD Contract Deployed', status: yusdCode !== '0x' },
      { name: 'OFT Adapter Contract Deployed', status: adapterCode !== '0x' },
      { name: 'YUSD Minter Configured', status: yusdMinter !== ethers.ZeroAddress },
      { name: 'At Least One Peer Connected', status: configuredPeers > 0 },
      { name: 'User has YUSD Balance', status: yusdBalance > 0 },
      { name: 'User has Native Token for Fees', status: nativeBalance > ethers.parseEther('0.01') },
      { name: 'Token Allowance Set', status: allowance > 0 },
    ]

    checks.forEach(check => {
      console.log(`${check.status ? '✅' : '❌'} ${check.name}`)
    })

    const allReady = checks.every(check => check.status)
    console.log('\nOverall Status:', allReady ? '✅ READY FOR CROSS-CHAIN TRANSFERS' : '⚠️ REQUIRES SETUP')
    console.log('Configured Peers:', `${configuredPeers}/${otherNetworks.length}`)

    console.log('\n🔗 USEFUL LINKS')
    console.log('-'.repeat(40))
    console.log(`Network Explorer: ${currentNetworkInfo.explorer}`)
    console.log(`YUSD Token: ${currentNetworkInfo.explorer}/address/${contracts.yusdAddress}`)
    console.log(`OFT Adapter: ${currentNetworkInfo.explorer}/address/${contracts.oftAdapterAddress}`)
    console.log('LayerZero Scan: https://testnet.layerzeroscan.com/')

    console.log('\n📄 CONFIGURATION SUMMARY')
    console.log('='.repeat(60))
    console.log('NETWORK:', network.name)
    console.log('CHAIN_ID:', chainId)
    console.log('LZ_ENDPOINT_ID:', currentNetworkInfo.lzEndpointId)
    console.log('YUSD_TOKEN:', contracts.yusdAddress)
    console.log('OFT_ADAPTER:', contracts.oftAdapterAddress)
    console.log('YUSD_BALANCE:', ethers.formatEther(yusdBalance))
    console.log('NATIVE_BALANCE:', ethers.formatEther(nativeBalance))
    console.log('PEERS_CONFIGURED:', `${configuredPeers}/${otherNetworks.length}`)

    console.log('\n💡 USAGE EXAMPLES')
    console.log('-'.repeat(40))
    console.log('Run diagnostic for different networks:')
    otherNetworks.forEach(([networkName]) => {
      console.log(`  npx hardhat run scripts/layerzero-diagnostic-report.js --network ${networkName}`)
    })
    console.log('\nSpecify target network for cross-chain tests:')
    console.log('  TARGET_NETWORK=sepolia npx hardhat run scripts/layerzero-diagnostic-report.js --network bnbTestnet')

  } catch (error) {
    console.error('❌ Diagnostic failed:', error.message)
    console.error('Stack trace:', error.stack)
  }
}

main().catch(console.error)