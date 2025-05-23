import { expect } from 'chai'
import { ethers } from 'hardhat'
import { YUSD, sYUSD, sYUSDSilo } from '../typechain-types'
import { DEFAULT_ADMIN_ROLE } from './helpers'

describe('sYUSD', () => {
  let yusdContract: YUSD
  let sYusdContract: sYUSD
  let siloContract: sYUSDSilo
  let owner: any
  let user1: any
  let user2: any
  let admin: any
  const ADMIN_ROLE = DEFAULT_ADMIN_ROLE
  const initialAmount = ethers.parseEther('1000')
  const cooldown7days = 7 * 24 * 60 * 60 // 7 days in seconds

  beforeEach(async () => {
    [owner, user1, user2, admin] = await ethers.getSigners()

    // Deploy YUSD
    yusdContract = await ethers.deployContract('YUSD', [owner.address])
    await yusdContract.setMinter(owner)

    // Mint some YUSD to users for testing
    await yusdContract.mint(user1, initialAmount)
    await yusdContract.mint(user2, initialAmount)

    // Deploy sYUSD with admin as the admin
    sYusdContract = await ethers.deployContract('sYUSD', [
      await yusdContract.getAddress(),
      admin.address,
    ])

    // Get the silo address
    const siloAddress = await sYusdContract.silo()
    siloContract = await ethers.getContractAt('sYUSDSilo', siloAddress)
  })

  describe('Initialization', () => {
    it('should initialize with correct values', async () => {
      const yusdAddress = await yusdContract.getAddress()
      const assetAddress = await sYusdContract.asset()

      expect(assetAddress).to.equal(yusdAddress)
      expect(await sYusdContract.name()).to.equal('Staked YUSD')
      expect(await sYusdContract.symbol()).to.equal('sYUSD')
      expect(await sYusdContract.decimals()).to.equal(18)
      expect(await sYusdContract.cooldownDuration()).to.equal(cooldown7days)

      // Check roles
      expect(await sYusdContract.hasRole(ADMIN_ROLE, admin.address)).to.be.true
    })

    it('should initialize silo with correct values', async () => {
      const yusdAddress = await yusdContract.getAddress()
      const sYusdAddress = await sYusdContract.getAddress()

      expect(await siloContract.getStakingVault()).to.equal(sYusdAddress)
      expect(await siloContract.getYUSD()).to.equal(yusdAddress)
    })

    it('should revert if YUSD address is zero', async () => {
      await expect(
        ethers.deployContract('sYUSD', [ethers.ZeroAddress, admin.address]),
      ).to.be.revertedWithCustomError(
        sYusdContract,
        'ZeroAddress',
      )
    })

    it('should revert if admin address is zero', async () => {
      const yusdAddress = await yusdContract.getAddress()
      await expect(
        ethers.deployContract('sYUSD', [yusdAddress, ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(
        sYusdContract,
        'ZeroAddress',
      )
    })
  })

  describe('Deposit/Stake', () => {
    it('should allow users to deposit YUSD and receive sYUSD', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Check initial balances
      const initialYusdBalance = await yusdContract.balanceOf(user1)
      const initialSYusdBalance = await sYusdContract.balanceOf(user1)

      // Deposit YUSD
      await sYusdContract.connect(user1).deposit(depositAmount, user1)

      // Check final balances
      const finalYusdBalance = await yusdContract.balanceOf(user1)
      const finalSYusdBalance = await sYusdContract.balanceOf(user1)

      expect(finalYusdBalance).to.equal(initialYusdBalance - depositAmount)
      expect(finalSYusdBalance).to.equal(initialSYusdBalance + depositAmount)
    })

    it('should maintain a 1:1 ratio initially between YUSD and sYUSD', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Deposit YUSD
      await sYusdContract.connect(user1).deposit(depositAmount, user1)

      // Check share balance equals assets initially
      const shareBalance = await sYusdContract.balanceOf(user1)
      expect(shareBalance).to.equal(depositAmount)

      // Check convertToAssets & convertToShares functions
      expect(await sYusdContract.convertToAssets(shareBalance)).to.equal(depositAmount)
      expect(await sYusdContract.convertToShares(depositAmount)).to.equal(shareBalance)
    })

    it('should correctly handle deposits with different recipients', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Deposit YUSD for user2
      await sYusdContract.connect(user1).deposit(depositAmount, user2)

      // Check balances
      expect(await yusdContract.balanceOf(user1)).to.equal(initialAmount - depositAmount)
      expect(await sYusdContract.balanceOf(user1)).to.equal(0)
      expect(await sYusdContract.balanceOf(user2)).to.equal(depositAmount)
    })
  })

  describe('Withdraw with Cooldown', () => {
    const depositAmount = ethers.parseEther('100')

    beforeEach(async () => {
      // Deposit some YUSD first
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should not allow direct withdrawals when cooldown is enabled', async () => {
      await expect(
        sYusdContract.connect(user1).withdraw(depositAmount, user1, user1),
      ).to.be.revertedWithCustomError(
        sYusdContract,
        'ExpectedCooldownOff',
      )

      await expect(
        sYusdContract.connect(user1).redeem(depositAmount, user1, user1),
      ).to.be.revertedWithCustomError(
        sYusdContract,
        'ExpectedCooldownOff',
      )
    })

    it('should allow cooldown process with assets', async () => {
      const cooldownAmount = ethers.parseEther('50')

      // Start cooldown
      await sYusdContract.connect(user1).cooldownAssets(cooldownAmount, user1)

      // Check cooldown status
      const [cooldownEnd, underlyingAmount] = await sYusdContract.getUserCooldownStatus(user1)
      expect(underlyingAmount).to.equal(cooldownAmount)
      expect(cooldownEnd).to.be.gt(0)

      // Verify shares were burned and YUSD moved to silo
      expect(await sYusdContract.balanceOf(user1)).to.equal(depositAmount - cooldownAmount)
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(cooldownAmount)
    })

    it('should allow cooldown process with shares', async () => {
      const cooldownShares = ethers.parseEther('50')

      // Start cooldown
      await sYusdContract.connect(user1).cooldownShares(cooldownShares, user1)

      // Check cooldown status
      const [cooldownEnd, underlyingAmount] = await sYusdContract.getUserCooldownStatus(user1)
      expect(underlyingAmount).to.equal(cooldownShares) // 1:1 ratio initially
      expect(cooldownEnd).to.be.gt(0)

      // Verify shares were burned and YUSD moved to silo
      expect(await sYusdContract.balanceOf(user1)).to.equal(depositAmount - cooldownShares)
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(cooldownShares)
    })

    it('should not allow unstaking before cooldown period ends', async () => {
      // Start cooldown
      await sYusdContract.connect(user1).cooldownAssets(depositAmount, user1)

      // Try to unstake immediately
      await expect(
        sYusdContract.connect(user1).unstake(user1),
      ).to.be.revertedWithCustomError(
        sYusdContract,
        'CooldownNotEnded',
      )
    })

    it('should allow unstaking after cooldown period ends', async () => {
      const cooldownAmount = ethers.parseEther('50')

      // Start cooldown
      await sYusdContract.connect(user1).cooldownAssets(cooldownAmount, user1)

      // Fast forward time past cooldown period
      await ethers.provider.send('evm_increaseTime', [cooldown7days + 1])
      await ethers.provider.send('evm_mine', [])

      // Check balances before unstaking
      const beforeUnstakeYusdBalance = await yusdContract.balanceOf(user1)

      // Unstake
      await sYusdContract.connect(user1).unstake(user1)

      // Check balances after unstaking
      const afterUnstakeYusdBalance = await yusdContract.balanceOf(user1)

      // Verify YUSD was returned to user
      expect(afterUnstakeYusdBalance).to.equal(beforeUnstakeYusdBalance + cooldownAmount)

      // Verify cooldown was cleared
      const [cooldownEnd, underlyingAmount] = await sYusdContract.getUserCooldownStatus(user1)
      expect(cooldownEnd).to.equal(0)
      expect(underlyingAmount).to.equal(0)
    })
  })

  describe('Direct Withdrawals with Cooldown Disabled', () => {
    const depositAmount = ethers.parseEther('100')

    beforeEach(async () => {
      // Disable cooldown
      await sYusdContract.connect(admin).setCooldownDuration(0)

      // Deposit some YUSD first
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should allow direct withdrawals when cooldown is disabled', async () => {
      const withdrawAmount = ethers.parseEther('50')

      // Check initial balances
      const initialYusdBalance = await yusdContract.balanceOf(user1)
      const initialSYusdBalance = await sYusdContract.balanceOf(user1)

      // Withdraw YUSD
      await sYusdContract.connect(user1).withdraw(withdrawAmount, user1, user1)

      // Check final balances
      const finalYusdBalance = await yusdContract.balanceOf(user1)
      const finalSYusdBalance = await sYusdContract.balanceOf(user1)

      expect(finalYusdBalance).to.equal(initialYusdBalance + withdrawAmount)
      expect(finalSYusdBalance).to.equal(initialSYusdBalance - withdrawAmount)
    })

    it('should allow redeeming shares when cooldown is disabled', async () => {
      const redeemAmount = ethers.parseEther('50')

      // Check initial balances
      const initialYusdBalance = await yusdContract.balanceOf(user1)
      const initialSYusdBalance = await sYusdContract.balanceOf(user1)

      // Redeem shares
      await sYusdContract.connect(user1).redeem(redeemAmount, user1, user1)

      // Check final balances
      const finalYusdBalance = await yusdContract.balanceOf(user1)
      const finalSYusdBalance = await sYusdContract.balanceOf(user1)

      expect(finalYusdBalance).to.equal(initialYusdBalance + redeemAmount)
      expect(finalSYusdBalance).to.equal(initialSYusdBalance - redeemAmount)
    })
  })

  describe('Admin Functions', () => {
    it('should allow admin to change cooldown duration', async () => {
      const newDuration = 14 * 24 * 60 * 60 // 14 days

      // Set new cooldown duration
      await expect(sYusdContract.connect(admin).setCooldownDuration(newDuration))
        .to.emit(sYusdContract, 'CooldownDurationUpdated')
        .withArgs(cooldown7days, newDuration)

      expect(await sYusdContract.cooldownDuration()).to.equal(newDuration)
    })

    it('should revert if non-admin tries to change cooldown duration', async () => {
      await expect(
        sYusdContract.connect(user1).setCooldownDuration(0),
      ).to.be.reverted
    })

    it('should revert if cooldown duration exceeds maximum', async () => {
      const maxDuration = await sYusdContract.MAX_COOLDOWN_DURATION()
      const tooLongDuration = maxDuration + 1n

      await expect(
        sYusdContract.connect(admin).setCooldownDuration(tooLongDuration),
      ).to.be.reverted
    })

    it('should allow admin to rescue tokens', async () => {
      // Deploy a test token to be rescued
      const testToken = await ethers.deployContract('TestToken', ['Test', 'TST', 18])
      const rescueAmount = ethers.parseEther('10')

      // Send test tokens to sYUSD contract
      await testToken.mint(await sYusdContract.getAddress(), rescueAmount)

      // Rescue tokens
      await sYusdContract.connect(admin).rescueTokens(
        await testToken.getAddress(),
        rescueAmount,
        admin,
      )

      // Check tokens were rescued
      expect(await testToken.balanceOf(admin)).to.equal(rescueAmount)
    })

    it('should not allow rescuing the underlying YUSD token', async () => {
      await expect(
        sYusdContract.connect(admin).rescueTokens(
          await yusdContract.getAddress(),
          ethers.parseEther('1'),
          admin,
        ),
      ).to.be.revertedWithCustomError(
        sYusdContract,
        'InvalidToken',
      )
    })
  })

  describe('Max Functions and Limits', () => {
    beforeEach(async () => {
      // Deposit some YUSD first
      const depositAmount = ethers.parseEther('100')
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
    })
  })
})