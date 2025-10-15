import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { YUSD, sYUSD, sYUSDSilo } from '../typechain-types'

describe('sYUSDSilo', () => {
  let yusdContract: YUSD
  let sYusdContract: sYUSD
  let siloContract: sYUSDSilo
  let owner: any
  let user1: any
  let admin: any
  let randomUser: any
  const initialAmount = ethers.parseEther('1000')

  beforeEach(async () => {
    [owner, user1, admin, randomUser] = await ethers.getSigners()

    // Deploy YUSD
    yusdContract = await ethers.deployContract('YUSD', [owner.address])
    await yusdContract.setMinter(owner)

    // Mint some YUSD to use with sYUSD
    await yusdContract.mint(user1, initialAmount)

    // Deploy sYUSD with admin as the admin
    const sYusdFactory = await ethers.getContractFactory('sYUSD')
    sYusdContract = await upgrades.deployProxy(
      sYusdFactory,
      [await yusdContract.getAddress(), admin.address],
      {
        kind: 'transparent',
        initializer: 'initialize',
        unsafeAllow: ['constructor', 'delegatecall'],
      },
    ) as any

    // The silo is deployed by the sYUSD contract in its constructor
    const siloAddress = await sYusdContract.silo()
    siloContract = await ethers.getContractAt('sYUSDSilo', siloAddress)
  })

  describe('Initialization', () => {
    it('should initialize with correct values', async () => {
      const yusdAddress = await yusdContract.getAddress()
      const sYusdAddress = await sYusdContract.getAddress()

      expect(await siloContract.getStakingVault()).to.equal(sYusdAddress)
      expect(await siloContract.getYUSD()).to.equal(yusdAddress)
    })
  })

  describe('Withdraw Function', () => {
    it('should only allow the staking vault to withdraw', async () => {
      // Deposit some YUSD to the silo first
      const depositAmount = ethers.parseEther('100')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Deposit and start cooldown to move assets to silo
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
      await sYusdContract.connect(user1).cooldownAssets(depositAmount, user1)

      // Verify funds are in the silo
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(depositAmount)

      // Try to withdraw directly (should fail)
      await expect(
        siloContract.connect(randomUser).withdraw(user1.address, depositAmount),
      ).to.be.revertedWithCustomError(
        siloContract,
        'OnlyStakingVault',
      )

      // Fast forward time past cooldown period
      const cooldownDuration = await sYusdContract.cooldownDuration()
      await ethers.provider.send('evm_increaseTime', [Number(cooldownDuration) + 1])
      await ethers.provider.send('evm_mine', [])

      // Unstake properly through sYUSD contract
      await sYusdContract.connect(user1).unstake(user1.address)

      // Verify funds were withdrawn from silo
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(0)
      expect(await yusdContract.balanceOf(user1.address)).to.equal(initialAmount)
    })

    it('should transfer the correct amount when withdrawing', async () => {
      const depositAmount = ethers.parseEther('100')
      const cooldownAmount = ethers.parseEther('50')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Deposit YUSD
      await sYusdContract.connect(user1).deposit(depositAmount, user1)

      // Start cooldown for half the amount
      await sYusdContract.connect(user1).cooldownAssets(cooldownAmount, user1)

      // Verify funds are in the silo
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(cooldownAmount)

      // Fast forward time past cooldown period
      const cooldownDuration = await sYusdContract.cooldownDuration()
      await ethers.provider.send('evm_increaseTime', [Number(cooldownDuration) + 1])
      await ethers.provider.send('evm_mine', [])

      // Check user's balance before unstaking
      const beforeUnstakeBalance = await yusdContract.balanceOf(user1.address)

      // Unstake
      await sYusdContract.connect(user1).unstake(user1.address)

      // Verify correct amount was transferred from silo to user
      const afterUnstakeBalance = await yusdContract.balanceOf(user1.address)
      expect(afterUnstakeBalance).to.equal(beforeUnstakeBalance + cooldownAmount)
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(0)
    })

    it('should handle multiple users cooldown and unstaking correctly', async () => {
      // Setup second user
      await yusdContract.mint(randomUser, initialAmount)

      const user1Amount = ethers.parseEther('100')
      const user2Amount = ethers.parseEther('200')

      // Approve and deposit for user1
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        user1Amount,
      )
      await sYusdContract.connect(user1).deposit(user1Amount, user1)
      await sYusdContract.connect(user1).cooldownAssets(user1Amount, user1)

      // Approve and deposit for user2
      await yusdContract.connect(randomUser).approve(
        await sYusdContract.getAddress(),
        user2Amount,
      )
      await sYusdContract.connect(randomUser).deposit(user2Amount, randomUser)
      await sYusdContract.connect(randomUser).cooldownAssets(user2Amount, randomUser)

      // Verify total in silo
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(user1Amount + user2Amount)

      // Fast forward time past cooldown period
      const cooldownDuration = await sYusdContract.cooldownDuration()
      await ethers.provider.send('evm_increaseTime', [Number(cooldownDuration) + 1])
      await ethers.provider.send('evm_mine', [])

      // Unstake for user1
      await sYusdContract.connect(user1).unstake(user1.address)

      // Verify user1's funds withdrawn but user2's still there
      expect(await yusdContract.balanceOf(user1.address)).to.equal(initialAmount)
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(user2Amount)

      // Unstake for user2
      await sYusdContract.connect(randomUser).unstake(randomUser.address)

      // Verify all funds withdrawn
      expect(await yusdContract.balanceOf(randomUser.address)).to.equal(initialAmount)
      expect(await yusdContract.balanceOf(await siloContract.getAddress())).to.equal(0)
    })
  })

  describe('Security', () => {
    it('should not allow users to withdraw directly from silo', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Deposit and cooldown
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
      await sYusdContract.connect(user1).cooldownAssets(depositAmount, user1)

      // Try to withdraw directly from silo
      await expect(
        siloContract.connect(user1).withdraw(user1.address, depositAmount),
      ).to.be.revertedWithCustomError(
        siloContract,
        'OnlyStakingVault',
      )
    })

    it('should not allow even admin to withdraw directly from silo', async () => {
      const depositAmount = ethers.parseEther('100')

      // Approve sYUSD to spend user's YUSD
      await yusdContract.connect(user1).approve(
        await sYusdContract.getAddress(),
        depositAmount,
      )

      // Deposit and cooldown
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
      await sYusdContract.connect(user1).cooldownAssets(depositAmount, user1)

      // Try to withdraw directly from silo as admin
      await expect(
        siloContract.connect(admin).withdraw(admin.address, depositAmount),
      ).to.be.revertedWithCustomError(
        siloContract,
        'OnlyStakingVault',
      )
    })
  })
})