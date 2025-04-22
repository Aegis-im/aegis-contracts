/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')

describe('sYUSD', function () {
  let yusd
  let sYusd
  let owner
  let rewardsDistributor
  let user1
  let user2
  let accounts

  const ZERO_ADDRESS = ethers.ZeroAddress
  const INITIAL_SUPPLY = ethers.parseEther('1000000') // 1 million YUSD
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ADMIN_ROLE = ethers.keccak256(ethers.toUtf8Bytes('ADMIN_ROLE'))

  beforeEach(async function () {
    accounts = await ethers.getSigners();
    [owner, rewardsDistributor, user1, user2] = accounts

    // Deploy YUSD token
    const YUSD = await ethers.getContractFactory('YUSD')
    yusd = await YUSD.deploy(owner.address)
    // Wait for deployment to complete
    await yusd.waitForDeployment()

    // Set minter role
    await yusd.setMinter(owner.address)

    // Mint initial supply to owner
    await yusd.mint(owner.address, INITIAL_SUPPLY)

    // Deploy sYUSD token
    const sYUSD = await ethers.getContractFactory('sYUSD')
    sYusd = await sYUSD.deploy(
      await yusd.getAddress(),
      owner.address,
    )
    // Wait for deployment to complete
    await sYusd.waitForDeployment()

    // Distribute some YUSD to users for testing
    await yusd.transfer(user1.address, ethers.parseEther('10000'))
    await yusd.transfer(user2.address, ethers.parseEther('10000'))
    await yusd.transfer(rewardsDistributor.address, ethers.parseEther('100000'))

    // Approve sYUSD contract to spend YUSD
    await yusd.connect(user1).approve(await sYusd.getAddress(), ethers.MaxUint256)
    await yusd.connect(user2).approve(await sYusd.getAddress(), ethers.MaxUint256)
    await yusd.connect(rewardsDistributor).approve(await sYusd.getAddress(), ethers.MaxUint256)
    await yusd.connect(owner).approve(await sYusd.getAddress(), ethers.MaxUint256)
  })

  describe('Deployment', function () {
    it('Should set the correct name and symbol', async function () {
      expect(await sYusd.name()).to.equal('Staked YUSD')
      expect(await sYusd.symbol()).to.equal('sYUSD')
    })

    it('Should set the correct YUSD token address', async function () {
      expect(await sYusd.asset()).to.equal(await yusd.getAddress())
    })

    it('Should assign roles correctly', async function () {
      expect(await sYusd.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true
      expect(await sYusd.hasRole(ADMIN_ROLE, owner.address)).to.be.true
    })

    it('Should revert when YUSD address is zero', async function () {
      const sYUSD = await ethers.getContractFactory('sYUSD')
      await expect(
        sYUSD.deploy(ZERO_ADDRESS, owner.address),
      ).to.be.revertedWithCustomError(sYUSD, 'ZeroAddress')
    })

    it('Should revert when admin address is zero', async function () {
      const sYUSD = await ethers.getContractFactory('sYUSD')
      await expect(
        sYUSD.deploy(await yusd.getAddress(), ZERO_ADDRESS),
      ).to.be.revertedWithCustomError(sYUSD, 'ZeroAddress')
    })
  })

  describe('Deposit/Mint (Staking)', function () {
    it('Should allow users to deposit YUSD and receive sYUSD', async function () {
      const depositAmount = ethers.parseEther('1000')

      await expect(sYusd.connect(user1).deposit(depositAmount, user1.address))
        .to.emit(sYusd, 'Deposit')
        .withArgs(user1.address, user1.address, depositAmount, depositAmount) // sender, receiver, assets, shares

      expect(await sYusd.balanceOf(user1.address)).to.equal(depositAmount)
      expect(await yusd.balanceOf(await sYusd.getAddress())).to.equal(depositAmount)
    })

    it('Should maintain the correct exchange rate after multiple deposits', async function () {
      await sYusd.connect(user1).deposit(ethers.parseEther('1000'), user1.address)
      await sYusd.connect(user2).deposit(ethers.parseEther('500'), user2.address)

      expect(await sYusd.totalSupply()).to.equal(ethers.parseEther('1500'))
      expect(await sYusd.totalAssets()).to.equal(ethers.parseEther('1500'))

      // Exchange rate should be 1:1 initially
      expect(await sYusd.convertToAssets(ethers.parseEther('100'))).to.equal(ethers.parseEther('100'))
    })

    it('Should be able to use mint function too', async function () {
      const mintAmount = ethers.parseEther('1000')
      // Calculate assets needed for shares
      const assetsNeeded = await sYusd.previewMint(mintAmount)

      await expect(sYusd.connect(user1).mint(mintAmount, user1.address))
        .to.emit(sYusd, 'Deposit')
        .withArgs(user1.address, user1.address, assetsNeeded, mintAmount)

      expect(await sYusd.balanceOf(user1.address)).to.equal(mintAmount)
    })
  })

  describe('Withdraw/Redeem (Unstaking)', function () {
    beforeEach(async function () {
      // User1 deposits 1000 YUSD
      await sYusd.connect(user1).deposit(ethers.parseEther('1000'), user1.address)

      // Update unlocked shares to be able to withdraw
      await sYusd.updateUnlockedShares(user1.address)
    })

    it('Should respect lockup period for withdrawals', async function () {
      // Trying to withdraw immediately should fail due to lockup period
      await expect(sYusd.connect(user1).withdraw(ethers.parseEther('100'), user1.address, user1.address))
        .to.be.revertedWithCustomError(sYusd, 'ERC4626ExceededMaxWithdraw')
    })

    it('Should allow withdrawals after lockup period expires', async function () {
      // Advance time past the lockup period (default 7 days)
      await time.increase(7 * 24 * 60 * 60 + 1)

      // Update unlocked shares
      await sYusd.updateUnlockedShares(user1.address)

      // Now withdrawal should succeed
      const withdrawAmount = ethers.parseEther('500')

      await expect(sYusd.connect(user1).withdraw(withdrawAmount, user1.address, user1.address))
        .to.emit(sYusd, 'Withdraw')
        .withArgs(user1.address, user1.address, user1.address, withdrawAmount, withdrawAmount)

      expect(await sYusd.balanceOf(user1.address)).to.equal(ethers.parseEther('500'))
      expect(await yusd.balanceOf(await sYusd.getAddress())).to.equal(ethers.parseEther('500'))
    })

    it('Should also allow redeem after lockup period expires', async function () {
      // Advance time past the lockup period
      await time.increase(7 * 24 * 60 * 60 + 1)

      // Update unlocked shares
      await sYusd.updateUnlockedShares(user1.address)

      const redeemShares = ethers.parseEther('500')
      const expectedAssets = await sYusd.previewRedeem(redeemShares)

      await expect(sYusd.connect(user1).redeem(redeemShares, user1.address, user1.address))
        .to.emit(sYusd, 'Withdraw')
        .withArgs(user1.address, user1.address, user1.address, expectedAssets, redeemShares)
    })
  })

  describe('Lockup Period', function () {
    it('Should allow admin to change lockup period', async function () {
      const newLockupPeriod = 600 // 10 minutes

      await expect(sYusd.connect(owner).setLockupPeriod(newLockupPeriod))
        .to.emit(sYusd, 'LockupPeriodUpdated')
        .withArgs(newLockupPeriod)

      expect(await sYusd.lockupPeriod()).to.equal(newLockupPeriod)
    })

    it('Should prevent non-admin from changing lockup period', async function () {
      await expect(sYusd.connect(user1).setLockupPeriod(600))
        .to.be.revertedWithCustomError(sYusd, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('Share Tracking', function () {
    beforeEach(async function () {
      await sYusd.connect(user1).deposit(ethers.parseEther('1000'), user1.address)
    })

    it('Should correctly track locked shares', async function () {
      const userSharesStatus = await sYusd.getUserSharesStatus(user1.address)
      const lockedShares = userSharesStatus[0]
      const unlockedShares = userSharesStatus[1]

      expect(lockedShares).to.equal(ethers.parseEther('1000'))
      expect(unlockedShares).to.equal(0)
    })

    it('Should unlock shares after lockup period', async function () {
      // Advance time past lockup period
      await time.increase(7 * 24 * 60 * 60 + 1)

      // Before calling updateUnlockedShares
      let userSharesStatus = await sYusd.getUserSharesStatus(user1.address)
      let lockedShares = userSharesStatus[0]
      let unlockedShares = userSharesStatus[1]

      expect(lockedShares).to.equal(0) // Should be 0 as getUserSharesStatus already checks timestamps
      expect(unlockedShares).to.equal(ethers.parseEther('1000'))

      // After explicitly updating
      await sYusd.updateUnlockedShares(user1.address)

      // Check state
      userSharesStatus = await sYusd.getUserSharesStatus(user1.address)
      lockedShares = userSharesStatus[0]
      unlockedShares = userSharesStatus[1]

      expect(lockedShares).to.equal(0)
      expect(unlockedShares).to.equal(ethers.parseEther('1000'))
    })
  })

  describe('ERC4626 Compatibility', function () {
    it('Should implement maxDeposit correctly', async function () {
      const maxDeposit = await sYusd.maxDeposit(user1.address)
      expect(maxDeposit).to.equal(ethers.MaxUint256)
    })

    it('Should implement maxWithdraw correctly', async function () {
      // Initially no assets to withdraw
      const initialMaxWithdraw = await sYusd.maxWithdraw(user1.address)
      expect(initialMaxWithdraw).to.equal(0)

      // After deposit and lockup period passed
      await sYusd.connect(user1).deposit(ethers.parseEther('1000'), user1.address)
      await time.increase(7 * 24 * 60 * 60 + 1)

      const maxWithdraw = await sYusd.maxWithdraw(user1.address)
      expect(maxWithdraw).to.equal(ethers.parseEther('1000'))
    })
    
    it('Should implement maxRedeem correctly', async function () {
      // Initially no shares to redeem
      const initialMaxRedeem = await sYusd.maxRedeem(user1.address)
      expect(initialMaxRedeem).to.equal(0)
      
      // After deposit but before lockup period passes
      await sYusd.connect(user1).deposit(ethers.parseEther('1000'), user1.address)
      let maxRedeem = await sYusd.maxRedeem(user1.address)
      expect(maxRedeem).to.equal(0) // All shares are locked
      
      // After lockup period passes
      await time.increase(7 * 24 * 60 * 60 + 1)
      maxRedeem = await sYusd.maxRedeem(user1.address)
      expect(maxRedeem).to.equal(ethers.parseEther('1000')) // All shares are now unlocked
      
      // After partial withdrawal
      await sYusd.updateUnlockedSharesWithLimit(user1.address, 10)
      await sYusd.connect(user1).withdraw(ethers.parseEther('400'), user1.address, user1.address)
      maxRedeem = await sYusd.maxRedeem(user1.address)
      expect(maxRedeem).to.equal(ethers.parseEther('600')) // Remaining unlocked shares
    })
  })

  describe('Token Rescue', function () {
    it('Should allow admin to rescue other tokens', async function () {
      // Deploy a mock ERC20 for testing
      const ERC20Mock = await ethers.getContractFactory('YUSD')
      const mockToken = await ERC20Mock.deploy(owner.address)
      await mockToken.waitForDeployment()

      // Set minter role and mint tokens to the contract
      await mockToken.setMinter(owner.address)
      await mockToken.mint(await sYusd.getAddress(), ethers.parseEther('1000'))

      // Rescue tokens
      await expect(
        sYusd.connect(owner).rescueTokens(
          await mockToken.getAddress(),
          ethers.parseEther('1000'),
          owner.address,
        ),
      ).to.changeTokenBalance(
        mockToken,
        owner,
        ethers.parseEther('1000'),
      )
    })

    it('Should prevent rescuing the underlying asset', async function () {
      await expect(
        sYusd.connect(owner).rescueTokens(
          await yusd.getAddress(),
          ethers.parseEther('100'),
          owner.address,
        ),
      ).to.be.revertedWithCustomError(sYusd, 'InvalidToken')
    })
  })
  
  describe('DoS Protection', function () {
    it('Should process a limited number of locked shares with maxIterations', async function () {
      // Make multiple small deposits to create many locked share entries
      const smallDepositAmount = ethers.parseEther('1')
      const numDeposits = 10
      
      for (let i = 0; i < numDeposits; i++) {
        await sYusd.connect(user1).deposit(smallDepositAmount, user1.address)
      }
      
      // Advance time past lockup period
      await time.increase(7 * 24 * 60 * 60 + 1)
      
      // Process only a subset of the entries
      const maxIterations = 5
      await expect(sYusd.connect(user1).updateUnlockedSharesWithLimit(user1.address, maxIterations))
        .to.emit(sYusd, 'UnlockedSharesUpdated')
      
      // Check if only a subset was processed
      const userSharesInfo = await sYusd.getUserSharesStatus(user1.address)
      expect(userSharesInfo[0] + userSharesInfo[1]).to.equal(ethers.parseEther(numDeposits.toString()))
      
      // Process the rest
      await sYusd.connect(user1).updateUnlockedSharesWithLimit(user1.address, numDeposits)
      
      // Should now be fully processed
      const updatedSharesInfo = await sYusd.getUserSharesStatus(user1.address)
      expect(updatedSharesInfo[0]).to.equal(0) // No locked shares
      expect(updatedSharesInfo[1]).to.equal(ethers.parseEther(numDeposits.toString())) // All shares unlocked
    })
    
    it('Should still allow withdrawal after multiple processing steps', async function () {
      // Make multiple small deposits to create many locked share entries
      const smallDepositAmount = ethers.parseEther('10')
      const numDeposits = 5
      
      for (let i = 0; i < numDeposits; i++) {
        await sYusd.connect(user1).deposit(smallDepositAmount, user1.address)
      }
      
      // Advance time past lockup period
      await time.increase(7 * 24 * 60 * 60 + 1)
      
      // Process in steps
      await sYusd.connect(user1).updateUnlockedSharesWithLimit(user1.address, 2)
      await sYusd.connect(user1).updateUnlockedSharesWithLimit(user1.address, 2)
      await sYusd.connect(user1).updateUnlockedSharesWithLimit(user1.address, 2)
      
      // Try to withdraw everything
      const totalDeposit = smallDepositAmount * BigInt(numDeposits)
      await expect(sYusd.connect(user1).withdraw(totalDeposit, user1.address, user1.address))
        .to.emit(sYusd, 'Withdraw')
    })
  })
})

