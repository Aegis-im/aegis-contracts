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

  const ZERO_ADDRESS = ethers.constants.AddressZero
  const INITIAL_SUPPLY = ethers.utils.parseEther('1000000') // 1 million YUSD
  const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
  const ADMIN_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('ADMIN_ROLE'))
  const REWARDS_DISTRIBUTOR_ROLE = ethers.utils.keccak256(ethers.utils.toUtf8Bytes('REWARDS_DISTRIBUTOR_ROLE'))

  beforeEach(async function () {
    accounts = await ethers.getSigners();
    [owner, rewardsDistributor, user1, user2] = accounts

    // Deploy YUSD token
    const YUSD = await ethers.getContractFactory('YUSD')
    yusd = await YUSD.deploy(owner.address)
    await yusd.deployed()

    // Set minter role
    await yusd.setMinter(owner.address)

    // Mint initial supply to owner
    await yusd.mint(owner.address, INITIAL_SUPPLY)

    // Deploy sYUSD token
    const sYUSD = await ethers.getContractFactory('sYUSD')
    sYusd = await sYUSD.deploy(
      yusd.address,
      owner.address,
      rewardsDistributor.address,
    )
    await sYusd.deployed()

    // Distribute some YUSD to users for testing
    await yusd.transfer(user1.address, ethers.utils.parseEther('10000'))
    await yusd.transfer(user2.address, ethers.utils.parseEther('10000'))
    await yusd.transfer(rewardsDistributor.address, ethers.utils.parseEther('100000'))

    // Approve sYUSD contract to spend YUSD
    await yusd.connect(user1).approve(sYusd.address, ethers.constants.MaxUint256)
    await yusd.connect(user2).approve(sYusd.address, ethers.constants.MaxUint256)
    await yusd.connect(rewardsDistributor).approve(sYusd.address, ethers.constants.MaxUint256)
    await yusd.connect(owner).approve(sYusd.address, ethers.constants.MaxUint256)
  })

  describe('Deployment', function () {
    it('Should set the correct name and symbol', async function () {
      expect(await sYusd.name()).to.equal('Staked YUSD')
      expect(await sYusd.symbol()).to.equal('sYUSD')
    })

    it('Should set the correct YUSD token address', async function () {
      expect(await sYusd.yusd()).to.equal(yusd.address)
    })

    it('Should assign roles correctly', async function () {
      expect(await sYusd.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true
      expect(await sYusd.hasRole(ADMIN_ROLE, owner.address)).to.be.true
      expect(await sYusd.hasRole(REWARDS_DISTRIBUTOR_ROLE, rewardsDistributor.address)).to.be.true
    })

    it('Should revert when YUSD address is zero', async function () {
      const sYUSD = await ethers.getContractFactory('sYUSD')
      await expect(
        sYUSD.deploy(ZERO_ADDRESS, owner.address, rewardsDistributor.address),
      ).to.be.revertedWithCustomError(sYUSD, 'ZeroAddress')
    })

    it('Should revert when admin address is zero', async function () {
      const sYUSD = await ethers.getContractFactory('sYUSD')
      await expect(
        sYUSD.deploy(yusd.address, ZERO_ADDRESS, rewardsDistributor.address),
      ).to.be.revertedWithCustomError(sYUSD, 'ZeroAddress')
    })
  })

  describe('Staking', function () {
    it('Should allow users to stake YUSD and receive sYUSD', async function () {
      const stakeAmount = ethers.utils.parseEther('1000')

      await expect(sYusd.connect(user1).stake(stakeAmount))
        .to.emit(sYusd, 'Staked')
        .withArgs(user1.address, stakeAmount, stakeAmount) // 1:1 ratio initially

      expect(await sYusd.balanceOf(user1.address)).to.equal(stakeAmount)
      expect(await sYusd.totalYUSDHeld()).to.equal(stakeAmount)
      expect(await yusd.balanceOf(sYusd.address)).to.equal(stakeAmount)
    })

    it('Should maintain the correct exchange rate after multiple stakes', async function () {
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      await sYusd.connect(user2).stake(ethers.utils.parseEther('500'))

      expect(await sYusd.totalSupply()).to.equal(ethers.utils.parseEther('1500'))
      expect(await sYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('1500'))
      expect(await sYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1'))
    })

    it('Should revert when staking is disabled', async function () {
      await sYusd.connect(owner).setStakingEnabled(false)

      await expect(sYusd.connect(user1).stake(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(sYusd, 'StakingDisabled')
    })

    it('Should revert when staking below minimum amount', async function () {
      const minStakeAmount = await sYusd.minStakeAmount()

      await expect(sYusd.connect(user1).stake(minStakeAmount.sub(1)))
        .to.be.revertedWithCustomError(sYusd, 'BelowMinStakeAmount')
    })

    it('Should revert when staking above maximum amount if set', async function () {
      await sYusd.connect(owner).setMaxStakeAmount(ethers.utils.parseEther('100'))

      await expect(sYusd.connect(user1).stake(ethers.utils.parseEther('101')))
        .to.be.revertedWithCustomError(sYusd, 'AboveMaxStakeAmount')
    })

    it('Should update lastStakeTimestamp when staking', async function () {
      await sYusd.connect(user1).stake(ethers.utils.parseEther('100'))

      const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp
      expect(await sYusd.lastStakeTimestamp(user1.address)).to.equal(blockTimestamp)
    })
  })

  describe('Unstaking', function () {
    beforeEach(async function () {
      // User1 stakes 1000 YUSD
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
    })

    it('Should allow users to unstake sYUSD and receive YUSD', async function () {
      const unstakeAmount = ethers.utils.parseEther('500') // Unstake half

      await expect(sYusd.connect(user1).unstake(unstakeAmount))
        .to.emit(sYusd, 'Unstaked')
        .withArgs(user1.address, unstakeAmount, unstakeAmount) // 1:1 ratio initially

      expect(await sYusd.balanceOf(user1.address)).to.equal(ethers.utils.parseEther('500'))
      expect(await sYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('500'))
      expect(await yusd.balanceOf(sYusd.address)).to.equal(ethers.utils.parseEther('500'))
    })

    it('Should maintain the correct exchange rate after rewards and unstaking', async function () {
      // Add rewards, which increases the YUSD per sYUSD ratio
      const rewardAmount = ethers.utils.parseEther('500')
      await sYusd.connect(rewardsDistributor).addRewards(rewardAmount)

      // Exchange rate should now be 1.5 YUSD per sYUSD
      expect(await sYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1.5'))

      // Unstake half of sYUSD, should get 750 YUSD back (500 * 1.5)
      const unstakeAmount = ethers.utils.parseEther('500')
      const expectedYUSD = ethers.utils.parseEther('750')

      await expect(sYusd.connect(user1).unstake(unstakeAmount))
        .to.emit(sYusd, 'Unstaked')
        .withArgs(user1.address, unstakeAmount, expectedYUSD)

      expect(await sYusd.balanceOf(user1.address)).to.equal(ethers.utils.parseEther('500'))
      expect(await sYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('750'))
      expect(await yusd.balanceOf(sYusd.address)).to.equal(ethers.utils.parseEther('750'))

      // Exchange rate should remain 1.5
      expect(await sYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1.5'))
    })

    it('Should revert when unstaking is disabled', async function () {
      await sYusd.connect(owner).setUnstakingEnabled(false)

      await expect(sYusd.connect(user1).unstake(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(sYusd, 'UnstakingDisabled')
    })

    it('Should respect cooldown period when set', async function () {
      // Set cooldown period to 1 day
      const cooldownPeriod = 86400 // 1 day in seconds
      await sYusd.connect(owner).setCooldownPeriod(cooldownPeriod)

      // Try to unstake immediately, should fail
      await expect(sYusd.connect(user1).unstake(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(sYusd, 'CooldownActive')

      // Advance time past cooldown
      await time.increase(cooldownPeriod + 1)

      // Now unstaking should work
      await expect(sYusd.connect(user1).unstake(ethers.utils.parseEther('100')))
        .to.emit(sYusd, 'Unstaked')
    })
  })

  describe('Rewards', function () {
    beforeEach(async function () {
      // User1 stakes 1000 YUSD
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
    })

    it('Should allow rewards distributor to add rewards', async function () {
      const rewardAmount = ethers.utils.parseEther('500')

      await expect(sYusd.connect(rewardsDistributor).addRewards(rewardAmount))
        .to.emit(sYusd, 'RewardsAdded')
        .withArgs(rewardAmount)

      expect(await sYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('1500'))
      expect(await yusd.balanceOf(sYusd.address)).to.equal(ethers.utils.parseEther('1500'))
    })

    it('Should increase exchange rate when rewards are added', async function () {
      // Initial exchange rate should be 1:1
      expect(await sYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1'))

      // Add rewards
      const rewardAmount = ethers.utils.parseEther('1000')
      await sYusd.connect(rewardsDistributor).addRewards(rewardAmount)

      // New exchange rate should be 2:1 (2000 YUSD / 1000 sYUSD)
      expect(await sYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('2'))
    })

    it('Should revert when non-rewards distributor attempts to add rewards', async function () {
      await expect(sYusd.connect(user2).addRewards(ethers.utils.parseEther('100')))
        .to.be.revertedWith(/AccessControl: account .* is missing role.*/)
    })

    it('Should revert with zero amount reward', async function () {
      await expect(sYusd.connect(rewardsDistributor).addRewards(0))
        .to.be.revertedWithCustomError(sYusd, 'ZeroAmount')
    })

    it('Should revert when adding rewards with no stakers', async function () {
      // Unstake all user1's tokens
      await sYusd.connect(user1).unstake(await sYusd.balanceOf(user1.address))

      // Attempting to add rewards with no stakers should fail
      await expect(sYusd.connect(rewardsDistributor).addRewards(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(sYusd, 'NoStakers')
    })
  })

  describe('Admin Functions', function () {
    it('Should allow admin to rescue excess YUSD', async function () {
      // First stake some YUSD
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))

      // Send extra YUSD directly to the contract (bypassing stake)
      await yusd.transfer(sYusd.address, ethers.utils.parseEther('500'))

      // Rescue the excess YUSD
      await expect(sYusd.connect(owner).rescueYUSD(owner.address, ethers.utils.parseEther('500')))
        .to.emit(sYusd, 'YUSDRescued')
        .withArgs(owner.address, ethers.utils.parseEther('500'))

      // Total held should still be 1000 (staked) + 0 (rescued excess)
      expect(await sYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('1000'))
    })

    it('Should revert when trying to rescue more YUSD than excess', async function () {
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      await yusd.transfer(sYusd.address, ethers.utils.parseEther('500'))

      // Try to rescue more than excess
      await expect(sYusd.connect(owner).rescueYUSD(owner.address, ethers.utils.parseEther('600')))
        .to.be.revertedWithCustomError(sYusd, 'InsufficientRescuableAmount')
    })

    it('Should allow admin to rescue other ERC20 tokens', async function () {
      // Deploy a mock ERC20 for testing
      const ERC20Mock = await ethers.getContractFactory('YUSD') // Reusing YUSD as generic ERC20
      const mockToken = await ERC20Mock.deploy(owner.address)
      await mockToken.deployed()

      // Set minter role
      await mockToken.setMinter(owner.address)

      // Mint some tokens and send to sYUSD contract
      await mockToken.mint(sYusd.address, ethers.utils.parseEther('1000'))

      // Rescue those tokens
      await expect(sYusd.connect(owner).rescueERC20(mockToken.address, owner.address, ethers.utils.parseEther('1000')))
        .to.emit(sYusd, 'ERC20Rescued')
        .withArgs(mockToken.address, owner.address, ethers.utils.parseEther('1000'))

      expect(await mockToken.balanceOf(owner.address)).to.equal(ethers.utils.parseEther('1000'))
    })

    it('Should revert when trying to rescue YUSD using rescueERC20', async function () {
      await expect(sYusd.connect(owner).rescueERC20(yusd.address, owner.address, ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(sYusd, 'CannotRescueUnderlyingAsset')
    })

    it('Should allow admin to set minimum stake amount', async function () {
      const newMinStakeAmount = ethers.utils.parseEther('10')

      await expect(sYusd.connect(owner).setMinStakeAmount(newMinStakeAmount))
        .to.emit(sYusd, 'MinStakeAmountUpdated')
        .withArgs(newMinStakeAmount)

      expect(await sYusd.minStakeAmount()).to.equal(newMinStakeAmount)
    })

    it('Should allow admin to set maximum stake amount', async function () {
      const newMaxStakeAmount = ethers.utils.parseEther('10000')

      await expect(sYusd.connect(owner).setMaxStakeAmount(newMaxStakeAmount))
        .to.emit(sYusd, 'MaxStakeAmountUpdated')
        .withArgs(newMaxStakeAmount)

      expect(await sYusd.maxStakeAmount()).to.equal(newMaxStakeAmount)
    })

    it('Should allow admin to disable staking', async function () {
      await expect(sYusd.connect(owner).setStakingEnabled(false))
        .to.emit(sYusd, 'StakingStatusUpdated')
        .withArgs(false)

      expect(await sYusd.stakingEnabled()).to.be.false
    })

    it('Should allow admin to disable unstaking', async function () {
      await expect(sYusd.connect(owner).setUnstakingEnabled(false))
        .to.emit(sYusd, 'UnstakingStatusUpdated')
        .withArgs(false)

      expect(await sYusd.unstakingEnabled()).to.be.false
    })

    it('Should allow admin to set cooldown period', async function () {
      const newCooldownPeriod = 86400 // 1 day in seconds

      await expect(sYusd.connect(owner).setCooldownPeriod(newCooldownPeriod))
        .to.emit(sYusd, 'CooldownPeriodUpdated')
        .withArgs(newCooldownPeriod)

      expect(await sYusd.cooldownPeriod()).to.equal(newCooldownPeriod)
    })
  })

  describe('Transfer', function () {
    beforeEach(async function () {
      // User1 stakes 1000 YUSD
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
    })

    it('Should allow transfer of sYUSD between accounts', async function () {
      const transferAmount = ethers.utils.parseEther('500')

      await expect(sYusd.connect(user1).transfer(user2.address, transferAmount))
        .to.emit(sYusd, 'Transfer')
        .withArgs(user1.address, user2.address, transferAmount)

      expect(await sYusd.balanceOf(user1.address)).to.equal(ethers.utils.parseEther('500'))
      expect(await sYusd.balanceOf(user2.address)).to.equal(transferAmount)
    })

    it('Should update cooldown timestamp on transfer when cooldown is active', async function () {
      // Set cooldown period
      await sYusd.connect(owner).setCooldownPeriod(86400) // 1 day

      // Transfer sYUSD
      await sYusd.connect(user1).transfer(user2.address, ethers.utils.parseEther('500'))

      // Check that recipient has the current timestamp as their last stake timestamp
      const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp
      expect(await sYusd.lastStakeTimestamp(user2.address)).to.equal(blockTimestamp)
    })
  })

  describe('Exchange Rate Calculations', function () {
    it('Should correctly calculate sYUSD for YUSD amounts', async function () {
      // Initial state: no deposits, 1:1 ratio
      expect(await sYusd.getsYUSDForYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // After first stake, should remain 1:1
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      expect(await sYusd.getsYUSDForYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // Add rewards to change the rate to 2 YUSD per sYUSD
      await sYusd.connect(rewardsDistributor).addRewards(ethers.utils.parseEther('1000'))
      // Now 100 YUSD should give 50 sYUSD
      expect(await sYusd.getsYUSDForYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('50'))
    })

    it('Should correctly calculate YUSD for sYUSD amounts', async function () {
      // Initial state: no deposits, 1:1 ratio
      expect(await sYusd.getYUSDForsYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // After first stake, should remain 1:1
      await sYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      expect(await sYusd.getYUSDForsYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // Add rewards to change the rate to 2 YUSD per sYUSD
      await sYusd.connect(rewardsDistributor).addRewards(ethers.utils.parseEther('1000'))
      // Now 50 sYUSD should give 100 YUSD
      expect(await sYusd.getYUSDForsYUSD(ethers.utils.parseEther('50'))).to.equal(ethers.utils.parseEther('100'))
    })

    it('Should handle zero amounts correctly', async function () {
      expect(await sYusd.getsYUSDForYUSD(0)).to.equal(0)
      expect(await sYusd.getYUSDForsYUSD(0)).to.equal(0)
    })
  })
})
