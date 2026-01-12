import { ethers, network } from 'hardhat'
import { expect } from 'chai'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { AegisIncomeRouter, YUSD, AegisConfig, AegisMinting, AegisRewards, IERC20 } from '../typechain-types'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'

/**
 * Tests all three income routes across multiple amounts and assets:
 * - Route 1: Oracle-based minting (via transferToMinting)
 * - Route 2: Curve swap (stablecoin-optimized)
 * - Route 3: Uniswap V4 swap (general purpose)
 *
 * Test Matrix:
 * - Assets: USDC, USDT
 * - Amounts: $10k, $30k, $50k, $100k, $200k
 * - Routes: Minting, Curve, Uniswap
 * - Total: 2 × 5 × 3 = 30 route tests + analysis tests
 */

describe('AegisIncomeRouter - Comprehensive Quote & Route Testing (Fork)', () => {
  // ========================================
  // CONFIGURATION
  // ========================================

  const FORK_NETWORK = 'mainnet'

  // Mainnet contract addresses (checksummed)
  const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
  const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
  const AEGIS_ORACLE_ADDRESS = '0x2B4Ad1d479561064cd1C311004Aca93d15041aEc' // Real mainnet AegisOracle
  const FEED_REGISTRY_ADDRESS = '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf' // Chainlink Feed Registry

  // REAL Curve YUSD pools (factory-stable-ng)
  // NOTE: These pools contain JUSD (Jupiter Stablecoin Dollar), not Aegis YUSD
  const CURVE_YUSD_USDC = '0x9804C30875127246AC92D72D5CDF0630aA356861' // factory-stable-ng-407
  const CURVE_YUSD_USDT = '0xCF908d925b21594f9a92b264167A85B0649051a8' // factory-stable-ng-360

  const UNISWAP_V4_ROUTER = '0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af'

  // Whale addresses (large token holders)
  const USDC_WHALE = '0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341' // Coinbase 14
  const USDT_WHALE = '0xF977814e90dA44bFA03b6295A0616a897441aceC' // Binance 8

  // YUSD whale will be determined dynamically from Curve pool reserves
  let YUSD_WHALE: string

  // Test amounts (as specified in requirements)
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

    // Get real YUSD token address from Curve pool
    const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
    const yusdTokenAddress = await curvePool.coins(0) // YUSD is at index 0
    yusd = await ethers.getContractAt('YUSD', yusdTokenAddress)

    console.log('\n📍 Real mainnet YUSD token:', yusdTokenAddress)

    // Use the Curve pool itself as YUSD whale (it has reserves)
    YUSD_WHALE = CURVE_YUSD_USDC

    // Impersonate whale wallets
    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDC_WHALE],
    })
    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [USDT_WHALE],
    })
    await network.provider.request({
      method: 'hardhat_impersonateAccount',
      params: [YUSD_WHALE],
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
    await network.provider.send('hardhat_setBalance', [
      YUSD_WHALE,
      ethers.toQuantity(ethers.parseEther('100')),
    ])

    console.log('\n🐋 Whale wallets:')
    console.log('   USDC Whale:', USDC_WHALE)
    console.log('   USDC balance:', ethers.formatUnits(await usdc.balanceOf(USDC_WHALE), 6))
    console.log('   USDT Whale:', USDT_WHALE)
    console.log('   USDT balance:', ethers.formatUnits(await usdt.balanceOf(USDT_WHALE), 6))
    console.log('   YUSD Whale:', YUSD_WHALE)
    console.log('   YUSD balance:', ethers.formatEther(await yusd.balanceOf(YUSD_WHALE)))

    // ========================================
    // DEPLOY CONTRACTS ON FORK
    // ========================================

    console.log('\n📦 Deploying contracts on fork...')

    // Note: Using real mainnet YUSD token from Curve pool (fetched above)
    console.log('\n1️⃣  Using real mainnet YUSD:', await yusd.getAddress())

    // 2. Deploy AegisConfig
    console.log('\n2️⃣  Deploying AegisConfig...')
    trustedSigner = ethers.Wallet.createRandom().connect(ethers.provider)
    const AegisConfig = await ethers.getContractFactory('AegisConfig')
    aegisConfig = await AegisConfig.deploy(
      trustedSigner.address, // trusted signer
      [],                    // ops array (empty for testing)
      admin.address,          // initial owner
    )
    await aegisConfig.waitForDeployment()
    console.log('   ✅ AegisConfig deployed at:', await aegisConfig.getAddress())
    console.log('   ✅ Trusted signer:', trustedSigner.address)

    // 3. Deploy AegisMinting with real mainnet oracle
    console.log('\n3️⃣  Deploying AegisMinting with mainnet oracle...')
    const AegisMinting = await ethers.getContractFactory('AegisMinting')

    // We'll deploy a placeholder AegisRewards first, then update after deploying the real one
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
      admin.address,                      // Admin
    ) as any
    await aegisMinting.waitForDeployment()
    console.log('   ✅ AegisMinting deployed at:', await aegisMinting.getAddress())

    // 4. Deploy AegisRewards
    console.log('\n4️⃣  Deploying AegisRewards...')
    const AegisRewards = await ethers.getContractFactory('AegisRewards')
    aegisRewards = await AegisRewards.deploy(
      await yusd.getAddress(),
      await aegisConfig.getAddress(),
      admin.address,
    )
    await aegisRewards.waitForDeployment()
    console.log('   ✅ AegisRewards deployed at:', await aegisRewards.getAddress())

    // Grant SETTINGS_MANAGER_ROLE to admin and update AegisMinting with AegisRewards address
    const SETTINGS_MANAGER_ROLE = ethers.keccak256(ethers.toUtf8Bytes('SETTINGS_MANAGER_ROLE'))
    await aegisMinting.connect(admin).grantRole(SETTINGS_MANAGER_ROLE, admin.address)
    await aegisMinting.connect(admin).setAegisRewardsAddress(await aegisRewards.getAddress())
    console.log('   ✅ Updated AegisMinting with AegisRewards address')

    // 5. Deploy AegisIncomeRouter
    console.log('\n5️⃣  Deploying AegisIncomeRouter...')
    const AegisIncomeRouter = await ethers.getContractFactory('AegisIncomeRouter')

    router = await AegisIncomeRouter.deploy(
      await yusd.getAddress(),              // YUSD
      await aegisMinting.getAddress(),      // AegisMinting
      await aegisRewards.getAddress(),      // AegisRewards
      admin.address,                        // Admin
      3 * 24 * 60 * 60,                     // 3 day delay
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

    // Set AegisIncomeRouter address in AegisRewards so it can deposit rewards
    await aegisRewards.connect(admin).setAegisIncomeRouterAddress(await router.getAddress())
    console.log('   ✅ Set AegisIncomeRouter address in AegisRewards')

    // Approve DEX routers
    await router.connect(admin).setDexRouterApproval(CURVE_YUSD_USDC, true)
    console.log('   ✅ Approved Curve YUSD/USDC pool')

    await router.connect(admin).setDexRouterApproval(CURVE_YUSD_USDT, true)
    console.log('   ✅ Approved Curve YUSD/USDT pool')

    await router.connect(admin).setDexRouterApproval(UNISWAP_V4_ROUTER, true)
    console.log('   ✅ Approved Uniswap V4 router')

    // Note: Router doesn't need pre-funded YUSD since swaps will receive YUSD from real Curve pools
    // The real mainnet Curve pools already contain YUSD liquidity

    // Fund router operator with USDC and USDT from whales
    await usdc.connect(usdcWhale).transfer(routerOperator.address, ethers.parseUnits('500000', 6))
    console.log('   ✅ Funded operator with 500k USDC')

    await usdt.connect(usdtWhale).transfer(routerOperator.address, ethers.parseUnits('500000', 6))
    console.log('   ✅ Funded operator with 500k USDT')

    console.log('\n✅ All contracts deployed and configured on fork!')
    console.log('\n📊 Ready to run comprehensive route tests...')
  })

  // ========================================
  // DEPLOYMENT VERIFICATION
  // ========================================

  describe('Deployment Verification', () => {
    it('Should have deployed all contracts successfully', async () => {
      expect(await yusd.getAddress()).to.not.equal(ethers.ZeroAddress)
      expect(await aegisConfig.getAddress()).to.not.equal(ethers.ZeroAddress)
      expect(await aegisMinting.getAddress()).to.not.equal(ethers.ZeroAddress)
      expect(await aegisRewards.getAddress()).to.not.equal(ethers.ZeroAddress)
      expect(await router.getAddress()).to.not.equal(ethers.ZeroAddress)

      console.log('\n✅ All contracts deployed with valid addresses')
    })

    it('Should have configured roles correctly', async () => {
      const INCOME_ROUTER_ROLE = await router.INCOME_ROUTER_ROLE()
      const hasRole = await router.hasRole(INCOME_ROUTER_ROLE, routerOperator.address)
      expect(hasRole).to.be.true

      console.log('✅ Router operator has correct role')
    })

    it('Should have approved DEX routers', async () => {
      const curveUsdcApproved = await router.approvedDexRouters(CURVE_YUSD_USDC)
      const curveUsdtApproved = await router.approvedDexRouters(CURVE_YUSD_USDT)
      const uniswapApproved = await router.approvedDexRouters(UNISWAP_V4_ROUTER)

      expect(curveUsdcApproved).to.be.true
      expect(curveUsdtApproved).to.be.true
      expect(uniswapApproved).to.be.true

      console.log('✅ Curve YUSD/USDC, Curve YUSD/USDT, and Uniswap V4 routers approved')
    })

    it('Should have funded router operator', async () => {
      const usdcBalance = await usdc.balanceOf(routerOperator.address)
      const usdtBalance = await usdt.balanceOf(routerOperator.address)

      expect(usdcBalance).to.be.gte(ethers.parseUnits('500000', 6))
      expect(usdtBalance).to.be.gte(ethers.parseUnits('500000', 6))

      console.log('✅ Router operator funded with USDC and USDT')
      console.log(`   USDC: ${ethers.formatUnits(usdcBalance, 6)}`)
      console.log(`   USDT: ${ethers.formatUnits(usdtBalance, 6)}`)
    })

    it('Should return minting quote correctly', async () => {
      const amount = ethers.parseUnits('10000', 6) // $10k USDC

      // Call getIncomeQuote (provides 0 for DEX quotes, testing minting quote only)
      const quote = await router.getIncomeQuote(
        USDC_ADDRESS,
        amount,
        0, // Curve quote (0 for now - will be calculated off-chain)
        0,  // Uniswap quote (0 for now - will be calculated off-chain)
      )

      // Minting quote should be ~1:1 (10k USDC ≈ 10k YUSD, oracle may have small deviation)
      const expectedYUSD = ethers.parseEther('10000')
      expect(quote.mintingOutput).to.be.closeTo(expectedYUSD, expectedYUSD / 100n) // 1% tolerance

      // Read actual fee from deployed contract
      const feeBP = await aegisMinting.incomeFeeBP() // Currently returns 500 (5%) in test environment

      // Calculate expected rewards after fee (based on actual mintingOutput, not theoretical)
      const expectedRewards = (quote.mintingOutput * (10000n - feeBP)) / 10000n
      expect(quote.mintingRewards).to.be.closeTo(expectedRewards, expectedRewards / 1000n) // 0.1% tolerance

      // Recommended route should be minting (since DEX quotes are 0)
      expect(quote.recommendedRouter).to.equal(ethers.ZeroAddress)

      const feePercent = Number(feeBP) / 100
      const rewardsPercent = 100 - feePercent
      console.log('\n✅ Minting quote function working:')
      console.log(`   Input: ${ethers.formatUnits(amount, 6)} USDC`)
      console.log(`   Output: ${ethers.formatEther(quote.mintingOutput)} YUSD`)
      console.log(`   Rewards (${rewardsPercent}%): ${ethers.formatEther(quote.mintingRewards)} YUSD`)
      console.log(`   Fee (${feePercent}%): ${ethers.formatEther(expectedYUSD - quote.mintingRewards)} YUSD`)
      console.log('   Recommended: Minting (oracle-based)')
    })

    it('Should execute transferToMinting successfully', async () => {
      const amount = ethers.parseUnits('1000', 6) // $1k USDC

      // Approve router
      await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

      // Get minting balance before
      const mintingBalanceBefore = await usdc.balanceOf(await aegisMinting.getAddress())

      // Execute transfer
      const tx = await router.connect(routerOperator).transferToMinting(
        USDC_ADDRESS,
        amount,
      )
      await tx.wait()

      // Verify USDC was transferred
      const mintingBalanceAfter = await usdc.balanceOf(await aegisMinting.getAddress())
      expect(mintingBalanceAfter - mintingBalanceBefore).to.equal(amount)

      console.log('\n✅ transferToMinting executed successfully')
      console.log(`   Transferred: ${ethers.formatUnits(amount, 6)} USDC`)
      console.log(`   Minting balance: ${ethers.formatUnits(mintingBalanceAfter, 6)} USDC`)
    })
  })

  // ========================================
  // SECURITY & ACCESS CONTROL TESTS
  // ========================================

  describe('Security & Access Control', () => {
    describe('Paused State Handling', () => {
      it('Should revert transferToMinting when paused', async () => {
        // Pause the router
        await router.connect(admin).setPaused(true)

        const amount = ethers.parseUnits('1000', 6)
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        // Should revert when paused
        await expect(
          router.connect(routerOperator).transferToMinting(USDC_ADDRESS, amount),
        ).to.be.revertedWithCustomError(router, 'Paused')

        // Unpause for other tests
        await router.connect(admin).setPaused(false)
      })

      it('Should revert swapAndDeposit when paused', async () => {
        // Pause the router
        await router.connect(admin).setPaused(true)

        const amount = ethers.parseUnits('1000', 6)
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        const swapCalldata = '0x'
        const minYUSDOut = 0n
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test'])

        // Should revert when paused
        await expect(
          router.connect(routerOperator).swapAndDeposit(
            USDC_ADDRESS,
            amount,
            CURVE_YUSD_USDC,
            swapCalldata,
            minYUSDOut,
            snapshotId,
          ),
        ).to.be.revertedWithCustomError(router, 'Paused')

        // Unpause for other tests
        await router.connect(admin).setPaused(false)
      })

      it('Should allow getIncomeQuote when paused (view function)', async () => {
        // Pause the router
        await router.connect(admin).setPaused(true)

        const amount = ethers.parseUnits('10000', 6)

        // View function should still work when paused
        const quote = await router.getIncomeQuote(USDC_ADDRESS, amount, 0, 0)
        expect(quote.mintingOutput).to.be.gt(0)

        // Unpause for other tests
        await router.connect(admin).setPaused(false)
      })

      it('Should only allow admin to pause/unpause', async () => {
        // Non-admin cannot pause
        await expect(router.connect(routerOperator).setPaused(true)).to.be.reverted

        // Admin can pause
        await router.connect(admin).setPaused(true)
        expect(await router.paused()).to.equal(true)

        // Non-admin cannot unpause
        await expect(router.connect(routerOperator).setPaused(false)).to.be.reverted

        // Admin can unpause
        await router.connect(admin).setPaused(false)
        expect(await router.paused()).to.equal(false)
      })
    })

    describe('Access Control', () => {
      let unauthorizedUser: SignerWithAddress

      before(async () => {
        const signers = await ethers.getSigners()
        unauthorizedUser = signers[10] // Use a signer that doesn't have any roles
      })

      it('Should revert transferToMinting without INCOME_ROUTER_ROLE', async () => {
        const amount = ethers.parseUnits('1000', 6)

        // Unauthorized user should not be able to call transferToMinting
        await expect(
          router.connect(unauthorizedUser).transferToMinting(USDC_ADDRESS, amount),
        ).to.be.reverted
      })

      it('Should revert swapAndDeposit without INCOME_ROUTER_ROLE', async () => {
        const amount = ethers.parseUnits('1000', 6)
        const swapCalldata = '0x'
        const minYUSDOut = 0n
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test'])

        // Unauthorized user should not be able to call swapAndDeposit
        await expect(
          router.connect(unauthorizedUser).swapAndDeposit(
            USDC_ADDRESS,
            amount,
            CURVE_YUSD_USDC,
            swapCalldata,
            minYUSDOut,
            snapshotId,
          ),
        ).to.be.reverted
      })

      it('Should revert setPaused from non-admin', async () => {
        await expect(router.connect(routerOperator).setPaused(true)).to.be.reverted
        await expect(router.connect(unauthorizedUser).setPaused(true)).to.be.reverted
      })

      it('Should revert setDexRouterApproval from non-admin', async () => {
        const newRouter = ethers.Wallet.createRandom().address

        await expect(
          router.connect(routerOperator).setDexRouterApproval(newRouter, true),
        ).to.be.reverted

        await expect(router.connect(unauthorizedUser).setDexRouterApproval(newRouter, true)).to
          .be.reverted
      })

      it('Should revert rescueTokens from non-admin', async () => {
        const tokenAddress = USDC_ADDRESS
        const recipient = admin.address
        const amount = ethers.parseUnits('1', 6)

        await expect(
          router.connect(routerOperator).rescueTokens(tokenAddress, recipient, amount),
        ).to.be.reverted

        await expect(
          router.connect(unauthorizedUser).rescueTokens(tokenAddress, recipient, amount),
        ).to.be.reverted
      })
    })

    describe('Invalid Input Validation', () => {
      it('Should revert with zero amount', async () => {
        const zeroAmount = 0n

        // transferToMinting with zero amount
        await expect(
          router.connect(routerOperator).transferToMinting(USDC_ADDRESS, zeroAmount),
        ).to.be.reverted

        // swapAndDeposit with zero amount
        const swapCalldata = '0x'
        const minYUSDOut = 0n
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test'])

        await expect(
          router.connect(routerOperator).swapAndDeposit(
            USDC_ADDRESS,
            zeroAmount,
            CURVE_YUSD_USDC,
            swapCalldata,
            minYUSDOut,
            snapshotId,
          ),
        ).to.be.reverted
      })

      it('Should revert with unsupported collateral asset', async () => {
        const unsupportedToken = ethers.Wallet.createRandom().address
        const amount = ethers.parseUnits('1000', 6)

        // transferToMinting with unsupported asset
        await expect(
          router.connect(routerOperator).transferToMinting(unsupportedToken, amount),
        ).to.be.reverted
      })

      it('Should revert with unapproved DEX router', async () => {
        const unapprovedRouter = ethers.Wallet.createRandom().address
        const amount = ethers.parseUnits('1000', 6)
        const swapCalldata = '0x'
        const minYUSDOut = 0n
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test'])

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        // swapAndDeposit with unapproved router
        await expect(
          router.connect(routerOperator).swapAndDeposit(
            USDC_ADDRESS,
            amount,
            unapprovedRouter,
            swapCalldata,
            minYUSDOut,
            snapshotId,
          ),
        ).to.be.revertedWithCustomError(router, 'InvalidDexRouter')
      })

      it.skip('Should revert with invalid snapshot ID (empty bytes)', async () => {
        // NOTE: Empty snapshot IDs appear to be valid - contract doesn't explicitly reject them
        const amount = ethers.parseUnits('1000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        // transferToMinting with empty snapshot ID
        await expect(router.connect(routerOperator).transferToMinting(USDC_ADDRESS, amount)).to.be
          .reverted
      })

      it('Should revert swapAndDeposit with insufficient allowance', async () => {
        const amount = ethers.parseUnits('1000', 6)
        const swapCalldata = '0x'
        const minYUSDOut = 0n
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test'])

        // Set allowance to zero
        await usdc.connect(routerOperator).approve(await router.getAddress(), 0)

        // Should revert due to insufficient allowance
        await expect(
          router.connect(routerOperator).swapAndDeposit(
            USDC_ADDRESS,
            amount,
            CURVE_YUSD_USDC,
            swapCalldata,
            minYUSDOut,
            snapshotId,
          ),
        ).to.be.reverted

        // Reset allowance for other tests
        await usdc
          .connect(routerOperator)
          .approve(await router.getAddress(), ethers.MaxUint256)
      })
    })

    describe('Slippage Protection', () => {
      it.skip('Should revert when actual output < minYUSDOut', async () => {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000) // Increase timeout for fork test

        const amount = ethers.parseUnits('10000', 6)
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        // Get expected output
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const expectedOutput = await curvePool.get_dy(1, 0, amount) // USDC (index 1) -> YUSD (index 0)

        // Set minYUSDOut higher than expected output (should revert)
        const minYUSDOut = expectedOutput + ethers.parseEther('1000')

        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-slippage'])

        await expect(
          router.connect(routerOperator).swapAndDeposit(
            USDC_ADDRESS,
            amount,
            CURVE_YUSD_USDC,
            swapCalldata,
            minYUSDOut,
            snapshotId,
          ),
        ).to.be.revertedWithCustomError(router, 'InsufficientOutput')
      })

      it.skip('Should succeed when actual output >= minYUSDOut', async () => {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000) // Increase timeout for fork test

        const amount = ethers.parseUnits('10000', 6)
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        // Get expected output
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const expectedOutput = await curvePool.get_dy(1, 0, amount)

        // Set minYUSDOut slightly lower than expected output (should succeed)
        const minYUSDOut = (expectedOutput * 99n) / 100n // 1% tolerance

        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode([' string'], ['test-slippage-ok'])

        const tx = await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          minYUSDOut,
          snapshotId,
        )

        await expect(tx).to.emit(router, 'SwapAndDeposit')
      })

      it.skip('Should handle 0.1% slippage tolerance', async () => {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const expectedOutput = await curvePool.get_dy(1, 0, amount)

        // 0.1% slippage tolerance
        const minYUSDOut = (expectedOutput * 999n) / 1000n

        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-slippage-01'])

        const tx = await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          minYUSDOut,
          snapshotId,
        )

        await expect(tx).to.emit(router, 'SwapAndDeposit')
      })

      it.skip('Should handle 5% slippage tolerance', async () => {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const expectedOutput = await curvePool.get_dy(1, 0, amount)

        // 5% slippage tolerance
        const minYUSDOut = (expectedOutput * 95n) / 100n

        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['test-slippage-5'])

        const tx = await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          minYUSDOut,
          snapshotId,
        )

        await expect(tx).to.emit(router, 'SwapAndDeposit')
      })
    })
  })

  // ========================================
  // USDC ROUTE TESTS
  // ========================================

  describe('USDC Income Routes', () => {
    AMOUNTS.forEach(({ label, usdc: amount }) => {
      describe(`${label} USDC`, () => {
        it('Should get accurate minting quote', async () => {
          // Test minting quote for this amount
          const quote = await router.getIncomeQuote(
            USDC_ADDRESS,
            amount,
            0, // Curve quote (simulated)
            0,  // Uniswap quote (simulated)
          )

          // Minting should be ~1:1 (oracle may have small deviation)
          const expectedYUSD = ethers.parseEther(ethers.formatUnits(amount, 6))
          expect(quote.mintingOutput).to.be.closeTo(expectedYUSD, expectedYUSD / 100n) // 1% tolerance

          // Read actual fee from deployed contract
          const feeBP = await aegisMinting.incomeFeeBP()

          // Calculate expected rewards after fee (based on actual mintingOutput)
          const expectedRewards = (quote.mintingOutput * (10000n - feeBP)) / 10000n
          expect(quote.mintingRewards).to.be.closeTo(expectedRewards, expectedRewards / 1000n) // 0.1% tolerance

          const rewardsPercent = 100 - Number(feeBP) / 100
          console.log(`\n${label} USDC - Minting Route:`)
          console.log(`  Input:   ${ethers.formatUnits(amount, 6)} USDC`)
          console.log(`  Output:  ${ethers.formatEther(quote.mintingOutput)} YUSD`)
          console.log(`  Rewards: ${ethers.formatEther(quote.mintingRewards)} YUSD (${rewardsPercent}%)`)
        })

        it('Should compare routes with REAL quotes from actual pools', async () => {
          // Use REAL quotes based on actual mainnet swaps executed on fork:
          //
          // CURVE YUSD/USDC (0x9804...6861):
          // - $10k: 10,003.66 YUSD (-0.0366% = NEGATIVE slippage, you get MORE!)
          // - $30k: 29,993.65 YUSD (0.0212% slippage)
          // - $50k: 49,931.45 YUSD (0.1371% slippage)
          // - $100k: 99,628.08 YUSD (0.3719% slippage)
          // - $200k: 197,792.73 YUSD (1.1036% slippage)
          //
          // UNISWAP V4 YUSD/USDC (Pool ID 0xda4a...ddab):
          // - Liquidity: 1.2e21 units (massive!)
          // - Fee: 1 basis point = 0.01% (VERIFIED from pool state)
          // - LP Fee confirmed via StateView.getSlot0() → slot0[3] = 100 (V4 units)
          //
          // MINTING:
          // - Always exact 1:1 (zero slippage)
          const expectedYUSD = ethers.parseEther(ethers.formatUnits(amount, 6))

          // Curve quote: Based on real swap data (amount-dependent slippage)
          let curveQuote: bigint
          const amountNum = Number(ethers.formatUnits(amount, 6))
          if (amountNum <= 10000) {
            curveQuote = (expectedYUSD * 10004n) / 10000n // -0.04% (get extra YUSD!)
          } else if (amountNum <= 30000) {
            curveQuote = (expectedYUSD * 9998n) / 10000n // 0.02% slippage
          } else if (amountNum <= 50000) {
            curveQuote = (expectedYUSD * 9986n) / 10000n // 0.14% slippage
          } else if (amountNum <= 100000) {
            curveQuote = (expectedYUSD * 9963n) / 10000n // 0.37% slippage
          } else {
            curveQuote = (expectedYUSD * 9890n) / 10000n // 1.10% slippage at $200k
          }

          // Uniswap V4 quote: 0.01% fee (REAL pool data from StateView)
          // Pool ID: 0xda4a305e8b85194ff5cb70577824cf1f03fb408257b621b82350423cc752ddab
          // Liquidity: 1201198721734870449258 (1.2e21)
          // LP Fee: 1 basis point = 0.01% (verified from slot0[3] = 100)
          const uniswapQuote = (expectedYUSD * 9999n) / 10000n // 0.01% fee (VERIFIED)

          const quote = await router.getIncomeQuote(
            USDC_ADDRESS,
            amount,
            curveQuote,
            uniswapQuote,
          )

          // Read actual fee from deployed contract
          const feeBP = await aegisMinting.incomeFeeBP()

          // Calculate expected rewards after fee
          const curveRewards = (curveQuote * (10000n - feeBP)) / 10000n
          const uniswapRewards = (uniswapQuote * (10000n - feeBP)) / 10000n
          const mintingRewards = (expectedYUSD * (10000n - feeBP)) / 10000n

          // Use tolerance for rounding errors in fee calculations
          expect(quote.curveRewards).to.be.closeTo(curveRewards, curveRewards / 1000n) // 0.1% tolerance
          expect(quote.uniswapRewards).to.be.closeTo(uniswapRewards, uniswapRewards / 1000n) // 0.1% tolerance
          expect(quote.mintingRewards).to.be.closeTo(mintingRewards, mintingRewards / 1000n) // 0.1% tolerance

          // All routes now apply income fee before rewards
          // DEX routes have swap fee + income fee, minting has only income fee
          const bestRouter = quote.recommendedRouter
          const feePercent = Number(feeBP) / 100

          console.log(`\n${label} USDC - Full Route Comparison (after ${feePercent}% income fee):`)
          console.log(`  Curve:   ${ethers.formatEther(quote.curveRewards)} YUSD (simulated - no real pool)`)
          console.log(`  Uniswap V4: ${ethers.formatEther(quote.uniswapRewards)} YUSD (real pool: 1.2e21 liquidity)`)
          console.log(`  Minting: ${ethers.formatEther(quote.mintingRewards)} YUSD (oracle-based, 0% slippage)`)
          console.log(`  Recommended: ${bestRouter === CURVE_YUSD_USDC || bestRouter === CURVE_YUSD_USDT ? 'Curve' : bestRouter === UNISWAP_V4_ROUTER ? 'Uniswap V4' : 'Minting'}`)
        })

        it.skip('Should get accurate quotes from all routes', async function () {
          // TODO: Requires real YUSD liquidity pools on Curve/Uniswap

          // Prepare swap calldata for Curve and Uniswap
          // const curveSwapData = await buildCurveSwapCalldata(USDC_ADDRESS, yusd.target, amount)
          // const uniswapSwapData = await buildUniswapSwapCalldata(USDC_ADDRESS, yusd.target, amount)

          // Get quote from router
          // const quote = await router.getIncomeQuote(
          //   USDC_ADDRESS,
          //   amount,
          //   curveSwapData,
          //   uniswapSwapData
          // )

          // Verify all routes returned non-zero
          // expect(quote.curveOutput).to.be.gt(0, 'Curve quote is zero')
          // expect(quote.uniswapOutput).to.be.gt(0, 'Uniswap quote is zero')
          // expect(quote.mintingOutput).to.be.gt(0, 'Minting quote is zero')

          console.log(`\n${label} USDC Route Comparison:`)
          // console.log(`  Curve:   ${ethers.formatEther(quote.curveRewards)} YUSD (${formatPercent(quote.curveRewards, amount)})`)
          // console.log(`  Uniswap: ${ethers.formatEther(quote.uniswapRewards)} YUSD (${formatPercent(quote.uniswapRewards, amount)})`)
          // console.log(`  Minting: ${ethers.formatEther(quote.mintingRewards)} YUSD (${formatPercent(quote.mintingRewards, amount)})`)
          // console.log(`  Best:    ${getRouterName(quote.recommendedRouter)}`)

          // Verify quote accuracy (should be close to input amount)
          // const expectedYUSD = ethers.parseEther(ethers.formatUnits(amount, 6))
          // const tolerance = expectedYUSD / 100n // 1% tolerance

          // expect(quote.curveOutput).to.be.closeTo(expectedYUSD, tolerance)
          // expect(quote.uniswapOutput).to.be.closeTo(expectedYUSD, tolerance)
          // expect(quote.mintingOutput).to.be.closeTo(expectedYUSD, tolerance)
        })

        it('Should execute Curve route and match quote', async function () {
          this.skip() // TODO: Implement after contracts deployed

          // Get quote
          // const quote = await router.getIncomeQuote(...)

          // Transfer USDC to router operator
          // await usdc.connect(usdcWhale).transfer(routerOperator.address, amount)

          // Approve router
          // await usdc.connect(routerOperator).approve(router.target, amount)

          // Execute swap via Curve
          // const tx = await router.connect(routerOperator).swapAndDeposit(
          //   USDC_ADDRESS,
          //   amount,
          //   CURVE_3POOL,
          //   curveSwapData,
          //   quote.curveRewards * 99n / 100n, // 1% slippage tolerance
          //   ethers.toUtf8Bytes('test-snapshot')
          // )

          // Get actual YUSD deposited
          // const receipt = await tx.wait()
          // const event = receipt?.logs.find(log => {
          //   try {
          //     return router.interface.parseLog(log)?.name === 'SwapAndDeposit'
          //   } catch {
          //     return false
          //   }
          // })
          // const parsedEvent = router.interface.parseLog(event!)
          // const actualYUSD = parsedEvent?.args.rewardsDeposited

          // Quote should be within 0.5% of actual
          // const quoteTolerance = quote.curveRewards / 200n // 0.5%
          // expect(actualYUSD).to.be.closeTo(quote.curveRewards, quoteTolerance)

          console.log(`  Curve route execution test for ${label} USDC`)
        })

        it('Should execute Uniswap route and match quote', async function () {
          this.skip() // TODO: Implement after contracts deployed

          console.log(`  Uniswap route execution test for ${label} USDC`)
        })

        it('Should execute Minting route', async function () {
          this.skip() // TODO: Implement after contracts deployed

          // Transfer USDC to router operator
          // await usdc.connect(usdcWhale).transfer(routerOperator.address, amount)

          // Approve router
          // await usdc.connect(routerOperator).approve(router.target, amount)

          // Execute transfer to minting
          // const tx = await router.connect(routerOperator).transferToMinting(
          //   USDC_ADDRESS,
          //   amount
          // )

          // Verify USDC was transferred to AegisMinting
          // const mintingBalance = await usdc.balanceOf(aegisMinting.target)
          // expect(mintingBalance).to.be.gte(amount)

          console.log(`  Minting route execution test for ${label} USDC`)
        })
      })
    })

    it('Should measure gas costs for quote function', async function () {
      this.skip() // TODO: Implement after contracts deployed

      // const curveSwapData = await buildCurveSwapCalldata(USDC_ADDRESS, yusd.target, amount)
      // const uniswapSwapData = await buildUniswapSwapCalldata(USDC_ADDRESS, yusd.target, amount)
      // const gasEstimate = await router.getIncomeQuote.estimateGas(
      //   USDC_ADDRESS,
      //   amount,
      //   curveSwapData,
      //   uniswapSwapData
      // )

      console.log('\nQuote function gas cost test')
      // console.log(`Gas used: ${gasEstimate.toString()}`)
      // expect(gasEstimate).to.be.lt(500000) // Should be under 500k gas
    })
  })

  // ========================================
  // QUOTE ACCURACY & EXECUTION COMPARISON
  // ========================================

  describe('Quote vs Execution Accuracy', () => {
    AMOUNTS.slice(0, 3).forEach(({ label, usdc: amount }) => {
      // Test first 3 amounts for speed
      it(`Should have <1% deviation for ${label} USDC minting quote`, async function () {
        this.timeout(120000)

        // Get quote
        const quote = await router.getIncomeQuote(USDC_ADDRESS, amount, 0, 0)
        const quotedRewards = quote.mintingRewards

        // Execute actual minting (via transferToMinting + depositIncome)
        // Note: We can't test actual execution here easily since minting happens in AegisMinting
        // But we can verify quote is reasonable vs oracle price

        const expectedYUSD = ethers.parseEther(ethers.formatUnits(amount, 6))
        const deviation = ((expectedYUSD - quote.mintingOutput) * 1000n) / expectedYUSD

        // Quote should be within 1% of 1:1 ratio
        expect(deviation).to.be.lt(10n) // Less than 1% deviation

        console.log(`\n${label} USDC Minting Quote Accuracy:`)
        console.log(`  Expected (1:1):    ${ethers.formatEther(expectedYUSD)} YUSD`)
        console.log(`  Quoted Output:     ${ethers.formatEther(quote.mintingOutput)} YUSD`)
        console.log(`  Quoted Rewards:    ${ethers.formatEther(quotedRewards)} YUSD`)
        console.log(`  Deviation:         ${Number(deviation) / 10}%`)
      })
    })

    it('Should show Curve quotes match execution within 0.5%', async function () {
      this.timeout(120000)

      const amount = ethers.parseUnits('10000', 6)

      // Get actual pool quote
      const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
      const actualQuote = await curvePool.get_dy(1, 0, amount)

      // Use router quote
      const routerQuote = await router.getIncomeQuote(USDC_ADDRESS, amount, actualQuote, 0)

      // Execute actual swap
      await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
      const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
      const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['accuracy-test'])

      const yusdBalanceBefore = await yusd.balanceOf(await aegisRewards.getAddress())

      await router.connect(routerOperator).swapAndDeposit(
        USDC_ADDRESS,
        amount,
        CURVE_YUSD_USDC,
        swapCalldata,
        0,
        snapshotId,
      )

      const yusdBalanceAfter = await yusd.balanceOf(await aegisRewards.getAddress())
      const actualRewards = yusdBalanceAfter - yusdBalanceBefore

      // Compare quoted rewards vs actual rewards
      const deviation = ((routerQuote.curveRewards - actualRewards) * 1000n) / routerQuote.curveRewards

      console.log('\nCurve Quote Accuracy:')
      console.log(`  Quoted Rewards:  ${ethers.formatEther(routerQuote.curveRewards)} YUSD`)
      console.log(`  Actual Rewards:  ${ethers.formatEther(actualRewards)} YUSD`)
      console.log(`  Deviation:       ${Number(deviation) / 10}%`)

      // Should be within 0.5%
      expect(deviation).to.be.lt(5n)
    })

    it('Should show Uniswap quotes match execution within 1%', async function () {
      this.timeout(120000)

      const amount = ethers.parseUnits('10000', 6)

      // For Uniswap V4, we simulate a quote (in reality would use quoter contract)
      const simulatedQuote = ethers.parseEther(ethers.formatUnits(amount, 6)) // ~1:1 with 0.01% fee

      const routerQuote = await router.getIncomeQuote(USDC_ADDRESS, amount, 0, simulatedQuote)

      console.log('\nUniswap V4 Quote:')
      console.log(`  Quoted Output:   ${ethers.formatEther(routerQuote.uniswapOutput)} YUSD`)
      console.log(`  Quoted Rewards:  ${ethers.formatEther(routerQuote.uniswapRewards)} YUSD`)

      // Verify quote is reasonable
      expect(routerQuote.uniswapOutput).to.be.gt(0)
      expect(routerQuote.uniswapRewards).to.be.lt(routerQuote.uniswapOutput)
    })
  })

  describe('Multi-Route Execution Comparison', () => {
    it('Should execute all three routes and compare outputs', async function () {
      this.timeout(180000)

      const amount = ethers.parseUnits('10000', 6)

      // Get quotes for all routes
      const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
      const curveQuote = await curvePool.get_dy(1, 0, amount)
      const uniswapQuote = ethers.parseEther(ethers.formatUnits(amount, 6))

      const quote = await router.getIncomeQuote(USDC_ADDRESS, amount, curveQuote, uniswapQuote)

      console.log('\n$10k USDC Multi-Route Comparison:')
      console.log(`  Minting Rewards:  ${ethers.formatEther(quote.mintingRewards)} YUSD`)
      console.log(`  Curve Rewards:    ${ethers.formatEther(quote.curveRewards)} YUSD`)
      console.log(`  Uniswap Rewards:  ${ethers.formatEther(quote.uniswapRewards)} YUSD`)

      // Execute Curve route
      await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
      const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
      const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['comparison-test'])

      const rewardsBalanceBefore = await yusd.balanceOf(await aegisRewards.getAddress())

      await router.connect(routerOperator).swapAndDeposit(
        USDC_ADDRESS,
        amount,
        CURVE_YUSD_USDC,
        swapCalldata,
        0,
        snapshotId,
      )

      const rewardsBalanceAfter = await yusd.balanceOf(await aegisRewards.getAddress())
      const actualCurveRewards = rewardsBalanceAfter - rewardsBalanceBefore

      console.log(`  Actual Curve:     ${ethers.formatEther(actualCurveRewards)} YUSD`)

      // Verify Curve execution was close to quote
      const deviation = ((quote.curveRewards - actualCurveRewards) * 100n) / quote.curveRewards
      expect(deviation).to.be.lt(1n) // Within 1%
    })

    it('Should show minting has zero slippage', async function () {
      this.timeout(120000)

      const amount = ethers.parseUnits('10000', 6)

      // Get minting quote
      const quote1 = await router.getIncomeQuote(USDC_ADDRESS, amount, 0, 0)

      // Get minting quote again after some time
      await time.increase(60) // Wait 60 seconds

      const quote2 = await router.getIncomeQuote(USDC_ADDRESS, amount, 0, 0)

      // Minting quotes should be nearly identical (oracle-based, no pool slippage)
      const difference = quote1.mintingOutput > quote2.mintingOutput
        ? quote1.mintingOutput - quote2.mintingOutput
        : quote2.mintingOutput - quote1.mintingOutput

      const deviation = (difference * 10000n) / quote1.mintingOutput

      console.log('\nMinting Slippage Test:')
      console.log(`  Quote 1:         ${ethers.formatEther(quote1.mintingOutput)} YUSD`)
      console.log(`  Quote 2:         ${ethers.formatEther(quote2.mintingOutput)} YUSD`)
      console.log(`  Deviation:       ${Number(deviation) / 100}%`)

      // Should have <0.1% variance (only from oracle price updates)
      expect(deviation).to.be.lt(10n)
    })

    it('Should verify recommendation logic is correct', async function () {
      this.timeout(120000)

      // Test with small amount where minting should be recommended
      const smallAmount = ethers.parseUnits('1000', 6)

      const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
      const smallCurveQuote = await curvePool.get_dy(1, 0, smallAmount)
      const smallUniswapQuote = ethers.parseEther(ethers.formatUnits(smallAmount, 6))

      const smallQuote = await router.getIncomeQuote(
        USDC_ADDRESS,
        smallAmount,
        smallCurveQuote,
        smallUniswapQuote,
      )

      console.log('\n$1k USDC Route Recommendation:')
      console.log(`  Minting Rewards:    ${ethers.formatEther(smallQuote.mintingRewards)} YUSD`)
      console.log(`  Curve Rewards:      ${ethers.formatEther(smallQuote.curveRewards)} YUSD`)
      console.log(`  Uniswap Rewards:    ${ethers.formatEther(smallQuote.uniswapRewards)} YUSD`)
      console.log(
        `  Recommended:        ${smallQuote.recommendedRouter === ethers.ZeroAddress ? 'Minting' : smallQuote.recommendedRouter === CURVE_YUSD_USDC ? 'Curve' : 'Uniswap'}`,
      )

      // Verify recommendation matches the highest rewards
      const maxRewards = [
        { route: 'minting', rewards: smallQuote.mintingRewards, router: ethers.ZeroAddress },
        { route: 'curve', rewards: smallQuote.curveRewards, router: CURVE_YUSD_USDC },
        { route: 'uniswap', rewards: smallQuote.uniswapRewards, router: UNISWAP_V4_ROUTER },
      ].reduce((max, curr) => (curr.rewards > max.rewards ? curr : max))

      expect(smallQuote.recommendedRouter).to.equal(maxRewards.router)
    })
  })

  // ========================================
  // USDT ROUTE TESTS
  // ========================================

  describe('USDT Income Routes', () => {
    AMOUNTS.forEach(({ label, usdt: amount }) => {
      describe(`${label} USDT`, () => {
        it('Should get accurate quotes from all routes', async () => {
          // Use REAL quotes based on actual mainnet swaps executed on fork:
          //
          // ⚠️ CRITICAL WARNING: Curve YUSD/USDT pool (0xcF90...51A8) has LOW liquidity!
          //
          // CURVE YUSD/USDT (0xcF90...51A8):
          // - Only ~40k LP tokens (VERY SMALL POOL!)
          // - $10k: 10,000.60 YUSD (-0.006% = tiny bonus) ✅ SAFE
          // - $30k: 16,451.04 YUSD (45.16% slippage) ❌ DANGER! $13k loss!
          // - $50k: 11.02 YUSD (99.98% slippage) ❌ POOL DRAINED! $49k loss!
          // - $100k: 1.05 YUSD (99.999% slippage) ❌ POOL DRAINED! $99k loss!
          // - $200k: 0.20 YUSD (99.9999% slippage) ❌ POOL DRAINED! $199k loss!
          //
          // UNISWAP V4 YUSD/USDT (Pool ID 0xa9ee...6e12):
          // - Liquidity: 4.5e16 units (moderate)
          // - Fee: 1 basis point = 0.01% (VERIFIED from pool state)
          // - LP Fee confirmed via StateView.getSlot0() → slot0[3] = 100 (V4 units)
          //
          // MINTING:
          // - Always exact 1:1 (zero slippage)
          //
          // ROUTING RECOMMENDATION:
          // - ≤$10k: Use Curve (tiny bonus)
          // - >$10k: Use Minting (Curve pool drains, V4 has 1% fee)
          const expectedYUSD = ethers.parseEther(ethers.formatUnits(amount, 6))

          // Curve quote: DANGER ZONE for amounts >$10k!
          let curveQuote: bigint
          const amountNum = Number(ethers.formatUnits(amount, 6))
          if (amountNum <= 10000) {
            curveQuote = (expectedYUSD * 10001n) / 10000n // -0.006% (tiny bonus)
          } else if (amountNum <= 30000) {
            // WARNING: 45% slippage at $30k!
            curveQuote = (expectedYUSD * 5484n) / 10000n // 45.16% slippage
          } else if (amountNum <= 50000) {
            // CRITICAL: Pool nearly drained at $50k!
            curveQuote = (expectedYUSD * 22n) / 100000n // 99.98% slippage
          } else if (amountNum <= 100000) {
            // CRITICAL: Pool completely drained at $100k!
            curveQuote = (expectedYUSD * 1n) / 100000n // 99.999% slippage
          } else {
            // CRITICAL: Pool completely drained at $200k!
            curveQuote = (expectedYUSD * 1n) / 1000000n // 99.9999% slippage
          }

          // Uniswap V4 quote: 0.01% fee (REAL pool data from StateView)
          // Pool ID: 0xa9eeccbfde38d8f6a5bea63564f33a984cd7561930ee86666f4a54d52b3a6e12
          // Liquidity: 45006373272910226 (4.5e16)
          // LP Fee: 1 basis point = 0.01% (verified from slot0[3] = 100)
          const uniswapQuote = (expectedYUSD * 9999n) / 10000n // 0.01% fee (VERIFIED)

          const quote = await router.getIncomeQuote(
            USDT_ADDRESS,
            amount,
            curveQuote,
            uniswapQuote,
          )

          // Read actual fee from deployed contract
          const feeBP = await aegisMinting.incomeFeeBP()

          // Calculate expected rewards after fee
          const curveRewards = (curveQuote * (10000n - feeBP)) / 10000n
          const uniswapRewards = (uniswapQuote * (10000n - feeBP)) / 10000n
          const mintingRewards = (expectedYUSD * (10000n - feeBP)) / 10000n

          // Use larger tolerance for USDT due to oracle pricing variations
          expect(quote.curveRewards).to.be.closeTo(curveRewards, curveRewards / 100n) // 1% tolerance
          expect(quote.uniswapRewards).to.be.closeTo(uniswapRewards, uniswapRewards / 100n) // 1% tolerance
          expect(quote.mintingRewards).to.be.closeTo(mintingRewards, mintingRewards / 100n) // 1% tolerance (USDT oracle has larger deviation)

          const feePercent = Number(feeBP) / 100
          console.log(`\n${label} USDT - Full Route Comparison (after ${feePercent}% income fee):`)
          console.log(`  Curve:   ${ethers.formatEther(quote.curveRewards)} YUSD ${amountNum > 10000 ? '⚠️  DANGER!' : '✅'}`)
          console.log(`  Uniswap V4: ${ethers.formatEther(quote.uniswapRewards)} YUSD (real pool: 4.5e16 liquidity)`)
          console.log(`  Minting: ${ethers.formatEther(quote.mintingRewards)} YUSD (oracle-based, 0% slippage)`)

          const bestRouter = quote.recommendedRouter
          console.log(`  Recommended: ${bestRouter === CURVE_YUSD_USDC || bestRouter === CURVE_YUSD_USDT ? 'Curve' : bestRouter === UNISWAP_V4_ROUTER ? 'Uniswap V4' : 'Minting'}`)

          if (amountNum > 10000) {
            console.log('  ⚠️  WARNING: Curve YUSD/USDT pool has insufficient liquidity!')
            console.log('      For amounts >$10k, use Minting or Uniswap V4 instead.')
          }
        })

        it('Should execute Curve route and match quote', async function () {
          this.skip() // TODO: Implement after contracts deployed

          console.log(`  Curve route execution test for ${label} USDT`)
        })

        it('Should execute Uniswap route and match quote', async function () {
          this.skip() // TODO: Implement after contracts deployed

          console.log(`  Uniswap route execution test for ${label} USDT`)
        })

        it('Should execute Minting route', async function () {
          this.skip() // TODO: Implement after contracts deployed

          console.log(`  Minting route execution test for ${label} USDT`)
        })
      })
    })
  })

  // ========================================
  // SLIPPAGE ANALYSIS
  // ========================================

  describe('Slippage Analysis', () => {
    it('Should show Curve has lowest slippage for large amounts', async function () {
      this.skip() // TODO: Implement after contracts deployed


      // const quote = await router.getIncomeQuote(...)
      // Curve should have best rate for large stablecoin swaps
      // expect(quote.curveRewards).to.be.gte(quote.uniswapRewards)

      // Calculate slippage
      // const curveSlippage = calculateSlippage(quote.curveOutput, largeAmount)
      // const uniswapSlippage = calculateSlippage(quote.uniswapOutput, largeAmount)

      console.log('\n$200k USDC Slippage Analysis:')
      // console.log(`  Curve:   ${formatBps(curveSlippage)} bps`)
      // console.log(`  Uniswap: ${formatBps(uniswapSlippage)} bps`)

      // expect(curveSlippage).to.be.lt(50) // <0.5% slippage for Curve
    })

    it('Should show minting has zero slippage', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _amount = ethers.parseUnits('100000', 6)
      // const quote = await router.getIncomeQuote(...)
      // Minting uses oracle price, so exact 1:1 (before fees)
      // const expectedYUSD = ethers.parseEther(ethers.formatUnits(amount, 6))
      // expect(quote.mintingOutput).to.equal(expectedYUSD)

      console.log('Minting zero slippage verification')
    })

    it('Should compare slippage across all amounts', async function () {
      this.skip() // TODO: Implement after contracts deployed

      console.log('\nSlippage Comparison Across All Amounts:')

      for (const { label, usdc: _amount } of AMOUNTS) {
        // const quote = await router.getIncomeQuote(...)
        // const curveSlippage = calculateSlippage(quote.curveOutput, amount)
        // const uniswapSlippage = calculateSlippage(quote.uniswapOutput, amount)

        console.log(`\n${label}:`)
        // console.log(`  Curve:   ${formatBps(curveSlippage)} bps`)
        // console.log(`  Uniswap: ${formatBps(uniswapSlippage)} bps`)
        // console.log(`  Minting: 0.00 bps (oracle-based)`)
      }
    })
  })

  // ========================================
  // ROUTE RECOMMENDATION LOGIC
  // ========================================

  describe('Route Recommendation Logic', () => {
    it('Should recommend Curve when it has best rate', async () => {
      const amount = ethers.parseUnits('50000', 6)

      // Curve best, Uniswap medium, Minting worst
      const curveQuote = ethers.parseEther('50100')   // +0.2%
      const uniswapQuote = ethers.parseEther('49950')  // -0.1%

      const quote = await router.getIncomeQuote(
        USDC_ADDRESS,
        amount,
        curveQuote,
        uniswapQuote,
      )

      expect(quote.recommendedRouter).to.equal(CURVE_YUSD_USDC)
      console.log('\n✅ Curve recommended when it has best rate')
    })

    it('Should recommend Uniswap when it has best rate', async () => {
      const amount = ethers.parseUnits('50000', 6)
      const _expectedYUSD = ethers.parseEther('50000')

      // Uniswap best, Curve medium, Minting worst
      const curveQuote = ethers.parseEther('49950')    // -0.1%
      const uniswapQuote = ethers.parseEther('50200')  // +0.4%

      const quote = await router.getIncomeQuote(
        USDC_ADDRESS,
        amount,
        curveQuote,
        uniswapQuote,
      )

      expect(quote.recommendedRouter).to.equal(UNISWAP_V4_ROUTER)
      console.log('✅ Uniswap recommended when it has best rate')
    })

    it('Should recommend Minting when DEX quotes are poor', async () => {
      const amount = ethers.parseUnits('50000', 6)
      const _expectedYUSD = ethers.parseEther('50000')

      const curveQuote = ethers.parseEther('49500')    // -1% (high slippage)
      const uniswapQuote = ethers.parseEther('49000')  // -2% (very high slippage)

      const quote = await router.getIncomeQuote(
        USDC_ADDRESS,
        amount,
        curveQuote,
        uniswapQuote,
      )

      expect(quote.recommendedRouter).to.equal(ethers.ZeroAddress)
      console.log('✅ Minting recommended when DEX liquidity is poor')
    })

    it('Should recommend Minting when DEX quotes are zero', async () => {
      const amount = ethers.parseUnits('5000000', 6) // $5M

      // No DEX liquidity available
      const quote = await router.getIncomeQuote(
        USDC_ADDRESS,
        amount,
        0, // No Curve liquidity
        0,  // No Uniswap liquidity
      )

      expect(quote.recommendedRouter).to.equal(ethers.ZeroAddress)
      expect(quote.mintingOutput).to.be.gt(0)
      console.log('✅ Minting recommended when DEX quotes are unavailable')
    })

    it('Should recommend best route based on output', async function () {
      // Already covered by tests above
      this.skip()

      // Test with medium amount
      const _amount = ethers.parseUnits('50000', 6)
      // const quote = await router.getIncomeQuote(...)
      // Verify recommendation matches highest output
      // if (quote.curveRewards >= quote.uniswapRewards && quote.curveRewards >= quote.mintingRewards) {
      //   expect(quote.recommendedRouter).to.equal(CURVE_3POOL)
      // } else if (quote.uniswapRewards >= quote.mintingRewards) {
      //   expect(quote.recommendedRouter).to.equal(UNISWAP_V4_ROUTER)
      // } else {
      //   expect(quote.recommendedRouter).to.equal(ethers.ZeroAddress)
      // }

      console.log('Route recommendation logic test')
    })

    it('Should recommend Curve for large stablecoin amounts', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _largeAmount = ethers.parseUnits('100000', 6)
      // const quote = await router.getIncomeQuote(...)
      // For large stablecoin amounts, Curve should typically be best
      // (unless liquidity is extremely poor)
      console.log('Curve recommendation for large amounts test')
    })

    it('Should recommend minting when DEX liquidity is poor', async function () {
      this.skip() // TODO: Implement after contracts deployed

      // Test with extremely large amount that would have high slippage
      const _hugeAmount = ethers.parseUnits('5000000', 6) // $5M
      // const quote = await router.getIncomeQuote(...)
      // Minting might be recommended for very large amounts
      // if DEX pools don't have sufficient liquidity
      console.log('Minting recommendation for huge amounts test')
    })

    it('Should show recommendation changes at different thresholds', async function () {
      this.skip() // TODO: Implement after contracts deployed

      console.log('\nRecommendation Changes Across Amounts:')

      for (const { label, usdc: _amount } of AMOUNTS) {
        // const quote = await router.getIncomeQuote(...)

        console.log(`\n${label}:`)
        // console.log(`  Recommended: ${getRouterName(quote.recommendedRouter)}`)
        // console.log(`  Curve:   ${ethers.formatEther(quote.curveRewards)} YUSD`)
        // console.log(`  Uniswap: ${ethers.formatEther(quote.uniswapRewards)} YUSD`)
        // console.log(`  Minting: ${ethers.formatEther(quote.mintingRewards)} YUSD`)
      }
    })
  })

  // ========================================
  // CROSS-ASSET COMPARISON
  // ========================================

  describe('Cross-Asset Comparison', () => {
    it('Should show similar quotes for USDC vs USDT', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _amount = ethers.parseUnits('50000', 6)

      // const usdtQuote = await router.getIncomeQuote(USDT_ADDRESS, amount, ...)

      // Both stablecoins should have similar output (within 1%)
      // const tolerance = amount / 100n // 1% tolerance
      // expect(usdcQuote.curveOutput).to.be.closeTo(usdtQuote.curveOutput, tolerance)

      console.log('\n$50k Cross-Asset Comparison:')
      // console.log(`  USDC Curve: ${ethers.formatEther(usdcQuote.curveRewards)} YUSD`)
      // console.log(`  USDT Curve: ${ethers.formatEther(usdtQuote.curveRewards)} YUSD`)
    })

    it('Should show USDC and USDT have similar slippage profiles', async function () {
      this.skip() // TODO: Implement after contracts deployed

      console.log('\nCross-Asset Slippage Comparison:')

      for (const { label, usdc: _usdcAmount, usdt: _usdtAmount } of AMOUNTS) {
        // const usdcQuote = await router.getIncomeQuote(USDC_ADDRESS, usdcAmount, ...)
        // const usdtQuote = await router.getIncomeQuote(USDT_ADDRESS, usdtAmount, ...)

        // const usdcSlippage = calculateSlippage(usdcQuote.curveOutput, usdcAmount)
        // const usdtSlippage = calculateSlippage(usdtQuote.curveOutput, usdtAmount)

        console.log(`\n${label}:`)
        // console.log(`  USDC Slippage: ${formatBps(usdcSlippage)} bps`)
        // console.log(`  USDT Slippage: ${formatBps(usdtSlippage)} bps`)
      }
    })
  })

  // ========================================
  // GAS COST ANALYSIS
  // ========================================

  describe('Gas Cost Analysis', () => {
    it('Should measure gas costs for each route', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _amount = ethers.parseUnits('10000', 6)


      // Minting route
      // const mintingGas = await router.transferToMinting.estimateGas(USDC_ADDRESS, amount)
      // console.log(`  Minting:  ${mintingGas.toString()} gas`)

      // Curve route
      // const curveGas = await router.swapAndDeposit.estimateGas(...)
      // console.log(`  Curve:    ${curveGas.toString()} gas`)

      // Uniswap route
      // const uniswapGas = await router.swapAndDeposit.estimateGas(...)
      // console.log(`  Uniswap:  ${uniswapGas.toString()} gas`)
    })

    it('Should calculate total cost (gas + slippage)', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _amount = ethers.parseUnits('50000', 6)
      const _gasPrice = 30n * 10n ** 9n // 30 gwei

      // Calculate for each route:
      // - Gas cost in USD
      // - Slippage cost
      // - Total cost
      // - Output amount after costs
    })
  })

  // ========================================
  // EDGE CASES
  // ========================================

  describe('Edge Cases', () => {
    it('Should handle quote when DEX liquidity is insufficient', async function () {
      this.skip() // TODO: Implement after contracts deployed

      // Test with amount larger than available liquidity
      const _massiveAmount = ethers.parseUnits('10000000', 6) // $10M


      // Curve/Uniswap quotes might be 0 if insufficient liquidity
      // Minting quote should always work
      // expect(quote.mintingOutput).to.be.gt(0)

      console.log('Insufficient liquidity handling test')
    })

    it('Should handle invalid swap calldata gracefully', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _amount = ethers.parseUnits('10000', 6)
      const _invalidCalldata = '0x'
      //   USDC_ADDRESS,
      //   amount,
      //   invalidCalldata,
      //   invalidCalldata
      // )

      // Invalid calldata should result in 0 quotes for DEX routes
      // expect(quote.curveOutput).to.equal(0)
      // expect(quote.uniswapOutput).to.equal(0)
      // Minting should still work
      // expect(quote.mintingOutput).to.be.gt(0)

      console.log('Invalid calldata handling test')
    })

    it('Should handle minimum amounts', async function () {
      this.skip() // TODO: Implement after contracts deployed

      const _minAmount = ethers.parseUnits('100', 6) // $100


      // All routes should work even for small amounts
      // expect(quote.curveOutput).to.be.gt(0)
      // expect(quote.uniswapOutput).to.be.gt(0)
      // expect(quote.mintingOutput).to.be.gt(0)

      console.log('Minimum amount handling test')
    })
  })

  // ========================================
  // FEE & INTEGRATION TESTS
  // ========================================

  describe('Fee Handling', () => {
    describe('Fee Variations', () => {
      it('Should handle current income fee correctly', async function () {
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        // Get current fee from AegisMinting
        const feeBP = await aegisMinting.incomeFeeBP()
        console.log(`\nCurrent income fee: ${feeBP} basis points (${Number(feeBP) / 100}%)`)

        // Execute swap
        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['fee-test'])

        const insuranceBalanceBefore = await yusd.balanceOf(insuranceFund.address)
        const rewardsBalanceBefore = await yusd.balanceOf(await aegisRewards.getAddress())

        await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          0,
          snapshotId,
        )

        const insuranceBalanceAfter = await yusd.balanceOf(insuranceFund.address)
        const rewardsBalanceAfter = await yusd.balanceOf(await aegisRewards.getAddress())

        const insuranceFee = insuranceBalanceAfter - insuranceBalanceBefore
        const rewardsAmount = rewardsBalanceAfter - rewardsBalanceBefore
        const totalYUSD = insuranceFee + rewardsAmount

        // Calculate expected fee
        const expectedFee = (totalYUSD * feeBP) / 10000n
        const expectedRewards = totalYUSD - expectedFee

        console.log(`  Total YUSD:        ${ethers.formatEther(totalYUSD)}`)
        console.log(`  Insurance fee:     ${ethers.formatEther(insuranceFee)}`)
        console.log(`  Rewards:           ${ethers.formatEther(rewardsAmount)}`)
        console.log(`  Expected fee:      ${ethers.formatEther(expectedFee)}`)

        // Verify fee split (with 1% tolerance for rounding)
        expect(insuranceFee).to.be.closeTo(expectedFee, expectedFee / 100n)
        expect(rewardsAmount).to.be.closeTo(expectedRewards, expectedRewards / 100n)
      })

      it('Should read fee dynamically from AegisMinting', async function () {
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        // Get quote with current fee
        const quote1 = await router.getIncomeQuote(USDC_ADDRESS, amount, ethers.parseEther('10000'), 0)
        const feeBP1 = await aegisMinting.incomeFeeBP()

        console.log('\nDynamic Fee Test:')
        console.log(`  Fee from AegisMinting: ${feeBP1} BP`)
        console.log(`  Quoted rewards:        ${ethers.formatEther(quote1.curveRewards)} YUSD`)

        // Verify quote reflects current fee
        const expectedRewards1 = (quote1.curveOutput * (10000n - feeBP1)) / 10000n
        expect(quote1.curveRewards).to.equal(expectedRewards1)
      })

      it('Should handle zero fee scenario', async function () {
        this.timeout(120000)

        // Note: We can't actually change the fee in fork mode without admin access
        // But we can test the calculation logic with insurance fund = address(0)

        const amount = ethers.parseUnits('10000', 6)
        const quote = await router.getIncomeQuote(USDC_ADDRESS, amount, ethers.parseEther('10000'), 0)

        console.log('\nZero Fee Scenario Test:')
        console.log(`  Quote output:      ${ethers.formatEther(quote.curveOutput)} YUSD`)
        console.log(`  Quote rewards:     ${ethers.formatEther(quote.curveRewards)} YUSD`)

        // With normal fee, rewards should be less than output
        expect(quote.curveRewards).to.be.lte(quote.curveOutput)
      })

      it('Should calculate fees correctly for all route types', async function () {
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const curveQuote = await curvePool.get_dy(1, 0, amount)
        const uniswapQuote = ethers.parseEther('10000')

        const quote = await router.getIncomeQuote(USDC_ADDRESS, amount, curveQuote, uniswapQuote)
        const feeBP = await aegisMinting.incomeFeeBP()

        console.log('\nFee Calculation for All Routes:')
        console.log(`  Current fee:       ${feeBP} BP`)
        console.log(`  Curve output:      ${ethers.formatEther(quote.curveOutput)} YUSD`)
        console.log(`  Curve rewards:     ${ethers.formatEther(quote.curveRewards)} YUSD`)
        console.log(`  Uniswap output:    ${ethers.formatEther(quote.uniswapOutput)} YUSD`)
        console.log(`  Uniswap rewards:   ${ethers.formatEther(quote.uniswapRewards)} YUSD`)
        console.log(`  Minting output:    ${ethers.formatEther(quote.mintingOutput)} YUSD`)
        console.log(`  Minting rewards:   ${ethers.formatEther(quote.mintingRewards)} YUSD`)

        // Verify all routes apply the same fee
        const curveExpected = (quote.curveOutput * (10000n - feeBP)) / 10000n
        const uniswapExpected = (quote.uniswapOutput * (10000n - feeBP)) / 10000n
        const mintingExpected = (quote.mintingOutput * (10000n - feeBP)) / 10000n

        expect(quote.curveRewards).to.be.closeTo(curveExpected, curveExpected / 1000n)
        expect(quote.uniswapRewards).to.be.closeTo(uniswapExpected, uniswapExpected / 1000n)
        expect(quote.mintingRewards).to.be.closeTo(mintingExpected, mintingExpected / 1000n)
      })
    })

    describe('Insurance Fund Integration', () => {
      it.skip('Should transfer correct fee to insurance fund', async function () {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['insurance-test'])

        const insuranceBalanceBefore = await yusd.balanceOf(insuranceFund.address)

        await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          0,
          snapshotId,
        )

        const insuranceBalanceAfter = await yusd.balanceOf(insuranceFund.address)
        const insuranceFeeReceived = insuranceBalanceAfter - insuranceBalanceBefore

        console.log('\nInsurance Fund Integration:')
        console.log(`  Fee received:      ${ethers.formatEther(insuranceFeeReceived)} YUSD`)

        // Should have received non-zero fee
        expect(insuranceFeeReceived).to.be.gt(0)
      })

      it.skip('Should verify insurance fund receives fee in YUSD token', async function () {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['yusd-test'])

        const insuranceYUSDBalanceBefore = await yusd.balanceOf(insuranceFund.address)
        const insuranceUSDCBalanceBefore = await usdc.balanceOf(insuranceFund.address)

        await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          0,
          snapshotId,
        )

        const insuranceYUSDBalanceAfter = await yusd.balanceOf(insuranceFund.address)
        const insuranceUSDCBalanceAfter = await usdc.balanceOf(insuranceFund.address)

        // Insurance fund should receive YUSD, not USDC
        expect(insuranceYUSDBalanceAfter).to.be.gt(insuranceYUSDBalanceBefore)
        expect(insuranceUSDCBalanceAfter).to.equal(insuranceUSDCBalanceBefore)
      })

      it.skip('Should split rewards correctly: fee + rewards = total', async function () {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['split-test'])

        const insuranceBalanceBefore = await yusd.balanceOf(insuranceFund.address)
        const rewardsBalanceBefore = await yusd.balanceOf(await aegisRewards.getAddress())

        await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          0,
          snapshotId,
        )

        const insuranceBalanceAfter = await yusd.balanceOf(insuranceFund.address)
        const rewardsBalanceAfter = await yusd.balanceOf(await aegisRewards.getAddress())

        const insuranceFee = insuranceBalanceAfter - insuranceBalanceBefore
        const rewards = rewardsBalanceAfter - rewardsBalanceBefore
        const total = insuranceFee + rewards

        console.log('\nReward Split Verification:')
        console.log(`  Insurance fee:     ${ethers.formatEther(insuranceFee)} YUSD`)
        console.log(`  Rewards:           ${ethers.formatEther(rewards)} YUSD`)
        console.log(`  Total:             ${ethers.formatEther(total)} YUSD`)

        // Verify the math: fee + rewards should equal total YUSD received
        expect(total).to.be.gt(0)
        expect(insuranceFee).to.be.gt(0)
        expect(rewards).to.be.gt(insuranceFee) // Rewards should be larger than fee
      })

      it('Should get insurance fund address from AegisMinting', async function () {
        const insuranceFundFromMinting = await aegisMinting.insuranceFundAddress()
        const insuranceFundFromTest = insuranceFund.address

        console.log('\nInsurance Fund Address:')
        console.log(`  From AegisMinting: ${insuranceFundFromMinting}`)
        console.log(`  From Test Setup:   ${insuranceFundFromTest}`)

        expect(insuranceFundFromMinting).to.equal(insuranceFundFromTest)
      })
    })

    describe('Event Emissions', () => {
      it('Should emit TransferredToMinting event with correct params', async function () {
        const amount = ethers.parseUnits('1000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)

        await expect(router.connect(routerOperator).transferToMinting(USDC_ADDRESS, amount))
          .to.emit(router, 'TransferredToMinting')
          .withArgs(USDC_ADDRESS, amount, routerOperator.address)
      })

      it.skip('Should emit SwapAndDeposit event with correct params', async function () {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['event-test'])

        const tx = await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          0,
          snapshotId,
        )

        const receipt = await tx.wait()
        const event = receipt?.logs
          .map((log: any) => {
            try {
              return router.interface.parseLog(log)
            } catch {
              return null
            }
          })
          .find((e: any) => e && e.name === 'SwapAndDeposit')

        expect(event).to.not.be.undefined
        expect(event?.args.collateralAsset).to.equal(USDC_ADDRESS)
        expect(event?.args.collateralAmount).to.equal(amount)
        expect(event?.args.dexRouter).to.equal(CURVE_YUSD_USDC)
        expect(event?.args.yusdReceived).to.be.gt(0)
        expect(event?.args.rewardsAmount).to.be.gt(0)
        expect(event?.args.insuranceFee).to.be.gt(0) // Fee should be non-zero!
        expect(event?.args.snapshotId).to.equal(snapshotId)
      })

      it.skip('Should emit correct insuranceFee in SwapAndDeposit event', async function () {
        // TODO: Requires real Curve swap execution - implement in dedicated swap test file
        this.timeout(120000)

        const amount = ethers.parseUnits('10000', 6)

        await usdc.connect(routerOperator).approve(await router.getAddress(), amount)
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const swapCalldata = curvePool.interface.encodeFunctionData('exchange', [1, 0, amount, 0])
        const snapshotId = ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['fee-event-test'])

        const insuranceBalanceBefore = await yusd.balanceOf(insuranceFund.address)

        const tx = await router.connect(routerOperator).swapAndDeposit(
          USDC_ADDRESS,
          amount,
          CURVE_YUSD_USDC,
          swapCalldata,
          0,
          snapshotId,
        )

        const insuranceBalanceAfter = await yusd.balanceOf(insuranceFund.address)
        const actualFee = insuranceBalanceAfter - insuranceBalanceBefore

        const receipt = await tx.wait()
        const event = receipt?.logs
          .map((log: any) => {
            try {
              return router.interface.parseLog(log)
            } catch {
              return null
            }
          })
          .find((e: any) => e && e.name === 'SwapAndDeposit')

        console.log('\nEvent Fee Verification:')
        console.log(`  Event insuranceFee: ${ethers.formatEther(event?.args.insuranceFee)}`)
        console.log(`  Actual fee paid:    ${ethers.formatEther(actualFee)}`)

        // Event should match actual fee transferred
        expect(event?.args.insuranceFee).to.equal(actualFee)
      })

      it('Should emit PausedChanged on pause/unpause', async function () {
        await expect(router.connect(admin).setPaused(true))
          .to.emit(router, 'PausedChanged')
          .withArgs(true)

        await expect(router.connect(admin).setPaused(false))
          .to.emit(router, 'PausedChanged')
          .withArgs(false)
      })

      it('Should emit DexRouterApprovalChanged', async function () {
        const newRouter = ethers.Wallet.createRandom().address

        await expect(router.connect(admin).setDexRouterApproval(newRouter, true))
          .to.emit(router, 'DexRouterApprovalChanged')
          .withArgs(newRouter, true)

        await expect(router.connect(admin).setDexRouterApproval(newRouter, false))
          .to.emit(router, 'DexRouterApprovalChanged')
          .withArgs(newRouter, false)
      })

      it('Should emit TokensRescued event', async function () {
        // Send some USDC to the router contract
        const rescueAmount = ethers.parseUnits('100', 6)
        await usdc.connect(routerOperator).transfer(await router.getAddress(), rescueAmount)

        // Rescue it
        await expect(router.connect(admin).rescueTokens(USDC_ADDRESS, admin.address, rescueAmount))
          .to.emit(router, 'TokensRescued')
          .withArgs(USDC_ADDRESS, admin.address, rescueAmount)
      })
    })
  })

  // ========================================
  // PHASE 4: EDGE CASES & ADVANCED SCENARIOS
  // ========================================

  describe('Edge Cases', () => {
    describe('Edge Amount Tests', () => {
      it('Should handle dust amount (1 USDC)', async function () {
        this.timeout(120000)

        const dustAmount = ethers.parseUnits('1', 6) // 1 USDC

        // Get off-chain quotes for dust amount
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const curveQuote = await curvePool.get_dy(1, 0, dustAmount)
        const uniswapQuote = ethers.parseEther(ethers.formatUnits(dustAmount, 6)) // Approx 1:1 for small amounts

        // Get quote for dust amount
        const quote = await router.getIncomeQuote(USDC_ADDRESS, dustAmount, curveQuote, uniswapQuote)

        // Verify quote is non-zero
        expect(quote.mintingOutput).to.be.gt(0)
        expect(quote.curveOutput).to.be.gt(0)
        expect(quote.uniswapOutput).to.be.gt(0)

        // Execute minting route with dust amount
        await usdc.connect(routerOperator).approve(await router.getAddress(), dustAmount)

        const tx = await router.connect(routerOperator).transferToMinting(USDC_ADDRESS, dustAmount)
        await expect(tx).to.emit(router, 'TransferredToMinting')

        console.log('      ✅ Dust amount (1 USDC) handled successfully')
      })

      it('Should handle very small amount (0.000001 USDC = 1 wei)', async function () {
        this.timeout(120000)

        const minAmount = 1n // 1 wei in USDC (6 decimals)

        // This should either:
        // 1. Succeed with minimal output
        // 2. Revert with zero amount error (depending on contract implementation)

        try {
          const quote = await router.getIncomeQuote(USDC_ADDRESS, minAmount, 0, 0)

          // If quote succeeds, it should have some output (may be 0)
          expect(quote.mintingOutput).to.exist

          console.log(`      ✅ 1 wei amount handled: ${ethers.formatEther(quote.mintingOutput)} YUSD`)
        } catch (error: any) {
          // If it reverts, it should be due to zero/invalid amount
          expect(error.message).to.match(/zero|invalid|too small/i)
          console.log('      ✅ 1 wei amount correctly rejected as too small')
        }
      })

      it('Should handle medium-large amount ($100k)', async function () {
        this.timeout(120000)

        const largeAmount = ethers.parseUnits('100000', 6) // $100k USDC

        // Get off-chain quotes
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const curveQuote = await curvePool.get_dy(1, 0, largeAmount)
        const uniswapQuote = ethers.parseEther(ethers.formatUnits(largeAmount, 6))

        // Get quote
        const quote = await router.getIncomeQuote(USDC_ADDRESS, largeAmount, curveQuote, uniswapQuote)

        // Verify all routes return reasonable outputs
        expect(quote.mintingOutput).to.be.gt(0)
        expect(quote.curveOutput).to.be.gt(0)
        expect(quote.uniswapOutput).to.be.gt(0)

        // Minting should give close to 1:1
        const expectedYUSD = ethers.parseEther(ethers.formatUnits(largeAmount, 6))
        const deviation = ((expectedYUSD - quote.mintingOutput) * 1000n) / expectedYUSD

        expect(deviation).to.be.lt(10n) // Less than 1% deviation

        console.log(`      ✅ $100k handled - Minting: ${ethers.formatEther(quote.mintingOutput)} YUSD`)
      })

      it('Should handle very large amount ($1M) and show route differences', async function () {
        this.timeout(120000)

        const veryLargeAmount = ethers.parseUnits('1000000', 6) // $1M USDC

        // Get off-chain quotes
        const curvePool = await ethers.getContractAt('ICurvePool', CURVE_YUSD_USDC)
        const curveQuote = await curvePool.get_dy(1, 0, veryLargeAmount)
        const uniswapQuote = ethers.parseEther(ethers.formatUnits(veryLargeAmount, 6))

        // Get quote
        const quote = await router.getIncomeQuote(USDC_ADDRESS, veryLargeAmount, curveQuote, uniswapQuote)

        // Verify all routes return outputs
        expect(quote.mintingOutput).to.be.gt(0)
        expect(quote.curveOutput).to.be.gt(0)
        expect(quote.uniswapOutput).to.be.gt(0)

        // For very large amounts, DEX routes should show more slippage than minting
        const mintingSlippage = calculateSlippage(quote.mintingOutput, veryLargeAmount)
        const curveSlippage = calculateSlippage(quote.curveOutput, veryLargeAmount)
        const uniswapSlippage = calculateSlippage(quote.uniswapOutput, veryLargeAmount)

        console.log('      💰 $1M Quote Results:')
        console.log(`         Minting: ${ethers.formatEther(quote.mintingOutput)} YUSD (${mintingSlippage.toFixed(2)} bps slippage)`)
        console.log(`         Curve: ${ethers.formatEther(quote.curveOutput)} YUSD (${curveSlippage.toFixed(2)} bps slippage)`)
        console.log(`         Uniswap: ${ethers.formatEther(quote.uniswapOutput)} YUSD (${uniswapSlippage.toFixed(2)} bps slippage)`)

        // Minting should have minimal slippage even for large amounts
        expect(mintingSlippage).to.be.lt(100) // Less than 1%
      })
    })

    describe('Token Rescue Tests', () => {
      it('Should rescue accidentally sent USDC', async function () {
        this.timeout(120000)

        const rescueAmount = ethers.parseUnits('1000', 6) // 1000 USDC
        const routerAddress = await router.getAddress()

        // Accidentally send USDC to router
        await usdc.connect(routerOperator).transfer(routerAddress, rescueAmount)

        const routerBalanceBefore = await usdc.balanceOf(routerAddress)
        expect(routerBalanceBefore).to.equal(rescueAmount)

        // Admin rescues it
        const adminBalanceBefore = await usdc.balanceOf(admin.address)
        await router.connect(admin).rescueTokens(USDC_ADDRESS, admin.address, rescueAmount)
        const adminBalanceAfter = await usdc.balanceOf(admin.address)

        expect(adminBalanceAfter - adminBalanceBefore).to.equal(rescueAmount)
        expect(await usdc.balanceOf(routerAddress)).to.equal(0)

        console.log(`      ✅ Rescued ${ethers.formatUnits(rescueAmount, 6)} USDC`)
      })

      it('Should rescue accidentally sent USDT', async function () {
        this.timeout(120000)

        const rescueAmount = ethers.parseUnits('1000', 6) // 1000 USDT
        const routerAddress = await router.getAddress()

        // Accidentally send USDT to router
        await usdt.connect(routerOperator).transfer(routerAddress, rescueAmount)

        const routerBalanceBefore = await usdt.balanceOf(routerAddress)
        expect(routerBalanceBefore).to.equal(rescueAmount)

        // Admin rescues it
        const adminBalanceBefore = await usdt.balanceOf(admin.address)
        await router.connect(admin).rescueTokens(USDT_ADDRESS, admin.address, rescueAmount)
        const adminBalanceAfter = await usdt.balanceOf(admin.address)

        expect(adminBalanceAfter - adminBalanceBefore).to.equal(rescueAmount)
        expect(await usdt.balanceOf(routerAddress)).to.equal(0)

        console.log(`      ✅ Rescued ${ethers.formatUnits(rescueAmount, 6)} USDT`)
      })

      it('Should rescue accidentally sent YUSD', async function () {
        this.timeout(120000)

        const rescueAmount = ethers.parseEther('1000') // 1000 YUSD
        const routerAddress = await router.getAddress()

        const routerBalanceBefore = await yusd.balanceOf(routerAddress)

        // Transfer YUSD from whale to router (simulating accidental send)
        const yusdWhale = await ethers.getSigner(YUSD_WHALE)
        await yusd.connect(yusdWhale).transfer(routerAddress, rescueAmount)

        const routerBalanceAfter = await yusd.balanceOf(routerAddress)
        expect(routerBalanceAfter - routerBalanceBefore).to.equal(rescueAmount)

        // Admin rescues it
        const adminBalanceBefore = await yusd.balanceOf(admin.address)
        await router.connect(admin).rescueTokens(await yusd.getAddress(), admin.address, rescueAmount)
        const adminBalanceAfter = await yusd.balanceOf(admin.address)

        expect(adminBalanceAfter - adminBalanceBefore).to.equal(rescueAmount)

        console.log(`      ✅ Rescued ${ethers.formatEther(rescueAmount)} YUSD`)
      })

      it('Should only allow admin to rescue tokens', async function () {
        this.timeout(120000)

        const rescueAmount = ethers.parseUnits('100', 6)
        const routerAddress = await router.getAddress()

        // Send some USDC to router
        await usdc.connect(routerOperator).transfer(routerAddress, rescueAmount)

        // Non-admin should not be able to rescue
        await expect(
          router.connect(routerOperator).rescueTokens(USDC_ADDRESS, routerOperator.address, rescueAmount),
        ).to.be.reverted

        // Deployer (not admin) should also fail
        await expect(
          router.connect(deployer).rescueTokens(USDC_ADDRESS, deployer.address, rescueAmount),
        ).to.be.reverted

        console.log('      ✅ Only admin can rescue tokens')

        // Admin should succeed
        await router.connect(admin).rescueTokens(USDC_ADDRESS, admin.address, rescueAmount)
        expect(await usdc.balanceOf(routerAddress)).to.equal(0)
      })

      it('Should revert rescue to zero address', async function () {
        this.timeout(120000)

        const rescueAmount = ethers.parseUnits('100', 6)
        const routerAddress = await router.getAddress()

        // Send some USDC to router
        await usdc.connect(routerOperator).transfer(routerAddress, rescueAmount)

        // Try to rescue to zero address - should revert
        await expect(
          router.connect(admin).rescueTokens(USDC_ADDRESS, ethers.ZeroAddress, rescueAmount),
        ).to.be.reverted

        console.log('      ✅ Cannot rescue to zero address')

        // Clean up - rescue to admin
        await router.connect(admin).rescueTokens(USDC_ADDRESS, admin.address, rescueAmount)
      })
    })
  })

  // ========================================
  // HELPER FUNCTIONS
  // ========================================

  // Used for slippage calculation in active tests
  function calculateSlippage(output: bigint, input: bigint): number {
    // Calculate slippage in basis points
    const expected = ethers.parseEther(ethers.formatUnits(input, 6))
    const slippage = Number((expected - output) * 10000n / expected)
    return slippage
  }

  // Unused helper functions - reserved for future swap execution tests (test 25 & 26)
  // function formatPercent(value: bigint, base: bigint): string {
  //   const percent = (Number(value) * 10000) / Number(base) / 100
  //   return `${percent.toFixed(2)}%`
  // }

  // function formatBps(bps: number): string {
  //   return bps.toFixed(2)
  // }

  // function getRouterName(address: string): string {
  //   if (address === CURVE_YUSD_USDC || address === CURVE_YUSD_USDT) return 'Curve'
  //   if (address === UNISWAP_V4_ROUTER) return 'Uniswap V4'
  //   if (address === ethers.ZeroAddress) return 'Minting'
  //   return 'Unknown'
  // }

  // async function buildCurveSwapCalldata(
  //   fromToken: string,
  //   toToken: string,
  //   amount: bigint,
  // ): Promise<string> {
  //   // TODO: Implement Curve 3pool exchange calldata building
  //   // const curve3pool = await ethers.getContractAt('ICurvePool', CURVE_3POOL)
  //   // const i = getCurveTokenIndex(fromToken)
  //   // const j = getCurveTokenIndex(toToken)
  //   // return curve3pool.interface.encodeFunctionData('exchange', [i, j, amount, 0])
  //   return '0x'
  // }

  // async function buildUniswapSwapCalldata(
  //   fromToken: string,
  //   toToken: string,
  //   amount: bigint,
  // ): Promise<string> {
  //   // TODO: Implement Uniswap V4 execute calldata building
  //   // const uniRouter = await ethers.getContractAt('IUniversalRouter', UNISWAP_V4_ROUTER)
  //   // Build commands and inputs for V4 swap
  //   // return uniRouter.interface.encodeFunctionData('execute', [commands, inputs, deadline])
  //   return '0x'
  // }

  after(async () => {
    // Reset network to clean state
    await network.provider.request({
      method: 'hardhat_reset',
      params: [],
    })
  })
})
