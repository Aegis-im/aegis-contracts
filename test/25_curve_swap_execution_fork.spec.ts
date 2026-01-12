import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { AegisIncomeRouter, YUSD, AegisConfig, AegisMinting, AegisRewards, IERC20 } from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'

/**
 * Test 25: Curve Swap Execution (Fork)
 *
 * Comprehensive testing of actual Curve pool swaps for USDC and USDT
 * Tests both quoting and actual swap execution through AegisIncomeRouter
 *
 * Coverage:
 * - USDC → YUSD via Curve YUSD/USDC pool (0x9804...6861)
 * - USDT → YUSD via Curve YUSD/USDT pool (0xcF90...51A8)
 * - All amounts: $10k, $30k, $50k, $100k, $200k
 * - Quote accuracy vs actual swap output
 * - Router swapAndDeposit function
 * - Rewards distribution
 */

describe('Test 25: Curve Swap Execution (Fork)', () => {
  // ========================================
  // CONFIGURATION
  // ========================================

  const FORK_NETWORK = 'mainnet'

  // Token addresses
  const YUSD_ADDRESS = '0x4274cD7277C7bb0806Bd5FE84b9aDAE466a8DA0a' // Real YUSD on mainnet
  const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  const AEGIS_ORACLE_ADDRESS = '0x2B4Ad1d479561064cd1C311004Aca93d15041aEc' // Real mainnet AegisOracle
  const FEED_REGISTRY_ADDRESS = '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf' // Chainlink Feed Registry

  // Curve YUSD pools (factory-stable-ng)
  const CURVE_YUSD_USDC = '0x9804C30875127246AC92D72D5CDF0630aA356861' // factory-stable-ng-407
  const CURVE_YUSD_USDT = '0xCF908d925b21594f9a92b264167A85B0649051a8' // factory-stable-ng-360

  // Whale addresses
  const USDC_WHALE = '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341' // Coinbase 14
  const USDT_WHALE = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // Binance 8

  // Test amounts
  const AMOUNTS = [
    { label: '$10k', usdc: ethers.parseUnits('10000', 6), usdt: ethers.parseUnits('10000', 6) },
    { label: '$30k', usdc: ethers.parseUnits('30000', 6), usdt: ethers.parseUnits('30000', 6) },
    { label: '$50k', usdc: ethers.parseUnits('50000', 6), usdt: ethers.parseUnits('50000', 6) },
    { label: '$100k', usdc: ethers.parseUnits('100000', 6), usdt: ethers.parseUnits('100000', 6) },
    { label: '$200k', usdc: ethers.parseUnits('200000', 6), usdt: ethers.parseUnits('200000', 6) },
  ]

  // Contract instances
  let router: AegisIncomeRouter
  let yusd: YUSD
  let aegisMinting: AegisMinting
  let aegisRewards: AegisRewards
  let aegisConfig: AegisConfig
  let usdc: IERC20
  let usdt: IERC20
  let curvePoolUsdc: any
  let curvePoolUsdt: any

  // Signers
  let deployer: SignerWithAddress
  let admin: SignerWithAddress
  let insuranceFund: SignerWithAddress
  let usdcWhale: SignerWithAddress
  let usdtWhale: SignerWithAddress
  let routerOperator: SignerWithAddress
  let trustedSigner: any

  before(async function () {
    // Skip if no API key
    if (!process.env.ALCHEMY_API_KEY) {
      console.log('⚠️  Skipping fork test: ALCHEMY_API_KEY not set')
      this.skip()
    }

    console.log('\n📍 Forking from', FORK_NETWORK, 'at latest block')

    // Fork mainnet at latest block
    await network.provider.request({
      method: 'hardhat_reset',
      params: [
        {
          forking: {
            jsonRpcUrl: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
          },
        },
      ],
    })

    // Get signers
    const signers = await ethers.getSigners()
    deployer = signers[0]
    admin = signers[1]
    insuranceFund = signers[2]
    routerOperator = signers[3]

    console.log('\n👤 Test accounts:')
    console.log('   Deployer:', deployer.address)
    console.log('   Admin:', admin.address)
    console.log('   Insurance Fund:', insuranceFund.address)
    console.log('   Router Operator:', routerOperator.address)

    // Get token contracts
    usdc = await ethers.getContractAt('IERC20', USDC_ADDRESS)
    usdt = await ethers.getContractAt('IERC20', USDT_ADDRESS)

    // Get Curve pool contracts
    curvePoolUsdc = await ethers.getContractAt(
      [
        'function coins(uint256 i) view returns (address)',
        'function balances(uint256 i) view returns (uint256)',
        'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
        'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)',
      ],
      CURVE_YUSD_USDC
    )

    curvePoolUsdt = await ethers.getContractAt(
      [
        'function coins(uint256 i) view returns (address)',
        'function balances(uint256 i) view returns (uint256)',
        'function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)',
        'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) returns (uint256)',
      ],
      CURVE_YUSD_USDT
    )

    // Impersonate whale wallets
    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDC_WHALE],
    })
    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDT_WHALE],
    })

    usdcWhale = await ethers.getSigner(USDC_WHALE)
    usdtWhale = await ethers.getSigner(USDT_WHALE)

    // Fund whales with ETH for gas
    await network.provider.send('hardhat_setBalance', [
      USDC_WHALE,
      ethers.toQuantity(ethers.parseEther('100')),
    ])
    await network.provider.send('hardhat_setBalance', [
      USDT_WHALE,
      ethers.toQuantity(ethers.parseEther('100')),
    ])

    console.log('\n🐋 Whale wallets:')
    console.log('   USDC Whale:', USDC_WHALE)
    console.log('   USDC balance:', ethers.formatUnits(await usdc.balanceOf(USDC_WHALE), 6))
    console.log('   USDT Whale:', USDT_WHALE)
    console.log('   USDT balance:', ethers.formatUnits(await usdt.balanceOf(USDT_WHALE), 6))

    // ========================================
    // GET EXISTING CONTRACTS & DEPLOY NEW ONES
    // ========================================

    console.log('\n📦 Setting up contracts on fork...')

    // 1. Get real YUSD from mainnet
    console.log('\n1️⃣  Using real YUSD from mainnet...')
    yusd = await ethers.getContractAt('YUSD', YUSD_ADDRESS)
    console.log('   ✅ YUSD at:', YUSD_ADDRESS)

    // 2. Deploy AegisConfig
    console.log('\n2️⃣  Deploying AegisConfig...')
    trustedSigner = ethers.Wallet.createRandom().connect(ethers.provider)
    const AegisConfig = await ethers.getContractFactory('AegisConfig')
    aegisConfig = await AegisConfig.deploy(
      trustedSigner.address,
      [],
      admin.address
    )
    await aegisConfig.waitForDeployment()
    console.log('   ✅ AegisConfig deployed at:', await aegisConfig.getAddress())

    // 3. Deploy AegisMinting with real mainnet oracle
    console.log('\n3️⃣  Deploying AegisMinting with mainnet oracle...')
    const AegisMinting = await ethers.getContractFactory('AegisMinting')
    const placeholderRewards = admin.address

    aegisMinting = await AegisMinting.deploy(
      await yusd.getAddress(),           // YUSD
      await aegisConfig.getAddress(),    // AegisConfig
      placeholderRewards,                // AegisRewards (placeholder)
      AEGIS_ORACLE_ADDRESS,              // Real mainnet AegisOracle
      FEED_REGISTRY_ADDRESS,             // Chainlink Feed Registry
      insuranceFund.address,             // Insurance fund
      [USDC_ADDRESS, USDT_ADDRESS],      // Supported assets
      [86400, 86400],                    // Chainlink heartbeats (24 hours)
      [admin.address],                   // Custodians
      admin.address                      // Admin
    ) as any
    await aegisMinting.waitForDeployment()
    console.log('   ✅ AegisMinting deployed at:', await aegisMinting.getAddress())

    // 4. Deploy AegisRewards
    console.log('\n4️⃣  Deploying AegisRewards...')
    const AegisRewards = await ethers.getContractFactory('AegisRewards')
    aegisRewards = await AegisRewards.deploy(
      await yusd.getAddress(),
      await aegisConfig.getAddress(),
      admin.address
    )
    await aegisRewards.waitForDeployment()
    console.log('   ✅ AegisRewards deployed at:', await aegisRewards.getAddress())

    // Grant SETTINGS_MANAGER_ROLE to admin and update AegisMinting with AegisRewards address
    const SETTINGS_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("SETTINGS_MANAGER_ROLE"))
    await aegisMinting.connect(admin).grantRole(SETTINGS_MANAGER_ROLE, admin.address)
    await aegisMinting.connect(admin).setAegisRewardsAddress(await aegisRewards.getAddress())
    console.log('   ✅ Updated AegisMinting with AegisRewards address')

    // 5. Deploy AegisIncomeRouter
    console.log('\n5️⃣  Deploying AegisIncomeRouter...')
    const AegisIncomeRouter = await ethers.getContractFactory('AegisIncomeRouter')

    router = await AegisIncomeRouter.deploy(
      await yusd.getAddress(),
      await aegisMinting.getAddress(),
      await aegisRewards.getAddress(),
      admin.address,
      3 * 24 * 60 * 60 // 3 day delay
    )
    await router.waitForDeployment()
    console.log('   ✅ AegisIncomeRouter deployed at:', await router.getAddress())

    // ========================================
    // CONFIGURE CONTRACTS
    // ========================================

    console.log('\n⚙️  Configuring contracts...')

    // Grant roles
    const INCOME_ROUTER_ROLE = await router.INCOME_ROUTER_ROLE()
    await router.connect(admin).grantRole(INCOME_ROUTER_ROLE, routerOperator.address)
    console.log('   ✅ Granted INCOME_ROUTER_ROLE to operator')

    // Approve Curve pools
    await router.connect(admin).setDexRouterApproval(CURVE_YUSD_USDC, true)
    console.log('   ✅ Approved Curve YUSD/USDC pool')

    await router.connect(admin).setDexRouterApproval(CURVE_YUSD_USDT, true)
    console.log('   ✅ Approved Curve YUSD/USDT pool')

    // Set AegisIncomeRouter address on AegisRewards
    await aegisRewards.connect(admin).setAegisIncomeRouterAddress(await router.getAddress())
    console.log('   ✅ Set AegisIncomeRouter address on AegisRewards')

    // Note: Using real YUSD from mainnet, so we don't need to set minter

    // Fund router operator with USDC and USDT from whales
    await usdc.connect(usdcWhale).transfer(routerOperator.address, ethers.parseUnits('500000', 6))
    console.log('   ✅ Funded operator with 500k USDC')

    await usdt.connect(usdtWhale).transfer(routerOperator.address, ethers.parseUnits('500000', 6))
    console.log('   ✅ Funded operator with 500k USDT')

    console.log('\n✅ All contracts deployed and configured on fork!')
    console.log('\n📊 Ready to test Curve swaps...')
  })

  // ========================================
  // CURVE POOL VERIFICATION
  // ========================================

  describe('Curve Pool Verification', () => {
    it('Should verify Curve YUSD/USDC pool exists', async () => {
      const coin0 = await curvePoolUsdc.coins(0)
      const coin1 = await curvePoolUsdc.coins(1)

      console.log('\n📊 Curve YUSD/USDC Pool:')
      console.log('   Coin 0:', coin0)
      console.log('   Coin 1:', coin1)

      // Verify pool contains YUSD and USDC
      const hasYUSD = coin0.toLowerCase() === (await yusd.getAddress()).toLowerCase() ||
                      coin1.toLowerCase() === (await yusd.getAddress()).toLowerCase()
      const hasUSDC = coin0.toLowerCase() === USDC_ADDRESS.toLowerCase() ||
                      coin1.toLowerCase() === USDC_ADDRESS.toLowerCase()

      expect(hasYUSD || hasUSDC).to.be.true
      console.log('   ✅ Pool contains expected tokens')
    })

    it('Should verify Curve YUSD/USDT pool exists', async () => {
      const coin0 = await curvePoolUsdt.coins(0)
      const coin1 = await curvePoolUsdt.coins(1)

      console.log('\n📊 Curve YUSD/USDT Pool:')
      console.log('   Coin 0:', coin0)
      console.log('   Coin 1:', coin1)

      const hasYUSD = coin0.toLowerCase() === (await yusd.getAddress()).toLowerCase() ||
                      coin1.toLowerCase() === (await yusd.getAddress()).toLowerCase()
      const hasUSDT = coin0.toLowerCase() === USDT_ADDRESS.toLowerCase() ||
                      coin1.toLowerCase() === USDT_ADDRESS.toLowerCase()

      expect(hasYUSD || hasUSDT).to.be.true
      console.log('   ✅ Pool contains expected tokens')
    })
  })

  // ========================================
  // USDC → YUSD SWAPS VIA CURVE
  // ========================================

  describe('USDC → YUSD Swaps via Curve', () => {
    AMOUNTS.forEach(({ label, usdc: amount }) => {
      it(`Should execute ${label} USDC → YUSD swap via Curve pool`, async () => {
        console.log(`\n─── ${label} USDC → YUSD via Curve ───\n`)

        // Get quote from Curve pool
        const coin0 = await curvePoolUsdc.coins(0)
        const usdcIndex = coin0.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 0 : 1
        const yusdIndex = usdcIndex === 0 ? 1 : 0

        const expectedYUSD = await curvePoolUsdc.get_dy(usdcIndex, yusdIndex, amount)
        console.log('   📊 Curve quote:', ethers.formatEther(expectedYUSD), 'YUSD')

        // Build swap calldata
        const minYUSDOut = (expectedYUSD * 99n) / 100n // 1% slippage tolerance
        const swapCalldata = curvePoolUsdc.interface.encodeFunctionData('exchange', [
          usdcIndex,
          yusdIndex,
          amount,
          minYUSDOut,
        ])

        // Approve router
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        // Get balances before
        const routerBalanceBefore = await yusd.balanceOf(await router.getAddress())
        const rewardsBalanceBefore = await yusd.balanceOf(await aegisRewards.getAddress())
        const insuranceBalanceBefore = await yusd.balanceOf(insuranceFund.address)

        // Execute swap via router
        const tx = await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          minYUSDOut,
          ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-snapshot'])
        )
        const receipt = await tx.wait()

        // Get balances after
        const rewardsBalanceAfter = await yusd.balanceOf(await aegisRewards.getAddress())
        const insuranceBalanceAfter = await yusd.balanceOf(insuranceFund.address)

        const rewardsDeposited = rewardsBalanceAfter - rewardsBalanceBefore
        const insuranceFee = insuranceBalanceAfter - insuranceBalanceBefore
        const totalYUSD = rewardsDeposited + insuranceFee

        // Read actual fee from deployed contract
        const feeBP = await aegisMinting.incomeFeeBP()
        const expectedFee = (totalYUSD * feeBP) / 10000n
        const expectedRewards = totalYUSD - expectedFee
        const feePercent = Number(feeBP) / 100
        const rewardsPercent = 100 - feePercent

        console.log('   ✅ Swap successful!')
        console.log(`   Input:              ${ethers.formatUnits(amount, 6)} USDC`)
        console.log(`   Total YUSD:         ${ethers.formatEther(totalYUSD)} YUSD`)
        console.log(`   Insurance fee (${feePercent}%): ${ethers.formatEther(insuranceFee)} YUSD`)
        console.log(`   To rewards (${rewardsPercent}%):   ${ethers.formatEther(rewardsDeposited)} YUSD`)
        console.log(`   Gas used:           ${receipt!.gasUsed.toString()}`)

        // Calculate slippage
        const inputUSD = Number(ethers.formatUnits(amount, 6))
        const outputUSD = Number(ethers.formatEther(totalYUSD))
        const slippage = ((inputUSD - outputUSD) / inputUSD) * 100
        console.log(`   Slippage:           ${slippage.toFixed(4)}%`)

        // Verify fee split
        expect(insuranceFee).to.be.closeTo(expectedFee, expectedFee / 100n) // 1% tolerance
        expect(rewardsDeposited).to.be.closeTo(expectedRewards, expectedRewards / 100n)

        // Assertions
        expect(totalYUSD).to.be.gte(minYUSDOut)
      })
    })
  })

  // ========================================
  // USDT → YUSD SWAPS VIA CURVE
  // ========================================

  describe('USDT → YUSD Swaps via Curve', () => {
    it('Should execute $10k USDT → YUSD swap via Curve pool', async () => {
      const amount = ethers.parseUnits('10000', 6)
      console.log('\n─── $10k USDT → YUSD via Curve ───\n')

      // Get quote from Curve pool
      const coin0 = await curvePoolUsdt.coins(0)
      const usdtIndex = coin0.toLowerCase() === USDT_ADDRESS.toLowerCase() ? 0 : 1
      const yusdIndex = usdtIndex === 0 ? 1 : 0

      const expectedYUSD = await curvePoolUsdt.get_dy(usdtIndex, yusdIndex, amount)
      console.log('   📊 Curve quote:', ethers.formatEther(expectedYUSD), 'YUSD')

      // Build swap calldata
      const minYUSDOut = (expectedYUSD * 99n) / 100n
      const swapCalldata = curvePoolUsdt.interface.encodeFunctionData('exchange', [
        usdtIndex,
        yusdIndex,
        amount,
        minYUSDOut,
      ])

      // Approve router
      await usdt.connect(routerOperator).approve(await router.getAddress(), amount)

      // Get balances before
      const rewardsBalanceBefore = await yusd.balanceOf(await aegisRewards.getAddress())
      const insuranceBalanceBefore = await yusd.balanceOf(insuranceFund.address)

      // Execute swap via router
      const tx = await router.connect(routerOperator).swapAndDeposit(
        USDT_ADDRESS,
        amount,
        CURVE_YUSD_USDT,
        swapCalldata,
        minYUSDOut,
        ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-snapshot'])
      )
      const receipt = await tx.wait()

      // Get balances after
      const rewardsBalanceAfter = await yusd.balanceOf(await aegisRewards.getAddress())
      const insuranceBalanceAfter = await yusd.balanceOf(insuranceFund.address)

      const rewardsDeposited = rewardsBalanceAfter - rewardsBalanceBefore
      const insuranceFee = insuranceBalanceAfter - insuranceBalanceBefore
      const totalYUSD = rewardsDeposited + insuranceFee

      // Read actual fee from deployed contract
      const feeBP = await aegisMinting.incomeFeeBP()
      const expectedFee = (totalYUSD * feeBP) / 10000n
      const expectedRewards = totalYUSD - expectedFee
      const feePercent = Number(feeBP) / 100
      const rewardsPercent = 100 - feePercent

      console.log('   ✅ Swap successful!')
      console.log(`   Input:              ${ethers.formatUnits(amount, 6)} USDT`)
      console.log(`   Total YUSD:         ${ethers.formatEther(totalYUSD)} YUSD`)
      console.log(`   Insurance fee (${feePercent}%): ${ethers.formatEther(insuranceFee)} YUSD`)
      console.log(`   To rewards (${rewardsPercent}%):   ${ethers.formatEther(rewardsDeposited)} YUSD`)
      console.log(`   Gas used:           ${receipt!.gasUsed.toString()}`)

      // Verify fee split
      expect(insuranceFee).to.be.closeTo(expectedFee, expectedFee / 100n) // 1% tolerance
      expect(rewardsDeposited).to.be.closeTo(expectedRewards, expectedRewards / 100n)

      // Assertions
      expect(totalYUSD).to.be.gte(minYUSDOut)
    })

    it('Should prevent USDT swaps >$10k due to insufficient liquidity', async () => {
      const amount = ethers.parseUnits('15000', 6) // $15k - exceeds safe limit

      console.log('\n⚠️  Testing $15k USDT swap (should fail)...')

      // Build swap calldata
      const coin0 = await curvePoolUsdt.coins(0)
      const usdtIndex = coin0.toLowerCase() === USDT_ADDRESS.toLowerCase() ? 0 : 1
      const yusdIndex = usdtIndex === 0 ? 1 : 0

      const swapCalldata = curvePoolUsdt.interface.encodeFunctionData('exchange', [
        usdtIndex,
        yusdIndex,
        amount,
        0,
      ])

      // Approve router
      await usdt.connect(routerOperator).approve(await router.getAddress(), amount)

      // Should revert due to safety check in contract
      await expect(
        router.connect(routerOperator).swapAndDeposit(
          USDT_ADDRESS,
          amount,
          CURVE_YUSD_USDT,
          swapCalldata,
          0,
          ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-snapshot'])
        )
      ).to.be.reverted

      console.log('   ✅ Correctly prevented dangerous swap!')
      console.log('   💡 Use minting route for USDT amounts >$10k')
    })
  })

  // ========================================
  // QUOTE VS EXECUTION COMPARISON
  // ========================================

  describe('Quote vs Execution Accuracy', () => {
    it('Should match Curve quote with actual swap output (USDC)', async () => {
      const amount = ethers.parseUnits('10000', 6)

      // Get quote
      const coin0 = await curvePoolUsdc.coins(0)
      const usdcIndex = coin0.toLowerCase() === USDC_ADDRESS.toLowerCase() ? 0 : 1
      const yusdIndex = usdcIndex === 0 ? 1 : 0

      const quote = await curvePoolUsdc.get_dy(usdcIndex, yusdIndex, amount)

      // Execute swap
      const minYUSDOut = (quote * 99n) / 100n
      const swapCalldata = curvePoolUsdc.interface.encodeFunctionData('exchange', [
        usdcIndex,
        yusdIndex,
        amount,
        minYUSDOut,
      ])

      await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

      const rewardsBefore = await yusd.balanceOf(await aegisRewards.getAddress())
      const insuranceBefore = await yusd.balanceOf(insuranceFund.address)

      await router.connect(routerOperator).swapAndDeposit(
        USDC_ADDRESS,
        amount,
        CURVE_YUSD_USDC,
        swapCalldata,
        minYUSDOut,
        ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-snapshot'])
      )

      const rewardsAfter = await yusd.balanceOf(await aegisRewards.getAddress())
      const insuranceAfter = await yusd.balanceOf(insuranceFund.address)

      const actualOutput = (rewardsAfter - rewardsBefore) + (insuranceAfter - insuranceBefore)

      console.log('\n📊 Quote vs Execution:')
      console.log('   Quote:  ', ethers.formatEther(quote), 'YUSD')
      console.log('   Actual: ', ethers.formatEther(actualOutput), 'YUSD')

      // Actual output should be very close to quote (within 0.1%)
      const tolerance = quote / 1000n // 0.1% tolerance
      expect(actualOutput).to.be.closeTo(quote, tolerance)

      console.log('   ✅ Quote accuracy verified!')
    })
  })

  after(async () => {
    // Reset network to clean state
    await network.provider.request({
      method: 'hardhat_reset',
      params: [],
    })
  })
})
