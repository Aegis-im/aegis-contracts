/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable no-undef */
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { time } = require('@nomicfoundation/hardhat-network-helpers')

describe('StYUSD', function () {
  let yusd
  let stYusd
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

    // Deploy StYUSD token
    const StYUSD = await ethers.getContractFactory('StYUSD')
    stYusd = await StYUSD.deploy(
      yusd.address,
      owner.address,
      rewardsDistributor.address,
    )
    await stYusd.deployed()

    // Distribute some YUSD to users for testing
    await yusd.transfer(user1.address, ethers.utils.parseEther('10000'))
    await yusd.transfer(user2.address, ethers.utils.parseEther('10000'))
    await yusd.transfer(rewardsDistributor.address, ethers.utils.parseEther('100000'))

    // Approve stYUSD contract to spend YUSD
    await yusd.connect(user1).approve(stYusd.address, ethers.constants.MaxUint256)
    await yusd.connect(user2).approve(stYusd.address, ethers.constants.MaxUint256)
    await yusd.connect(rewardsDistributor).approve(stYusd.address, ethers.constants.MaxUint256)
    await yusd.connect(owner).approve(stYusd.address, ethers.constants.MaxUint256)
  })

  describe('Deployment', function () {
    it('Should set the correct name and symbol', async function () {
      expect(await stYusd.name()).to.equal('Staked YUSD')
      expect(await stYusd.symbol()).to.equal('stYUSD')
    })

    it('Should set the correct YUSD token address', async function () {
      expect(await stYusd.yusd()).to.equal(yusd.address)
    })

    it('Should assign roles correctly', async function () {
      expect(await stYusd.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true
      expect(await stYusd.hasRole(ADMIN_ROLE, owner.address)).to.be.true
      expect(await stYusd.hasRole(REWARDS_DISTRIBUTOR_ROLE, rewardsDistributor.address)).to.be.true
    })

    it('Should revert when YUSD address is zero', async function () {
      const StYUSD = await ethers.getContractFactory('StYUSD')
      await expect(
        StYUSD.deploy(ZERO_ADDRESS, owner.address, rewardsDistributor.address),
      ).to.be.revertedWithCustomError(StYUSD, 'ZeroAddress')
    })

    it('Should revert when admin address is zero', async function () {
      const StYUSD = await ethers.getContractFactory('StYUSD')
      await expect(
        StYUSD.deploy(yusd.address, ZERO_ADDRESS, rewardsDistributor.address),
      ).to.be.revertedWithCustomError(StYUSD, 'ZeroAddress')
    })
  })

  describe('Staking', function () {
    it('Should allow users to stake YUSD and receive stYUSD', async function () {
      const stakeAmount = ethers.utils.parseEther('1000')

      await expect(stYusd.connect(user1).stake(stakeAmount))
        .to.emit(stYusd, 'Staked')
        .withArgs(user1.address, stakeAmount, stakeAmount) // 1:1 ratio initially

      expect(await stYusd.balanceOf(user1.address)).to.equal(stakeAmount)
      expect(await stYusd.totalYUSDHeld()).to.equal(stakeAmount)
      expect(await yusd.balanceOf(stYusd.address)).to.equal(stakeAmount)
    })

    it('Should maintain the correct exchange rate after multiple stakes', async function () {
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      await stYusd.connect(user2).stake(ethers.utils.parseEther('500'))

      expect(await stYusd.totalSupply()).to.equal(ethers.utils.parseEther('1500'))
      expect(await stYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('1500'))
      expect(await stYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1'))
    })

    it('Should revert when staking is disabled', async function () {
      await stYusd.connect(owner).setStakingEnabled(false)

      await expect(stYusd.connect(user1).stake(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(stYusd, 'StakingDisabled')
    })

    it('Should revert when staking below minimum amount', async function () {
      const minStakeAmount = await stYusd.minStakeAmount()

      await expect(stYusd.connect(user1).stake(minStakeAmount.sub(1)))
        .to.be.revertedWithCustomError(stYusd, 'BelowMinStakeAmount')
    })

    it('Should revert when staking above maximum amount if set', async function () {
      await stYusd.connect(owner).setMaxStakeAmount(ethers.utils.parseEther('100'))

      await expect(stYusd.connect(user1).stake(ethers.utils.parseEther('101')))
        .to.be.revertedWithCustomError(stYusd, 'AboveMaxStakeAmount')
    })

    it('Should update lastStakeTimestamp when staking', async function () {
      await stYusd.connect(user1).stake(ethers.utils.parseEther('100'))

      const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp
      expect(await stYusd.lastStakeTimestamp(user1.address)).to.equal(blockTimestamp)
    })
  })

  describe('Unstaking', function () {
    beforeEach(async function () {
      // User1 stakes 1000 YUSD
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
    })

    it('Should allow users to unstake stYUSD and receive YUSD', async function () {
      const unstakeAmount = ethers.utils.parseEther('500') // Unstake half

      await expect(stYusd.connect(user1).unstake(unstakeAmount))
        .to.emit(stYusd, 'Unstaked')
        .withArgs(user1.address, unstakeAmount, unstakeAmount) // 1:1 ratio initially

      expect(await stYusd.balanceOf(user1.address)).to.equal(ethers.utils.parseEther('500'))
      expect(await stYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('500'))
      expect(await yusd.balanceOf(stYusd.address)).to.equal(ethers.utils.parseEther('500'))
    })

    it('Should maintain the correct exchange rate after rewards and unstaking', async function () {
      // Add rewards, which increases the YUSD per stYUSD ratio
      const rewardAmount = ethers.utils.parseEther('500')
      await stYusd.connect(rewardsDistributor).addRewards(rewardAmount)

      // Exchange rate should now be 1.5 YUSD per stYUSD
      expect(await stYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1.5'))

      // Unstake half of stYUSD, should get 750 YUSD back (500 * 1.5)
      const unstakeAmount = ethers.utils.parseEther('500')
      const expectedYUSD = ethers.utils.parseEther('750')

      await expect(stYusd.connect(user1).unstake(unstakeAmount))
        .to.emit(stYusd, 'Unstaked')
        .withArgs(user1.address, unstakeAmount, expectedYUSD)

      expect(await stYusd.balanceOf(user1.address)).to.equal(ethers.utils.parseEther('500'))
      expect(await stYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('750'))
      expect(await yusd.balanceOf(stYusd.address)).to.equal(ethers.utils.parseEther('750'))

      // Exchange rate should remain 1.5
      expect(await stYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1.5'))
    })

    it('Should revert when unstaking is disabled', async function () {
      await stYusd.connect(owner).setUnstakingEnabled(false)

      await expect(stYusd.connect(user1).unstake(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(stYusd, 'UnstakingDisabled')
    })

    it('Should respect cooldown period when set', async function () {
      // Set cooldown period to 1 day
      const cooldownPeriod = 86400 // 1 day in seconds
      await stYusd.connect(owner).setCooldownPeriod(cooldownPeriod)

      // Try to unstake immediately, should fail
      await expect(stYusd.connect(user1).unstake(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(stYusd, 'CooldownActive')

      // Advance time past cooldown
      await time.increase(cooldownPeriod + 1)

      // Now unstaking should work
      await expect(stYusd.connect(user1).unstake(ethers.utils.parseEther('100')))
        .to.emit(stYusd, 'Unstaked')
    })
  })

  describe('Rewards', function () {
    beforeEach(async function () {
      // User1 stakes 1000 YUSD
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
    })

    it('Should allow rewards distributor to add rewards', async function () {
      const rewardAmount = ethers.utils.parseEther('500')

      await expect(stYusd.connect(rewardsDistributor).addRewards(rewardAmount))
        .to.emit(stYusd, 'RewardsAdded')
        .withArgs(rewardAmount)

      expect(await stYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('1500'))
      expect(await yusd.balanceOf(stYusd.address)).to.equal(ethers.utils.parseEther('1500'))
    })

    it('Should increase exchange rate when rewards are added', async function () {
      // Initial exchange rate should be 1:1
      expect(await stYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('1'))

      // Add rewards
      const rewardAmount = ethers.utils.parseEther('1000')
      await stYusd.connect(rewardsDistributor).addRewards(rewardAmount)

      // New exchange rate should be 2:1 (2000 YUSD / 1000 stYUSD)
      expect(await stYusd.getExchangeRate()).to.equal(ethers.utils.parseEther('2'))
    })

    it('Should revert when non-rewards distributor attempts to add rewards', async function () {
      await expect(stYusd.connect(user2).addRewards(ethers.utils.parseEther('100')))
        .to.be.revertedWith(/AccessControl: account .* is missing role.*/)
    })

    it('Should revert with zero amount reward', async function () {
      await expect(stYusd.connect(rewardsDistributor).addRewards(0))
        .to.be.revertedWithCustomError(stYusd, 'ZeroAmount')
    })

    it('Should revert when adding rewards with no stakers', async function () {
      // Unstake all user1's tokens
      await stYusd.connect(user1).unstake(await stYusd.balanceOf(user1.address))

      // Attempting to add rewards with no stakers should fail
      await expect(stYusd.connect(rewardsDistributor).addRewards(ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(stYusd, 'NoStakers')
    })
  })

  describe('Admin Functions', function () {
    it('Should allow admin to rescue excess YUSD', async function () {
      // First stake some YUSD
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))

      // Send extra YUSD directly to the contract (bypassing stake)
      await yusd.transfer(stYusd.address, ethers.utils.parseEther('500'))

      // Rescue the excess YUSD
      await expect(stYusd.connect(owner).rescueYUSD(owner.address, ethers.utils.parseEther('500')))
        .to.emit(stYusd, 'YUSDRescued')
        .withArgs(owner.address, ethers.utils.parseEther('500'))

      // Total held should still be 1000 (staked) + 0 (rescued excess)
      expect(await stYusd.totalYUSDHeld()).to.equal(ethers.utils.parseEther('1000'))
    })

    it('Should revert when trying to rescue more YUSD than excess', async function () {
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      await yusd.transfer(stYusd.address, ethers.utils.parseEther('500'))

      // Try to rescue more than excess
      await expect(stYusd.connect(owner).rescueYUSD(owner.address, ethers.utils.parseEther('600')))
        .to.be.revertedWithCustomError(stYusd, 'InsufficientRescuableAmount')
    })

    it('Should allow admin to rescue other ERC20 tokens', async function () {
      // Deploy a mock ERC20 for testing
      const ERC20Mock = await ethers.getContractFactory('YUSD') // Reusing YUSD as generic ERC20
      const mockToken = await ERC20Mock.deploy(owner.address)
      await mockToken.deployed()

      // Set minter role
      await mockToken.setMinter(owner.address)

      // Mint some tokens and send to stYUSD contract
      await mockToken.mint(stYusd.address, ethers.utils.parseEther('1000'))

      // Rescue those tokens
      await expect(stYusd.connect(owner).rescueERC20(mockToken.address, owner.address, ethers.utils.parseEther('1000')))
        .to.emit(stYusd, 'ERC20Rescued')
        .withArgs(mockToken.address, owner.address, ethers.utils.parseEther('1000'))

      expect(await mockToken.balanceOf(owner.address)).to.equal(ethers.utils.parseEther('1000'))
    })

    it('Should revert when trying to rescue YUSD using rescueERC20', async function () {
      await expect(stYusd.connect(owner).rescueERC20(yusd.address, owner.address, ethers.utils.parseEther('100')))
        .to.be.revertedWithCustomError(stYusd, 'CannotRescueUnderlyingAsset')
    })

    it('Should allow admin to set minimum stake amount', async function () {
      const newMinStakeAmount = ethers.utils.parseEther('10')

      await expect(stYusd.connect(owner).setMinStakeAmount(newMinStakeAmount))
        .to.emit(stYusd, 'MinStakeAmountUpdated')
        .withArgs(newMinStakeAmount)

      expect(await stYusd.minStakeAmount()).to.equal(newMinStakeAmount)
    })

    it('Should allow admin to set maximum stake amount', async function () {
      const newMaxStakeAmount = ethers.utils.parseEther('10000')

      await expect(stYusd.connect(owner).setMaxStakeAmount(newMaxStakeAmount))
        .to.emit(stYusd, 'MaxStakeAmountUpdated')
        .withArgs(newMaxStakeAmount)

      expect(await stYusd.maxStakeAmount()).to.equal(newMaxStakeAmount)
    })

    it('Should allow admin to disable staking', async function () {
      await expect(stYusd.connect(owner).setStakingEnabled(false))
        .to.emit(stYusd, 'StakingStatusUpdated')
        .withArgs(false)

      expect(await stYusd.stakingEnabled()).to.be.false
    })

    it('Should allow admin to disable unstaking', async function () {
      await expect(stYusd.connect(owner).setUnstakingEnabled(false))
        .to.emit(stYusd, 'UnstakingStatusUpdated')
        .withArgs(false)

      expect(await stYusd.unstakingEnabled()).to.be.false
    })

    it('Should allow admin to set cooldown period', async function () {
      const newCooldownPeriod = 86400 // 1 day in seconds

      await expect(stYusd.connect(owner).setCooldownPeriod(newCooldownPeriod))
        .to.emit(stYusd, 'CooldownPeriodUpdated')
        .withArgs(newCooldownPeriod)

      expect(await stYusd.cooldownPeriod()).to.equal(newCooldownPeriod)
    })
  })

  describe('Transfer', function () {
    beforeEach(async function () {
      // User1 stakes 1000 YUSD
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
    })

    it('Should allow transfer of stYUSD between accounts', async function () {
      const transferAmount = ethers.utils.parseEther('500')

      await expect(stYusd.connect(user1).transfer(user2.address, transferAmount))
        .to.emit(stYusd, 'Transfer')
        .withArgs(user1.address, user2.address, transferAmount)

      expect(await stYusd.balanceOf(user1.address)).to.equal(ethers.utils.parseEther('500'))
      expect(await stYusd.balanceOf(user2.address)).to.equal(transferAmount)
    })

    it('Should update cooldown timestamp on transfer when cooldown is active', async function () {
      // Set cooldown period
      await stYusd.connect(owner).setCooldownPeriod(86400) // 1 day

      // Transfer stYUSD
      await stYusd.connect(user1).transfer(user2.address, ethers.utils.parseEther('500'))

      // Check that recipient has the current timestamp as their last stake timestamp
      const blockTimestamp = (await ethers.provider.getBlock('latest')).timestamp
      expect(await stYusd.lastStakeTimestamp(user2.address)).to.equal(blockTimestamp)
    })
  })

  describe('Exchange Rate Calculations', function () {
    it('Should correctly calculate stYUSD for YUSD amounts', async function () {
      // Initial state: no deposits, 1:1 ratio
      expect(await stYusd.getStYUSDForYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // After first stake, should remain 1:1
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      expect(await stYusd.getStYUSDForYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // Add rewards to change the rate to 2 YUSD per stYUSD
      await stYusd.connect(rewardsDistributor).addRewards(ethers.utils.parseEther('1000'))
      // Now 100 YUSD should give 50 stYUSD
      expect(await stYusd.getStYUSDForYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('50'))
    })

    it('Should correctly calculate YUSD for stYUSD amounts', async function () {
      // Initial state: no deposits, 1:1 ratio
      expect(await stYusd.getYUSDForStYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // After first stake, should remain 1:1
      await stYusd.connect(user1).stake(ethers.utils.parseEther('1000'))
      expect(await stYusd.getYUSDForStYUSD(ethers.utils.parseEther('100'))).to.equal(ethers.utils.parseEther('100'))

      // Add rewards to change the rate to 2 YUSD per stYUSD
      await stYusd.connect(rewardsDistributor).addRewards(ethers.utils.parseEther('1000'))
      // Now 50 stYUSD should give 100 YUSD
      expect(await stYusd.getYUSDForStYUSD(ethers.utils.parseEther('50'))).to.equal(ethers.utils.parseEther('100'))
    })

    it('Should handle zero amounts correctly', async function () {
      expect(await stYusd.getStYUSDForYUSD(0)).to.equal(0)
      expect(await stYusd.getYUSDForStYUSD(0)).to.equal(0)
    })
  })
})
