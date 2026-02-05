import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  REWARDS_MANAGER_ROLE,
  DAILY_UPDATER_ROLE,
  DISTRIBUTOR_ROLE,
  deployRewardsV2Fixture,
  encodeString,
  signClaimRequestV2,
  signClaimRequestV2ByWallet,
} from '../utils/helpers'

describe('AegisRewardsV2', () => {
  describe('#depositRewards', () => {
    describe('success', () => {
      it('should add rewards to a total amount', async function () {
        this.timeout(240000)
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('1000')

        // Transfer tokens to contract first
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)

        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const reward = await aegisRewardsV2Contract.rewardById(snapshotId)
        expect(reward.amount).to.equal(amount)
      })
    })

    describe('error', () => {
      it('should revert when caller is not authorized', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(aegisRewardsV2Contract.connect(user).depositRewards(encodeString('test'), ethers.parseEther('1'))).to.be.reverted
      })
    })
  })

  describe('#updateDailyRewards', () => {
    describe('success', () => {
      it('should update daily rewards distribution', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('10000')

        // Transfer tokens to contract and deposit
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const stakingBalance = ethers.parseEther('10000000') // 10M staking
        const totalEligible = ethers.parseEther('20000000') // 20M total (10M staking + 10M users)

        await expect(aegisRewardsV2Contract.updateDailyRewards(bytes32SnapshotId, stakingBalance, totalEligible))
          .to.emit(aegisRewardsV2Contract, 'DailyRewardsUpdate')

        const dailyUpdate = await aegisRewardsV2Contract.getDailyUpdate(bytes32SnapshotId, 0)
        expect(dailyUpdate.totalDeposited).to.equal(amount)
        // stakingShare should be 50% of total (10M/20M)
        expect(dailyUpdate.stakingShare).to.equal(amount / 2n)
        expect(dailyUpdate.usersShare).to.equal(amount / 2n)

        // Day counter should be incremented
        expect(await aegisRewardsV2Contract.getCurrentDay(bytes32SnapshotId)).to.equal(1)
      })

      it('should handle changing staking balance ratio', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('10000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)

        // Day 1: 50-50 split
        await aegisRewardsV2Contract.updateDailyRewards(
          bytes32SnapshotId,
          ethers.parseEther('10000000'), // 10M staking
          ethers.parseEther('20000000'),  // 20M total
        )

        // Day 2: Staking increased to 20M (66.67% of 30M total)
        await aegisRewardsV2Contract.updateDailyRewards(
          bytes32SnapshotId,
          ethers.parseEther('20000000'), // 20M staking
          ethers.parseEther('30000000'),  // 30M total
        )

        const dailyUpdate = await aegisRewardsV2Contract.getDailyUpdate(bytes32SnapshotId, 1)
        // stakingShare should be ~66.67% of total (20M/30M)
        const expectedStakingShare = (amount * 20000000n) / 30000000n
        expect(dailyUpdate.stakingShare).to.equal(expectedStakingShare)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have DAILY_UPDATER_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).updateDailyRewards(
            ethers.encodeBytes32String('test'),
            ethers.parseEther('10000000'),
            ethers.parseEther('20000000'),
          ),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when totalEligibleBalance is zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)

        await expect(
          aegisRewardsV2Contract.updateDailyRewards(
            ethers.encodeBytes32String('test'),
            ethers.parseEther('10000000'),
            0,
          ),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ZeroRewards')
      })
    })
  })

  describe('#sendToStaking', () => {
    describe('success', () => {
      it('should send staking portion to staking contract', async () => {
        const [owner, stakingContract] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)
        await aegisRewardsV2Contract.setStakingContract(stakingContract.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('10000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const stakingAmount = ethers.parseEther('5000')

        const stakingBalanceBefore = await yusdContract.balanceOf(stakingContract.address)
        await aegisRewardsV2Contract.sendToStaking(bytes32SnapshotId, stakingAmount)
        const stakingBalanceAfter = await yusdContract.balanceOf(stakingContract.address)

        expect(stakingBalanceAfter - stakingBalanceBefore).to.equal(stakingAmount)

        const reward = await aegisRewardsV2Contract.rewardById(snapshotId)
        expect(reward.amount).to.equal(amount - stakingAmount)
      })
    })

    describe('error', () => {
      it('should revert when staking contract is not set', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('10000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        await expect(
          aegisRewardsV2Contract.sendToStaking(ethers.encodeBytes32String(snapshotId), amount),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ZeroAddress')
      })
    })
  })

  describe('#setUserRewards', () => {
    describe('success', () => {
      it('should set user rewards on-chain', async () => {
        const [owner, user1, user2] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)

        const snapshotId = ethers.encodeBytes32String('week-2024-01')
        const users = [user1.address, user2.address]
        const amounts = [ethers.parseEther('100'), ethers.parseEther('200')]

        await expect(aegisRewardsV2Contract.setUserRewards(snapshotId, users, amounts))
          .to.emit(aegisRewardsV2Contract, 'SetUserRewards')
          .withArgs(snapshotId, user1.address, amounts[0])

        const user1Rewards = await aegisRewardsV2Contract.getUserRewards(snapshotId, user1.address)
        expect(user1Rewards.amount).to.equal(amounts[0])
        expect(user1Rewards.claimed).to.equal(false)

        const user2Rewards = await aegisRewardsV2Contract.getUserRewards(snapshotId, user2.address)
        expect(user2Rewards.amount).to.equal(amounts[1])
        expect(user2Rewards.claimed).to.equal(false)
      })
    })

    describe('error', () => {
      it('should revert when arrays have different lengths', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)

        const snapshotId = ethers.encodeBytes32String('week-2024-01')
        const users = [user1.address]
        const amounts = [ethers.parseEther('100'), ethers.parseEther('200')]

        await expect(aegisRewardsV2Contract.setUserRewards(snapshotId, users, amounts))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidAddress')
      })

      it('should revert when caller does not have REWARDS_MANAGER_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).setUserRewards(
            ethers.encodeBytes32String('test'),
            [user.address],
            [ethers.parseEther('100')],
          ),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#claimOnChainRewards', () => {
    describe('success', () => {
      it('should allow user to claim on-chain rewards', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const totalAmount = ethers.parseEther('1000')
        const userAmount = ethers.parseEther('100')

        // Deposit rewards
        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), totalAmount)

        // Set user rewards
        await aegisRewardsV2Contract.setUserRewards(bytes32SnapshotId, [user1.address], [userAmount])

        // Finalize rewards
        await aegisRewardsV2Contract.finalizeRewards(bytes32SnapshotId, 0)

        const userBalanceBefore = await yusdContract.balanceOf(user1.address)

        // Claim
        await expect(aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId))
          .to.emit(aegisRewardsV2Contract, 'ClaimRewards')
          .withArgs(user1.address, [bytes32SnapshotId], userAmount)

        const userBalanceAfter = await yusdContract.balanceOf(user1.address)
        expect(userBalanceAfter - userBalanceBefore).to.equal(userAmount)

        // Verify claimed flag
        const userRewards = await aegisRewardsV2Contract.getUserRewards(bytes32SnapshotId, user1.address)
        expect(userRewards.claimed).to.equal(true)
      })
    })

    describe('error', () => {
      it('should revert when snapshot is not finalized', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const totalAmount = ethers.parseEther('1000')

        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), totalAmount)
        await aegisRewardsV2Contract.setUserRewards(bytes32SnapshotId, [user1.address], [ethers.parseEther('100')])

        // Try to claim without finalizing
        await expect(aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'SnapshotNotFinalized')
      })

      it('should revert when rewards already claimed', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const totalAmount = ethers.parseEther('1000')
        const userAmount = ethers.parseEther('100')

        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), totalAmount)
        await aegisRewardsV2Contract.setUserRewards(bytes32SnapshotId, [user1.address], [userAmount])
        await aegisRewardsV2Contract.finalizeRewards(bytes32SnapshotId, 0)

        // First claim succeeds
        await aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId)

        // Second claim fails
        await expect(aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AlreadyClaimed')
      })

      it('should revert when user has no rewards set', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)

        await yusdContract.mint(owner, ethers.parseEther('1000'))
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), ethers.parseEther('1000'))
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), ethers.parseEther('1000'))
        await aegisRewardsV2Contract.finalizeRewards(bytes32SnapshotId, 0)

        // User1 has no rewards set
        await expect(aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'UserRewardsNotSet')
      })
    })
  })

  describe('#claimRewards (signature-based)', () => {
    describe('success', () => {
      it('should claim rewards using signature', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const amount = ethers.parseEther('1000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)
        await aegisRewardsV2Contract.finalizeRewards(bytes32SnapshotId, 0)

        const contractAddress = await aegisRewardsV2Contract.getAddress()
        const claimRequest = {
          claimer: owner.address,
          ids: [bytes32SnapshotId],
          amounts: [amount],
        }
        const signature = await signClaimRequestV2(claimRequest, contractAddress)

        const balanceBefore = await yusdContract.balanceOf(owner.address)

        await expect(aegisRewardsV2Contract.claimRewards(claimRequest, signature))
          .to.emit(aegisRewardsV2Contract, 'ClaimRewards')
          .withArgs(owner.address, [bytes32SnapshotId], amount)

        const balanceAfter = await yusdContract.balanceOf(owner.address)
        expect(balanceAfter - balanceBefore).to.equal(amount)
      })
    })

    describe('error', () => {
      it('should revert when caller is not a claimer', async () => {
        const [owner, sender] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('1000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const contractAddress = await aegisRewardsV2Contract.getAddress()
        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount],
        }
        const signature = await signClaimRequestV2(claimRequest, contractAddress)

        await expect(
          aegisRewardsV2Contract.connect(sender).claimRewards(claimRequest, signature),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidClaimer')
      })

      it('should revert when signed by unknown account', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('1000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const unknownSigner = await ethers.Wallet.createRandom()
        const contractAddress = await aegisRewardsV2Contract.getAddress()
        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount],
        }
        const signature = await signClaimRequestV2ByWallet(claimRequest, contractAddress, unknownSigner)

        await expect(aegisRewardsV2Contract.claimRewards(claimRequest, signature))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidSignature')
      })
    })
  })

  describe('#rescueRewards', () => {
    describe('success', () => {
      it('should rescue rewards for a user', async () => {
        const [owner, user1, user2] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const totalAmount = ethers.parseEther('1000')
        const userAmount = ethers.parseEther('100')

        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), totalAmount)
        await aegisRewardsV2Contract.setUserRewards(bytes32SnapshotId, [user1.address], [userAmount])

        const user2BalanceBefore = await yusdContract.balanceOf(user2.address)

        // Admin rescues user1's rewards to user2 (e.g., lost wallet scenario)
        await expect(aegisRewardsV2Contract.rescueRewards(bytes32SnapshotId, user1.address, user2.address))
          .to.emit(aegisRewardsV2Contract, 'RescueRewards')
          .withArgs(bytes32SnapshotId, user1.address, user2.address, userAmount)

        const user2BalanceAfter = await yusdContract.balanceOf(user2.address)
        expect(user2BalanceAfter - user2BalanceBefore).to.equal(userAmount)

        // Verify user1's rewards are marked as claimed
        const userRewards = await aegisRewardsV2Contract.getUserRewards(bytes32SnapshotId, user1.address)
        expect(userRewards.claimed).to.equal(true)
      })
    })

    describe('error', () => {
      it('should revert when caller is not admin', async () => {
        const [, user1, user2] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user1).rescueRewards(
            ethers.encodeBytes32String('test'),
            user1.address,
            user2.address,
          ),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when destination is zero address', async () => {
        const [_, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.rescueRewards(
            ethers.encodeBytes32String('test'),
            user1.address,
            ethers.ZeroAddress,
          ),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ZeroAddress')
      })
    })
  })

  describe('#finalizeRewards', () => {
    describe('success', () => {
      it('should finalize rewards with id', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = ethers.encodeBytes32String('test')
        const claimDuration = 10
        const timestamp = await time.latest()
        await expect(aegisRewardsV2Contract.finalizeRewards(snapshotId, claimDuration))
          .to.emit(aegisRewardsV2Contract, 'FinalizeRewards')
          .withArgs(snapshotId, timestamp + 1 + claimDuration)

        const reward = await aegisRewardsV2Contract.rewardById('test')
        expect(reward.finalized).to.be.equal(true)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have REWARDS_MANAGER_ROLE role', async () => {
        const [, unknownUser] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(unknownUser).finalizeRewards(ethers.encodeBytes32String('test'), 0),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when already finalized', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner)

        await expect(aegisRewardsV2Contract.finalizeRewards(ethers.encodeBytes32String('test'), 0)).not.to.be.reverted

        await expect(
          aegisRewardsV2Contract.finalizeRewards(ethers.encodeBytes32String('test'), 0),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'UnknownRewards')
      })
    })
  })

  describe('#withdrawExpiredRewards', () => {
    describe('success', () => {
      it('should withdraw expired rewards', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)
        await aegisRewardsV2Contract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 1)

        await time.increase(2)

        await expect(
          aegisRewardsV2Contract.withdrawExpiredRewards(ethers.encodeBytes32String(snapshotId), owner.address),
        )
          .to.emit(aegisRewardsV2Contract, 'WithdrawExpiredRewards')
          .withArgs(ethers.encodeBytes32String(snapshotId), owner.address, amount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have REWARDS_MANAGER_ROLE role', async () => {
        const [, unknownUser] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract
            .connect(unknownUser)
            .withdrawExpiredRewards(ethers.encodeBytes32String('test'), unknownUser.address),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#configureChain', () => {
    describe('success', () => {
      it('should add a chain for cross-chain distribution', async () => {
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        const bnbChainId = 56
        const bnbRewardsContract = ethers.Wallet.createRandom().address

        await expect(aegisRewardsV2Contract.configureChain(bnbChainId, bnbRewardsContract, true))
          .to.emit(aegisRewardsV2Contract, 'ChainConfigured')
          .withArgs(bnbChainId, bnbRewardsContract, true)

        const supportedChains = await aegisRewardsV2Contract.getSupportedChains()
        expect(supportedChains).to.include(BigInt(bnbChainId))
      })

      it('should remove a chain from cross-chain distribution', async () => {
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        const bnbChainId = 56
        const bnbRewardsContract = ethers.Wallet.createRandom().address

        // Add first
        await aegisRewardsV2Contract.configureChain(bnbChainId, bnbRewardsContract, true)

        // Remove
        await expect(aegisRewardsV2Contract.configureChain(bnbChainId, ethers.ZeroAddress, false))
          .to.emit(aegisRewardsV2Contract, 'ChainConfigured')
          .withArgs(bnbChainId, ethers.ZeroAddress, false)

        const supportedChains = await aegisRewardsV2Contract.getSupportedChains()
        expect(supportedChains).to.not.include(BigInt(bnbChainId))
      })
    })
  })

  describe('#setChainDistribution', () => {
    describe('success', () => {
      it('should set distribution for multiple chains', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DISTRIBUTOR_ROLE, owner.address)

        const snapshotId = ethers.encodeBytes32String('week-2024-01')
        const chainIds = [56, 43114] // BNB and Avalanche
        const rewardsContracts = [
          ethers.Wallet.createRandom().address,
          ethers.Wallet.createRandom().address,
        ]
        const amounts = [ethers.parseEther('1000'), ethers.parseEther('500')]

        await aegisRewardsV2Contract.setChainDistribution(snapshotId, chainIds, rewardsContracts, amounts)

        const bnbDist = await aegisRewardsV2Contract.getChainDistribution(snapshotId, 56)
        expect(bnbDist.chainId).to.equal(56)
        expect(bnbDist.amount).to.equal(amounts[0])
        expect(bnbDist.bridged).to.equal(false)

        const avaDist = await aegisRewardsV2Contract.getChainDistribution(snapshotId, 43114)
        expect(avaDist.chainId).to.equal(43114)
        expect(avaDist.amount).to.equal(amounts[1])
      })
    })

    describe('error', () => {
      it('should revert when not on main chain', async () => {
        const [owner] = await ethers.getSigners()
        const { yusdContract, aegisConfig } = await loadFixture(deployRewardsV2Fixture)

        // Deploy as secondary chain (NOT main chain)
        const secondaryRewardsContract = await ethers.deployContract('AegisRewardsV2', [
          await yusdContract.getAddress(),
          await aegisConfig.getAddress(),
          owner.address,
          false, // isMainChain = false
        ])

        await secondaryRewardsContract.grantRole(DISTRIBUTOR_ROLE, owner.address)

        await expect(
          secondaryRewardsContract.setChainDistribution(
            ethers.encodeBytes32String('test'),
            [56],
            [ethers.Wallet.createRandom().address],
            [ethers.parseEther('1000')],
          ),
        ).to.be.revertedWithCustomError(secondaryRewardsContract, 'NotMainChain')
      })
    })
  })

  describe('#markAsBridged', () => {
    describe('success', () => {
      it('should mark distribution as bridged', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DISTRIBUTOR_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const chainId = 56
        const rewardsContract = ethers.Wallet.createRandom().address
        const amount = ethers.parseEther('1000')

        // Deposit rewards first
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        // Set distribution
        await aegisRewardsV2Contract.setChainDistribution(bytes32SnapshotId, [chainId], [rewardsContract], [amount])

        // Mark as bridged
        await expect(aegisRewardsV2Contract.markAsBridged(bytes32SnapshotId, chainId))
          .to.emit(aegisRewardsV2Contract, 'CrossChainDistribution')
          .withArgs(bytes32SnapshotId, chainId, rewardsContract, amount)

        const dist = await aegisRewardsV2Contract.getChainDistribution(bytes32SnapshotId, chainId)
        expect(dist.bridged).to.equal(true)

        // Reward amount should be reduced
        const reward = await aegisRewardsV2Contract.rewardById(snapshotId)
        expect(reward.amount).to.equal(0)
      })
    })

    describe('error', () => {
      it('should revert when already bridged', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DISTRIBUTOR_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const chainId = 56
        const rewardsContract = ethers.Wallet.createRandom().address
        const amount = ethers.parseEther('1000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)
        await aegisRewardsV2Contract.setChainDistribution(bytes32SnapshotId, [chainId], [rewardsContract], [amount])

        // First bridge succeeds
        await aegisRewardsV2Contract.markAsBridged(bytes32SnapshotId, chainId)

        // Second bridge fails
        await expect(aegisRewardsV2Contract.markAsBridged(bytes32SnapshotId, chainId))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AlreadyBridged')
      })
    })
  })

  describe('#rescueAssets', () => {
    describe('success', () => {
      it('should rescue excess YUSD above reserved amount', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        // Deposit as rewards (becomes reserved)
        const reservedAmount = ethers.parseEther('1000')
        await yusdContract.mint(owner, reservedAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), reservedAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString('test'), reservedAmount)

        // Send extra YUSD directly (not reserved)
        const extraAmount = ethers.parseEther('500')
        await yusdContract.mint(owner, extraAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), extraAmount)

        const balanceBefore = await yusdContract.balanceOf(owner.address)

        await expect(aegisRewardsV2Contract.rescueAssets(yusdContract))
          .to.emit(aegisRewardsV2Contract, 'RescueAssets')
          .withArgs(await yusdContract.getAddress(), owner.address, extraAmount)

        const balanceAfter = await yusdContract.balanceOf(owner.address)
        expect(balanceAfter - balanceBefore).to.equal(extraAmount)
      })
    })

    describe('error', () => {
      it('should revert when no excess YUSD to rescue', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        // Deposit as rewards (all YUSD is reserved)
        const reservedAmount = ethers.parseEther('1000')
        await yusdContract.mint(owner, reservedAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), reservedAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString('test'), reservedAmount)

        await expect(aegisRewardsV2Contract.rescueAssets(yusdContract))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'NoTokensToRescue')
      })

      it('should revert when caller is not admin', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).rescueAssets(yusdContract),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#totalReservedRewards', () => {
    describe('success', () => {
      it('should track reserved rewards correctly', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        // Check initial state
        expect(await aegisRewardsV2Contract.totalReservedRewards()).to.equal(0)

        const amount1 = ethers.parseEther('10')
        const amount2 = ethers.parseEther('20')

        // First deposit
        await yusdContract.mint(owner, amount1)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount1)
        await aegisRewardsV2Contract.depositRewards(encodeString('reward-1'), amount1)

        expect(await aegisRewardsV2Contract.totalReservedRewards()).to.equal(amount1)

        // Second deposit
        await yusdContract.mint(owner, amount2)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount2)
        await aegisRewardsV2Contract.depositRewards(encodeString('reward-2'), amount2)

        expect(await aegisRewardsV2Contract.totalReservedRewards()).to.equal(amount1 + amount2)
      })
    })
  })

  describe('#getDomainSeparator', () => {
    describe('success', () => {
      it('should return correct domain separator', async () => {
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        const domainSeparator = await aegisRewardsV2Contract.getDomainSeparator()
        expect(domainSeparator).to.not.equal(ethers.ZeroHash)
        expect(domainSeparator.length).to.equal(66) // 0x + 32 bytes
      })
    })
  })

  describe('#claimOnChainRewards with expiry', () => {
    describe('error', () => {
      it('should revert when snapshot has expired', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const totalAmount = ethers.parseEther('1000')
        const userAmount = ethers.parseEther('100')

        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), totalAmount)
        await aegisRewardsV2Contract.setUserRewards(bytes32SnapshotId, [user1.address], [userAmount])

        // Finalize with short expiry (1 second)
        await aegisRewardsV2Contract.finalizeRewards(bytes32SnapshotId, 1)

        // Wait for expiry
        await time.increase(2)

        // Try to claim after expiry
        await expect(aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId))
          .to.be.revertedWithCustomError(aegisRewardsV2Contract, 'UnknownRewards')
      })
    })
  })

  describe('#setUserRewards validation', () => {
    describe('success', () => {
      it('should overwrite existing user rewards', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)

        const snapshotId = ethers.encodeBytes32String('week-2024-01')
        const initialAmount = ethers.parseEther('100')
        const updatedAmount = ethers.parseEther('200')

        // Set initial rewards
        await aegisRewardsV2Contract.setUserRewards(snapshotId, [user1.address], [initialAmount])
        let userRewards = await aegisRewardsV2Contract.getUserRewards(snapshotId, user1.address)
        expect(userRewards.amount).to.equal(initialAmount)

        // Overwrite with new amount
        await aegisRewardsV2Contract.setUserRewards(snapshotId, [user1.address], [updatedAmount])
        userRewards = await aegisRewardsV2Contract.getUserRewards(snapshotId, user1.address)
        expect(userRewards.amount).to.equal(updatedAmount)
      })
    })

    describe('error', () => {
      it('should revert when user address is zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)

        const snapshotId = ethers.encodeBytes32String('week-2024-01')

        await expect(
          aegisRewardsV2Contract.setUserRewards(snapshotId, [ethers.ZeroAddress], [ethers.parseEther('100')]),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ZeroAddress')
      })

      it('should revert when snapshot ID is zero', async () => {
        const [owner, user1] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)

        await expect(
          aegisRewardsV2Contract.setUserRewards(ethers.ZeroHash, [user1.address], [ethers.parseEther('100')]),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidSnapshotId')
      })

      it('should revert when arrays are empty', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)

        const snapshotId = ethers.encodeBytes32String('week-2024-01')

        await expect(
          aegisRewardsV2Contract.setUserRewards(snapshotId, [], []),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidAddress')
      })
    })
  })

  describe('#configureChain duplicate handling', () => {
    describe('error', () => {
      it('should revert when adding duplicate chain', async () => {
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        const bnbChainId = 56
        const bnbRewardsContract = ethers.Wallet.createRandom().address

        // Add chain first time
        await aegisRewardsV2Contract.configureChain(bnbChainId, bnbRewardsContract, true)

        // Try to add same chain again
        await expect(
          aegisRewardsV2Contract.configureChain(bnbChainId, bnbRewardsContract, true),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ChainAlreadyConfigured')
      })

      it('should revert when removing non-configured chain', async () => {
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        const bnbChainId = 56

        // Try to remove chain that was never added
        await expect(
          aegisRewardsV2Contract.configureChain(bnbChainId, ethers.ZeroAddress, false),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidChain')
      })
    })
  })

  describe('#availableBalanceForDeposits', () => {
    describe('success', () => {
      it('should return correct available balance', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        // Initially no balance
        expect(await aegisRewardsV2Contract.availableBalanceForDeposits()).to.equal(0)

        const totalAmount = ethers.parseEther('1000')
        const depositedAmount = ethers.parseEther('600')

        // Transfer total to contract
        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)

        // Before deposit, all is available
        expect(await aegisRewardsV2Contract.availableBalanceForDeposits()).to.equal(totalAmount)

        // Deposit some as rewards
        await aegisRewardsV2Contract.depositRewards(encodeString('test'), depositedAmount)

        // After deposit, only non-reserved is available
        expect(await aegisRewardsV2Contract.availableBalanceForDeposits()).to.equal(totalAmount - depositedAmount)
      })
    })
  })

  describe('#admin setters', () => {
    describe('#setAegisMintingAddress', () => {
      it('should set aegis minting address', async () => {
        const [, newMinting] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(aegisRewardsV2Contract.setAegisMintingAddress(newMinting.address))
          .to.emit(aegisRewardsV2Contract, 'SetAegisMintingAddress')
          .withArgs(newMinting.address)

        expect(await aegisRewardsV2Contract.aegisMinting()).to.equal(newMinting.address)
      })

      it('should revert when caller is not admin', async () => {
        const [, user, newMinting] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).setAegisMintingAddress(newMinting.address),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })
    })

    describe('#setAegisIncomeRouterAddress', () => {
      it('should set aegis income router address', async () => {
        const [, newRouter] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(aegisRewardsV2Contract.setAegisIncomeRouterAddress(newRouter.address))
          .to.emit(aegisRewardsV2Contract, 'SetAegisIncomeRouterAddress')
          .withArgs(newRouter.address)

        expect(await aegisRewardsV2Contract.aegisIncomeRouter()).to.equal(newRouter.address)
      })
    })

    describe('#setStakingContract', () => {
      it('should set staking contract address', async () => {
        const [, newStaking] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(aegisRewardsV2Contract.setStakingContract(newStaking.address))
          .to.emit(aegisRewardsV2Contract, 'SetStakingContract')
          .withArgs(newStaking.address)

        expect(await aegisRewardsV2Contract.stakingContract()).to.equal(newStaking.address)
      })
    })
  })

  describe('#multiple users claiming from same snapshot', () => {
    describe('success', () => {
      it('should allow multiple users to claim from same snapshot', async () => {
        const [owner, user1, user2, user3] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        const totalAmount = ethers.parseEther('1000')
        const user1Amount = ethers.parseEther('100')
        const user2Amount = ethers.parseEther('200')
        const user3Amount = ethers.parseEther('300')

        // Deposit rewards
        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), totalAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), totalAmount)

        // Set user rewards
        await aegisRewardsV2Contract.setUserRewards(
          bytes32SnapshotId,
          [user1.address, user2.address, user3.address],
          [user1Amount, user2Amount, user3Amount],
        )

        // Finalize
        await aegisRewardsV2Contract.finalizeRewards(bytes32SnapshotId, 0)

        // All users claim
        const user1BalanceBefore = await yusdContract.balanceOf(user1.address)
        const user2BalanceBefore = await yusdContract.balanceOf(user2.address)
        const user3BalanceBefore = await yusdContract.balanceOf(user3.address)

        await aegisRewardsV2Contract.connect(user1).claimOnChainRewards(bytes32SnapshotId)
        await aegisRewardsV2Contract.connect(user2).claimOnChainRewards(bytes32SnapshotId)
        await aegisRewardsV2Contract.connect(user3).claimOnChainRewards(bytes32SnapshotId)

        expect(await yusdContract.balanceOf(user1.address)).to.equal(user1BalanceBefore + user1Amount)
        expect(await yusdContract.balanceOf(user2.address)).to.equal(user2BalanceBefore + user2Amount)
        expect(await yusdContract.balanceOf(user3.address)).to.equal(user3BalanceBefore + user3Amount)

        // Verify total reserved rewards decreased correctly
        expect(await aegisRewardsV2Contract.totalReservedRewards()).to.equal(
          totalAmount - user1Amount - user2Amount - user3Amount,
        )
      })
    })
  })

  describe('#concurrent deposits to same snapshot', () => {
    describe('success', () => {
      it('should accumulate rewards from multiple deposits', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount1 = ethers.parseEther('100')
        const amount2 = ethers.parseEther('200')
        const amount3 = ethers.parseEther('300')

        // Multiple deposits to same snapshot
        await yusdContract.mint(owner, amount1 + amount2 + amount3)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount1 + amount2 + amount3)

        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount1)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount2)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount3)

        const reward = await aegisRewardsV2Contract.rewardById(snapshotId)
        expect(reward.amount).to.equal(amount1 + amount2 + amount3)

        expect(await aegisRewardsV2Contract.totalReservedRewards()).to.equal(amount1 + amount2 + amount3)
      })
    })
  })

  describe('#edge cases in proportion calculations', () => {
    describe('success', () => {
      it('should handle very small amounts correctly', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const smallAmount = 1n // 1 wei

        await yusdContract.mint(owner, smallAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), smallAmount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), smallAmount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)

        // Update with 50-50 split
        await aegisRewardsV2Contract.updateDailyRewards(
          bytes32SnapshotId,
          ethers.parseEther('1'),
          ethers.parseEther('2'),
        )

        const dailyUpdate = await aegisRewardsV2Contract.getDailyUpdate(bytes32SnapshotId, 0)
        // With 1 wei, stakingShare should be 0 (1 * 1 / 2 = 0)
        expect(dailyUpdate.stakingShare).to.equal(0n)
        expect(dailyUpdate.usersShare).to.equal(smallAmount)
      })

      it('should handle 100% staking allocation', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        await aegisRewardsV2Contract.grantRole(DAILY_UPDATER_ROLE, owner.address)
        await aegisRewardsV2Contract.setAegisMintingAddress(owner.address)

        const snapshotId = 'week-2024-01'
        const amount = ethers.parseEther('1000')

        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
        await aegisRewardsV2Contract.depositRewards(encodeString(snapshotId), amount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)

        // 100% to staking (staking balance equals total)
        await aegisRewardsV2Contract.updateDailyRewards(
          bytes32SnapshotId,
          ethers.parseEther('10000000'),
          ethers.parseEther('10000000'),
        )

        const dailyUpdate = await aegisRewardsV2Contract.getDailyUpdate(bytes32SnapshotId, 0)
        expect(dailyUpdate.stakingShare).to.equal(amount)
        expect(dailyUpdate.usersShare).to.equal(0)
      })
    })
  })
})
