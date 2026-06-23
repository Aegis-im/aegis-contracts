const { ethers, network, run } = require('hardhat')
const { getNetworksConfig, updateNetworksConfig } = require('../utils/helpers')
const fs = require('fs')

async function main() {
  const networkName = network.name
  console.log(`🚀 Deploying AegisIncomeRouter on ${networkName}...`)

  const config = getNetworksConfig()
  if (!config || !config.networks[networkName]) {
    throw new Error(`❌ Network ${networkName} not found in config/networks.json`)
  }

  const networkConfig = config.networks[networkName]
  const contracts = networkConfig.contracts
  const deployment = networkConfig.deployment || {}

  // Validate required addresses
  const required = ['yusdAddress', 'aegisMintingAddress', 'aegisRewardsAddress']
  for (const key of required) {
    if (!contracts[key]) {
      throw new Error(`❌ ${key} not found in config for ${networkName}`)
    }
  }

  const [deployer] = await ethers.getSigners()
  console.log(`👤 Deployer: ${deployer.address}`)

  const YUSD_ADDRESS     = contracts.yusdAddress
  const MINTING_ADDRESS  = contracts.aegisMintingAddress
  const REWARDS_ADDRESS  = contracts.aegisRewardsAddress
  const ADMIN_ADDRESS    =
    contracts.adminAddress ||
    deployment.initialOwner?.replace('{DEPLOYER_ADDRESS}', deployer.address) ||
    deployer.address

  // Uniswap Permit2 is deployed at the same address on all EVM networks
  const PERMIT2_ADDRESS      = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
  const UNIV4_ROUTER_ADDRESS = contracts.uniswapV4RouterAddress || ethers.ZeroAddress
  const CURVE_YUSD_USDC      = contracts.curveYusdUsdcAddress   || ethers.ZeroAddress
  const CURVE_YUSD_USDT      = contracts.curveYusdUsdtAddress   || ethers.ZeroAddress
  const USDT_ADDRESS         = contracts.usdtAddress            || ethers.ZeroAddress
  const USDC_ADDRESS         = contracts.usdcAddress            || ethers.ZeroAddress

  // 100k USDT/USDC cap for Curve pool safety (6 decimals)
  const USDT_CURVE_MAX_AMOUNT = ethers.parseUnits('100000', 6)

  // 0 delay for testnets; use 259200 (3 days) on mainnet
  const INITIAL_DELAY = networkName === 'mainnet' ? 259200n : 0n

  console.log('\n📋 Constructor parameters:')
  console.log(`  yusd:               ${YUSD_ADDRESS}`)
  console.log(`  aegisMinting:       ${MINTING_ADDRESS}`)
  console.log(`  aegisRewards:       ${REWARDS_ADDRESS}`)
  console.log(`  admin:              ${ADMIN_ADDRESS}`)
  console.log(`  initialDelay:       ${INITIAL_DELAY}`)
  console.log(`  permit2:            ${PERMIT2_ADDRESS}`)
  console.log(`  uniswapV4Router:    ${UNIV4_ROUTER_ADDRESS}`)
  console.log(`  curveYusdUsdc:      ${CURVE_YUSD_USDC}`)
  console.log(`  curveYusdUsdt:      ${CURVE_YUSD_USDT}`)
  console.log(`  usdt:               ${USDT_ADDRESS}`)
  console.log(`  usdc:               ${USDC_ADDRESS}`)
  console.log(`  usdtCurveMaxAmount: ${USDT_CURVE_MAX_AMOUNT.toString()}`)

  console.log('\n1️⃣  Deploying AegisIncomeRouter...')
  const Factory = await ethers.getContractFactory('AegisIncomeRouter')
  const router = await Factory.deploy(
    YUSD_ADDRESS,
    MINTING_ADDRESS,
    REWARDS_ADDRESS,
    ADMIN_ADDRESS,
    INITIAL_DELAY,
    PERMIT2_ADDRESS,
    UNIV4_ROUTER_ADDRESS,
    CURVE_YUSD_USDC,
    CURVE_YUSD_USDT,
    USDT_ADDRESS,
    USDC_ADDRESS,
    USDT_CURVE_MAX_AMOUNT,
  )
  await router.waitForDeployment()
  const routerAddress = await router.getAddress()
  console.log(`✅ AegisIncomeRouter deployed: ${routerAddress}`)

  // Save to config
  updateNetworksConfig(networkName, { aegisIncomeRouterAddress: routerAddress })

  // On-chain sanity checks
  console.log('\n2️⃣  Verifying immutables...')
  const [yusd, minting, rewards] = await Promise.all([
    router.yusd(),
    router.aegisMinting(),
    router.aegisRewards(),
  ])
  if (yusd.toLowerCase()    !== YUSD_ADDRESS.toLowerCase())    throw new Error('yusd mismatch')
  if (minting.toLowerCase() !== MINTING_ADDRESS.toLowerCase()) throw new Error('aegisMinting mismatch')
  if (rewards.toLowerCase() !== REWARDS_ADDRESS.toLowerCase()) throw new Error('aegisRewards mismatch')
  console.log('  ✅ yusd, aegisMinting, aegisRewards match config')

  // Write constructor args file for Etherscan verification
  const argsContent = `module.exports = [
  "${YUSD_ADDRESS}",
  "${MINTING_ADDRESS}",
  "${REWARDS_ADDRESS}",
  "${ADMIN_ADDRESS}",
  ${INITIAL_DELAY.toString()}n,
  "${PERMIT2_ADDRESS}",
  "${UNIV4_ROUTER_ADDRESS}",
  "${CURVE_YUSD_USDC}",
  "${CURVE_YUSD_USDT}",
  "${USDT_ADDRESS}",
  "${USDC_ADDRESS}",
  ${USDT_CURVE_MAX_AMOUNT.toString()}n,
];`

  const argsFile = `verify-args-income-router-${networkName}.js`
  fs.writeFileSync(argsFile, argsContent)

  // Attempt automatic Etherscan verification
  console.log('\n3️⃣  Submitting to Etherscan...')
  try {
    // Wait a few blocks so Etherscan indexes the contract
    console.log('  ⏳ Waiting 10 s for Etherscan to index...')
    await new Promise((r) => setTimeout(r, 10_000))

    await run('verify:verify', {
      address: routerAddress,
      constructorArguments: [
        YUSD_ADDRESS,
        MINTING_ADDRESS,
        REWARDS_ADDRESS,
        ADMIN_ADDRESS,
        INITIAL_DELAY,
        PERMIT2_ADDRESS,
        UNIV4_ROUTER_ADDRESS,
        CURVE_YUSD_USDC,
        CURVE_YUSD_USDT,
        USDT_ADDRESS,
        USDC_ADDRESS,
        USDT_CURVE_MAX_AMOUNT,
      ],
    })
    console.log('  ✅ Etherscan verification submitted')
  } catch (err) {
    console.log(`  ⚠️  Auto-verify failed (${err.message})`)
    console.log('  Run manually:')
    console.log(`  npx hardhat verify --network ${networkName} ${routerAddress} --constructor-args ${argsFile}`)
  }

  console.log('\n🎉 Done!')
  console.log(`  AegisIncomeRouter: ${routerAddress}`)
  console.log('\n📝 Next steps:')
  console.log(`  1. Grant FUNDS_MANAGER_ROLE to the router on AegisMinting (${MINTING_ADDRESS}):`)
  console.log(`     aegisMinting.grantRole(FUNDS_MANAGER_ROLE, "${routerAddress}")`)
  console.log(`  2. Grant INCOME_ROUTER_ROLE to your operator wallet on the router:`)
  console.log(`     router.grantRole(INCOME_ROUTER_ROLE, "<operator_address>")`)
  console.log(`  3. (DEX routes) Approve routers via router.setDexRouterApproval(dex, true)`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
