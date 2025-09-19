import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { YUSD, SYUSD as sYUSD } from '../typechain-types'

describe('sYUSD Instant Unstaking', () => {
  let yusdContract: YUSD
  let sYusdContract: sYUSD
  let owner: any
  let user1: any
  let user2: any
  let admin: any
  let insuranceFund: any
  const initialAmount = ethers.parseEther('1000')
  const cooldown7days = 7 * 24 * 60 * 60 // 7 days in seconds
  const instantUnstakingFee = 50 // 0.5% in basis points

  beforeEach(async () => {
    [owner, user1, user2, admin, insuranceFund] = await ethers.getSigners()

    // Deploy YUSD
    yusdContract = await ethers.deployContract('YUSD', [owner.address])
    await yusdContract.setMinter(owner)

    // Mint some YUSD to users for testing
    await yusdContract.mint(user1, initialAmount)
    await yusdContract.mint(user2, initialAmount)

    // Deploy sYUSD using upgrades proxy
    const sYUSD = await ethers.getContractFactory('sYUSD')
    sYusdContract = await upgrades.deployProxy(
      sYUSD,
      [await yusdContract.getAddress(), admin.address],
      {
        kind: 'transparent',
        initializer: 'initialize',
        unsafeAllow: ['constructor', 'delegatecall'],
      },
    ) as any

    // Initialize V2 functionality
    await sYusdContract.connect(admin).initializeV2(instantUnstakingFee, insuranceFund.address)
  })

  describe('Initialization V2', () => {
    it('should initialize V2 with correct values', async () => {
      expect(await sYusdContract.INSTANT_UNSTAKING_FEE()).to.equal(instantUnstakingFee)
      expect(await sYusdContract.INSURANCE_FUND()).to.equal(insuranceFund.address)
    })

    it('should emit events on initialization', async () => {
      // Deploy a new contract to test initialization events
      const sYUSDFactory = await ethers.getContractFactory('sYUSD')
      const newSYusd = await upgrades.deployProxy(
        sYUSDFactory,
        [await yusdContract.getAddress(), admin.address],
        {
          kind: 'transparent',
          initializer: 'initialize',
          unsafeAllow: ['constructor', 'delegatecall'],
        },
      ) as any

      await expect(newSYusd.connect(admin).initializeV2(instantUnstakingFee, insuranceFund.address))
        .to.emit(newSYusd, 'InstantUnstakingFeeUpdated')
        .withArgs(0, instantUnstakingFee)
        .and.to.emit(newSYusd, 'InsuranceFundUpdated')
        .withArgs(ethers.ZeroAddress, insuranceFund.address)
    })

    it('should revert if trying to initialize twice', async () => {
      await expect(
        sYusdContract.connect(admin).initializeV2(instantUnstakingFee, insuranceFund.address),
      ).to.be.revertedWith('Already initialized')
    })

    it('should revert if fee exceeds maximum', async () => {
      const sYUSDFactory = await ethers.getContractFactory('sYUSD')
      const newSYusd = await upgrades.deployProxy(
        sYUSDFactory,
        [await yusdContract.getAddress(), admin.address],
        {
          kind: 'transparent',
          initializer: 'initialize',
          unsafeAllow: ['constructor', 'delegatecall'],
        },
      ) as any

      await expect(
        newSYusd.connect(admin).initializeV2(10001, insuranceFund.address), // > 100%
      ).to.be.revertedWithCustomError(newSYusd, 'InvalidFee')
    })

    it('should revert if insurance fund is zero address', async () => {
      const sYUSDFactory = await ethers.getContractFactory('sYUSD')
      const newSYusd = await upgrades.deployProxy(
        sYUSDFactory,
        [await yusdContract.getAddress(), admin.address],
        {
          kind: 'transparent',
          initializer: 'initialize',
          unsafeAllow: ['constructor', 'delegatecall'],
        },
      ) as any

      await expect(
        newSYusd.connect(admin).initializeV2(instantUnstakingFee, ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(newSYusd, 'ZeroAddress')
    })

    it('should revert if non-admin tries to initialize', async () => {
      const sYUSDFactory = await ethers.getContractFactory('sYUSD')
      const newSYusd = await upgrades.deployProxy(
        sYUSDFactory,
        [await yusdContract.getAddress(), admin.address],
        {
          kind: 'transparent',
          initializer: 'initialize',
          unsafeAllow: ['constructor', 'delegatecall'],
        },
      ) as any

      await expect(
        newSYusd.connect(user1).initializeV2(instantUnstakingFee, insuranceFund.address),
      ).to.be.reverted
    })
  })

  describe('Admin Setters', () => {
    describe('setInstantUnstakingFee', () => {
      it('should allow admin to update instant unstaking fee', async () => {
        const newFee = 100 // 1%

        await expect(sYusdContract.connect(admin).setInstantUnstakingFee(newFee))
          .to.emit(sYusdContract, 'InstantUnstakingFeeUpdated')
          .withArgs(instantUnstakingFee, newFee)

        expect(await sYusdContract.INSTANT_UNSTAKING_FEE()).to.equal(newFee)
      })

      it('should revert if fee exceeds maximum', async () => {
        await expect(
          sYusdContract.connect(admin).setInstantUnstakingFee(10001), // > 100%
        ).to.be.revertedWithCustomError(sYusdContract, 'InvalidFee')
      })

      it('should revert if trying to set same fee', async () => {
        await expect(
          sYusdContract.connect(admin).setInstantUnstakingFee(instantUnstakingFee),
        ).to.be.revertedWithCustomError(sYusdContract, 'FeeNotChanged')
      })

      it('should revert if non-admin tries to set fee', async () => {
        await expect(
          sYusdContract.connect(user1).setInstantUnstakingFee(100),
        ).to.be.reverted
      })
    })

    describe('setInsuranceFund', () => {
      it('should allow admin to update insurance fund address', async () => {
        const newFund = user2.address

        await expect(sYusdContract.connect(admin).setInsuranceFund(newFund))
          .to.emit(sYusdContract, 'InsuranceFundUpdated')
          .withArgs(insuranceFund.address, newFund)

        expect(await sYusdContract.INSURANCE_FUND()).to.equal(newFund)
      })

      it('should revert if insurance fund is zero address', async () => {
        await expect(
          sYusdContract.connect(admin).setInsuranceFund(ethers.ZeroAddress),
        ).to.be.revertedWithCustomError(sYusdContract, 'ZeroAddress')
      })

      it('should revert if trying to set same address', async () => {
        await expect(
          sYusdContract.connect(admin).setInsuranceFund(insuranceFund.address),
        ).to.be.revertedWithCustomError(sYusdContract, 'InsuranceFundNotChanged')
      })

      it('should revert if non-admin tries to set insurance fund', async () => {
        await expect(
          sYusdContract.connect(user1).setInsuranceFund(user2.address),
        ).to.be.reverted
      })
    })
  })

  describe('Instant Unstaking with Withdraw', () => {
    const depositAmount = ethers.parseEther('1000') // 1000 YUSD
    const withdrawAmount = ethers.parseEther('200') // 200 YUSD
    const expectedFee = ethers.parseEther('1') // 200 * 0.5% = 1 YUSD
    const expectedNetAmount = ethers.parseEther('199') // 200 - 1 = 199 YUSD

    beforeEach(async () => {
      // Deposit YUSD to get sYUSD
      await yusdContract.connect(user1).approve(await sYusdContract.getAddress(), depositAmount)
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should allow instant unstaking via withdraw when cooldown is enabled', async () => {
      // Check initial balances
      const initialUserYusd = await yusdContract.balanceOf(user1)
      const initialUserSYusd = await sYusdContract.balanceOf(user1)
      const initialInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // Perform instant unstaking
      await expect(sYusdContract.connect(user1).withdraw(withdrawAmount, user1, user1))
        .to.emit(sYusdContract, 'InstantUnstaking')
        .withArgs(user1.address, user1.address, expectedNetAmount, expectedFee)

      // Check final balances
      const finalUserYusd = await yusdContract.balanceOf(user1)
      const finalUserSYusd = await sYusdContract.balanceOf(user1)
      const finalInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // User should receive net amount (minus fee)
      expect(finalUserYusd).to.equal(initialUserYusd + expectedNetAmount)
      // User should have burned shares equal to withdraw amount
      expect(finalUserSYusd).to.equal(initialUserSYusd - withdrawAmount)
      // Insurance fund should receive the fee
      expect(finalInsuranceFundYusd).to.equal(initialInsuranceFundYusd + expectedFee)
    })

    it('should work with different receivers', async () => {
      const initialUser2Yusd = await yusdContract.balanceOf(user2)
      const initialInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // Withdraw to user2
      await sYusdContract.connect(user1).withdraw(withdrawAmount, user2, user1)

      const finalUser2Yusd = await yusdContract.balanceOf(user2)
      const finalInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // User2 should receive net amount
      expect(finalUser2Yusd).to.equal(initialUser2Yusd + expectedNetAmount)
      // Insurance fund should receive the fee
      expect(finalInsuranceFundYusd).to.equal(initialInsuranceFundYusd + expectedFee)
    })

    it('should still work normally when cooldown is disabled', async () => {
      // Disable cooldown
      await sYusdContract.connect(admin).setCooldownDuration(0)

      const initialUserYusd = await yusdContract.balanceOf(user1)
      const initialInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // Perform normal withdrawal (no fee)
      await sYusdContract.connect(user1).withdraw(withdrawAmount, user1, user1)

      const finalUserYusd = await yusdContract.balanceOf(user1)
      const finalInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // User should receive full amount (no fee)
      expect(finalUserYusd).to.equal(initialUserYusd + withdrawAmount)
      // Insurance fund should receive nothing
      expect(finalInsuranceFundYusd).to.equal(initialInsuranceFundYusd)
    })

    it('should revert if insurance fund not set', async () => {
      // Deploy new contract without initializing insurance fund
      const sYUSDFactory = await ethers.getContractFactory('sYUSD')
      const newSYusd = await upgrades.deployProxy(
        sYUSDFactory,
        [await yusdContract.getAddress(), admin.address],
        {
          kind: 'transparent',
          initializer: 'initialize',
          unsafeAllow: ['constructor', 'delegatecall'],
        },
      ) as any

      // Initialize only the fee, not the insurance fund
      await newSYusd.connect(admin).setInstantUnstakingFee(instantUnstakingFee)

      // Mint fresh YUSD for this test
      await yusdContract.mint(user1, depositAmount)

      // Deposit some funds
      await yusdContract.connect(user1).approve(await newSYusd.getAddress(), depositAmount)
      await newSYusd.connect(user1).deposit(depositAmount, user1)

      // Try to withdraw - should revert
      await expect(
        newSYusd.connect(user1).withdraw(withdrawAmount, user1, user1),
      ).to.be.revertedWithCustomError(newSYusd, 'InsuranceFundNotSet')
    })
  })

  describe('Instant Unstaking with Redeem', () => {
    const depositAmount = ethers.parseEther('1000') // 1000 YUSD
    const redeemShares = ethers.parseEther('200') // 200 shares
    const expectedFee = ethers.parseEther('1') // 200 * 0.5% = 1 YUSD
    const expectedNetAmount = ethers.parseEther('199') // 200 - 1 = 199 YUSD

    beforeEach(async () => {
      // Deposit YUSD to get sYUSD
      await yusdContract.connect(user1).approve(await sYusdContract.getAddress(), depositAmount)
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should allow instant unstaking via redeem when cooldown is enabled', async () => {
      // Check initial balances
      const initialUserYusd = await yusdContract.balanceOf(user1)
      const initialUserSYusd = await sYusdContract.balanceOf(user1)
      const initialInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // Perform instant unstaking
      const tx = await sYusdContract.connect(user1).redeem(redeemShares, user1, user1)

      await expect(tx)
        .to.emit(sYusdContract, 'InstantUnstaking')
        .withArgs(user1.address, user1.address, expectedNetAmount, expectedFee)

      // Check final balances
      const finalUserYusd = await yusdContract.balanceOf(user1)
      const finalUserSYusd = await sYusdContract.balanceOf(user1)
      const finalInsuranceFundYusd = await yusdContract.balanceOf(insuranceFund.address)

      // User should receive net amount (minus fee)
      expect(finalUserYusd).to.equal(initialUserYusd + expectedNetAmount)
      // User should have burned the exact shares
      expect(finalUserSYusd).to.equal(initialUserSYusd - redeemShares)
      // Insurance fund should receive the fee
      expect(finalInsuranceFundYusd).to.equal(initialInsuranceFundYusd + expectedFee)
    })

    it('should return correct net assets amount from redeem function', async () => {
      // The redeem function should return the net assets (after fee)
      const result = await sYusdContract.connect(user1).redeem.staticCall(redeemShares, user1, user1)
      expect(result).to.equal(expectedNetAmount)
    })
  })

  describe('Fee Calculation Edge Cases', () => {
    beforeEach(async () => {
      // Deposit large amount for testing
      const largeAmount = ethers.parseEther('10000')
      await yusdContract.mint(user1, largeAmount)
      await yusdContract.connect(user1).approve(await sYusdContract.getAddress(), largeAmount)
      await sYusdContract.connect(user1).deposit(largeAmount, user1)
    })

    it('should handle small amounts correctly', async () => {
      const smallAmount = ethers.parseUnits('1', 15) // 0.001 YUSD
      const expectedFee = smallAmount * BigInt(instantUnstakingFee) / BigInt(10000)

      const initialInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      await sYusdContract.connect(user1).withdraw(smallAmount, user1, user1)

      const finalInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)
      expect(finalInsuranceFund - initialInsuranceFund).to.equal(expectedFee)
    })

    it('should handle zero fee when amount is very small', async () => {
      // Set fee to 1 basis point (0.01%)
      await sYusdContract.connect(admin).setInstantUnstakingFee(1)

      const tinyAmount = BigInt(50) // 50 wei
      const expectedFee = BigInt(0) // Should round down to 0

      const initialInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      await sYusdContract.connect(user1).withdraw(tinyAmount, user1, user1)

      const finalInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)
      expect(finalInsuranceFund - initialInsuranceFund).to.equal(expectedFee)
    })

    it('should handle maximum fee (100%)', async () => {
      // Set fee to 100%
      await sYusdContract.connect(admin).setInstantUnstakingFee(10000)

      const amount = ethers.parseEther('100')
      const expectedFee = amount // 100% fee
      const expectedNet = BigInt(0) // Nothing left for user

      const initialUserYusd = await yusdContract.balanceOf(user1)
      const initialInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      await sYusdContract.connect(user1).withdraw(amount, user1, user1)

      const finalUserYusd = await yusdContract.balanceOf(user1)
      const finalInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      expect(finalUserYusd - initialUserYusd).to.equal(expectedNet)
      expect(finalInsuranceFund - initialInsuranceFund).to.equal(expectedFee)
    })

    it('should handle large amounts without overflow', async () => {
      // This tests that our arithmetic doesn't overflow with large numbers
      const largeAmount = ethers.parseEther('1000000') // 1M YUSD

      // First mint and deposit this large amount
      await yusdContract.mint(user1, largeAmount)
      await yusdContract.connect(user1).approve(await sYusdContract.getAddress(), largeAmount)
      await sYusdContract.connect(user1).deposit(largeAmount, user1)

      const expectedFee = largeAmount * BigInt(instantUnstakingFee) / BigInt(10000)
      const expectedNet = largeAmount - expectedFee

      const initialUserYusd = await yusdContract.balanceOf(user1)
      const initialInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      await sYusdContract.connect(user1).withdraw(largeAmount, user1, user1)

      const finalUserYusd = await yusdContract.balanceOf(user1)
      const finalInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      expect(finalUserYusd - initialUserYusd).to.equal(expectedNet)
      expect(finalInsuranceFund - initialInsuranceFund).to.equal(expectedFee)
    })
  })

  describe('Integration with Traditional Cooldown Process', () => {
    const depositAmount = ethers.parseEther('1000')

    beforeEach(async () => {
      // Deposit YUSD to get sYUSD
      await yusdContract.connect(user1).approve(await sYusdContract.getAddress(), depositAmount)
      await sYusdContract.connect(user1).deposit(depositAmount, user1)
    })

    it('should allow users to choose between instant unstaking and cooldown process', async () => {
      const instantAmount = ethers.parseEther('300')
      const cooldownAmount = ethers.parseEther('200')

      // 1. Instant unstaking (with fee)
      const initialInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)
      await sYusdContract.connect(user1).withdraw(instantAmount, user1, user1)
      const afterInstantInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)

      // Fee should have been charged
      const instantFee = instantAmount * BigInt(instantUnstakingFee) / BigInt(10000)
      expect(afterInstantInsuranceFund - initialInsuranceFund).to.equal(instantFee)

      // 2. Traditional cooldown process (no fee)
      await sYusdContract.connect(user1).cooldownAssets(cooldownAmount, user1)

      // Fast forward time
      await ethers.provider.send('evm_increaseTime', [cooldown7days + 1])
      await ethers.provider.send('evm_mine', [])

      const beforeCooldownUnstake = await yusdContract.balanceOf(user1)
      await sYusdContract.connect(user1).unstake(user1)
      const afterCooldownUnstake = await yusdContract.balanceOf(user1)

      // Should receive full amount (no fee)
      expect(afterCooldownUnstake - beforeCooldownUnstake).to.equal(cooldownAmount)

      // Insurance fund should not have changed
      const finalInsuranceFund = await yusdContract.balanceOf(insuranceFund.address)
      expect(finalInsuranceFund).to.equal(afterInstantInsuranceFund)
    })
  })
})
