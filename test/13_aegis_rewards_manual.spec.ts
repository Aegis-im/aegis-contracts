import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { REWARDS_MANAGER_ROLE, deployFixture, signClaimRequestManual, signClaimRequestManualByWallet } from './helpers'

describe('AegisRewardsManual', () => {
  describe('#depositRewards', () => {
    describe('success', () => {
      it('should add rewards to a total amount', async function () {
        this.timeout(240000) // 4 minutes
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('1')

        // Transfer tokens to contract first
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)

        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        const reward = await aegisRewardsManualContract.rewardById(snapshotId)
        expect(reward.amount).to.equal(amount)
      })
    })

    describe('error', () => {
      it('should revert when caller is not REWARDS_MANAGER_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        await expect(aegisRewardsManualContract.connect(user).depositRewards('test', ethers.parseEther('1'))).to.be
          .reverted
      })
    })
  })

  describe('#claimRewards', () => {
    describe('success', () => {
      it('should claim rewards to account', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')
        // Transfer YUSD to contract and deposit rewards
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 0)

        const snapshot2Id = 'test2'
        const amount2 = ethers.parseEther('2')
        await yusdContract.mint(owner, amount2)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount2)
        await aegisRewardsManualContract.depositRewards(snapshot2Id, amount2)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshot2Id), 0)

        const contractAddress = await aegisRewardsManualContract.getAddress()
        const contractYUSDBalanceBefore = await yusdContract.balanceOf(contractAddress)
        const userYUSDBalanceBefore = await yusdContract.balanceOf(owner.address)

        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId), ethers.encodeBytes32String(snapshot2Id)],
          amounts: [amount, amount2],
        }
        const signature = await signClaimRequestManual(claimRequest, contractAddress)

        await aegisRewardsManualContract.claimRewards(claimRequest, signature)

        expect(await yusdContract.balanceOf(contractAddress)).to.equal(contractYUSDBalanceBefore - amount - amount2)
        expect(await yusdContract.balanceOf(owner.address)).to.equal(userYUSDBalanceBefore + amount + amount2)

        const reward = await aegisRewardsManualContract.rewardById(snapshotId)
        expect(reward.amount).to.equal(0)
      })
    })

    describe('error', () => {
      it('should revert when deposit for snapshot id does not exist', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        const amount = ethers.parseEther('1')
        const snapshotId = 'test'
        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount],
        }
        const contractAddress = await aegisRewardsManualContract.getAddress()
        const signature = await signClaimRequestManual(claimRequest, contractAddress)

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.revertedWithCustomError(
          aegisRewardsManualContract,
          'ZeroRewards',
        )
      })

      it('should revert when caller is not a claimer', async () => {
        const [owner, sender] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('1')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount],
        }
        const contractAddress = await aegisRewardsManualContract.getAddress()
        const signature = await signClaimRequestManual(claimRequest, contractAddress)

        await expect(
          aegisRewardsManualContract.connect(sender).claimRewards(claimRequest, signature),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'InvalidClaimer')
      })

      it('should revert when signed by unknown account', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('1')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        const unknownSigner = await ethers.Wallet.createRandom()
        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount],
        }
        const contractAddress = await aegisRewardsManualContract.getAddress()
        const signature = await signClaimRequestManualByWallet(claimRequest, contractAddress, unknownSigner)

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.revertedWithCustomError(
          aegisRewardsManualContract,
          'InvalidSignature',
        )
      })

      it('should revert when length of ids and amounts does not match', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('1')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId), ethers.encodeBytes32String('test2')],
          amounts: [amount],
        }
        const contractAddress = await aegisRewardsManualContract.getAddress()
        const signature = await signClaimRequestManual(claimRequest, contractAddress)

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.revertedWithCustomError(
          aegisRewardsManualContract,
          'InvalidParams',
        )
      })

      it('should revert when snapshot rewards are zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('1')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 0)

        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount],
        }
        const contractAddress = await aegisRewardsManualContract.getAddress()
        const signature = await signClaimRequestManual(claimRequest, contractAddress)

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.not.reverted

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.revertedWithCustomError(
          aegisRewardsManualContract,
          'ZeroRewards',
        )
      })

      it('should revert when rewards were already claimed by an address', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 0)

        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String(snapshotId)],
          amounts: [amount / 2n],
        }
        const contractAddress = await aegisRewardsManualContract.getAddress()
        const signature = await signClaimRequestManual(claimRequest, contractAddress)

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.not.reverted

        await expect(aegisRewardsManualContract.claimRewards(claimRequest, signature)).to.be.revertedWithCustomError(
          aegisRewardsManualContract,
          'ZeroRewards',
        )
      })
    })
  })
  describe('#finalizeRewards', () => {
    describe('success', () => {
      it('should finalize rewards with id', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = ethers.encodeBytes32String('test')
        const claimDuration = 10
        const timestamp = await time.latest()
        await expect(aegisRewardsManualContract.finalizeRewards(snapshotId, claimDuration))
          .to.emit(aegisRewardsManualContract, 'FinalizeRewards')
          .withArgs(snapshotId, timestamp + 1 + claimDuration)

        const reward = await aegisRewardsManualContract.rewardById('test')
        expect(reward.finalized).to.be.equal(true)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have REWARDS_MANAGER_ROLE role', async () => {
        const [, unknownUser] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        await expect(
          aegisRewardsManualContract.connect(unknownUser).finalizeRewards(ethers.encodeBytes32String('test'), 0),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when already finalized', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        await expect(aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String('test'), 0)).not.to.be
          .reverted

        await expect(
          aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String('test'), 0),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'UnknownRewards')
      })
    })
  })

  describe('#withdrawExpiredRewards', () => {
    describe('success', () => {
      it('should withdraw expired rewards', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 1)

        await time.increase(2)

        await expect(
          aegisRewardsManualContract.withdrawExpiredRewards(ethers.encodeBytes32String(snapshotId), owner.address),
        )
          .to.emit(aegisRewardsManualContract, 'WithdrawExpiredRewards')
          .withArgs(ethers.encodeBytes32String(snapshotId), owner.address, amount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have REWARDS_MANAGER_ROLE role', async () => {
        const [, unknownUser] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        await expect(
          aegisRewardsManualContract
            .connect(unknownUser)
            .withdrawExpiredRewards(ethers.encodeBytes32String('test'), unknownUser.address),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when reward is not finalized', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        await expect(
          aegisRewardsManualContract.withdrawExpiredRewards(ethers.encodeBytes32String('test'), owner.address),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'UnknownRewards')
      })

      it('should revert when amount equals to zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 1)

        await time.increase(2)

        await expect(
          aegisRewardsManualContract.withdrawExpiredRewards(ethers.encodeBytes32String(snapshotId), owner.address),
        ).not.to.be.reverted

        await expect(
          aegisRewardsManualContract.withdrawExpiredRewards(ethers.encodeBytes32String(snapshotId), owner.address),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'UnknownRewards')
      })

      it('should revert when expiry equals to zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        await expect(aegisRewardsManualContract.finalizeRewards(bytes32SnapshotId, 0)).not.to.be.reverted

        await expect(
          aegisRewardsManualContract.withdrawExpiredRewards(bytes32SnapshotId, owner.address),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'UnknownRewards')
      })

      it('should revert when not expired', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test'
        const amount = ethers.parseEther('2')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)
        await expect(aegisRewardsManualContract.finalizeRewards(bytes32SnapshotId, 100)).not.to.be.reverted

        await expect(
          aegisRewardsManualContract.withdrawExpiredRewards(bytes32SnapshotId, owner.address),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'UnknownRewards')
      })
    })
  })
  describe('#rewardById', () => {
    describe('success', () => {
      it('should return reward information', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const snapshotId = 'test-reward'
        const amount = ethers.parseEther('5')

        // Check initial state
        let reward = await aegisRewardsManualContract.rewardById(snapshotId)
        expect(reward.amount).to.equal(0)
        expect(reward.expiry).to.equal(0)
        expect(reward.finalized).to.equal(false)

        // Deposit rewards
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards(snapshotId, amount)

        // Check after deposit
        reward = await aegisRewardsManualContract.rewardById(snapshotId)
        expect(reward.amount).to.equal(amount)
        expect(reward.expiry).to.equal(0)
        expect(reward.finalized).to.equal(false)

        // Finalize rewards
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String(snapshotId), 86400)

        // Check after finalization
        reward = await aegisRewardsManualContract.rewardById(snapshotId)
        expect(reward.amount).to.equal(amount)
        expect(reward.expiry).to.be.greaterThan(0)
        expect(reward.finalized).to.equal(true)
      })

      it('should return zero reward for non-existent id', async () => {
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        const reward = await aegisRewardsManualContract.rewardById('non-existent')
        expect(reward.amount).to.equal(0)
        expect(reward.expiry).to.equal(0)
        expect(reward.finalized).to.equal(false)
      })
    })
  })

  describe('#totalReservedRewards', () => {
    describe('success', () => {
      it('should track reserved rewards correctly', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        // Check initial state
        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(0)

        const amount1 = ethers.parseEther('10')
        const amount2 = ethers.parseEther('20')

        // First deposit
        await yusdContract.mint(owner, amount1)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount1)
        await aegisRewardsManualContract.depositRewards('reward-1', amount1)

        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(amount1)

        // Second deposit
        await yusdContract.mint(owner, amount2)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount2)
        await aegisRewardsManualContract.depositRewards('reward-2', amount2)

        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(amount1 + amount2)
      })

      it('should decrease reserved rewards after claim', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const amount = ethers.parseEther('15')

        // Setup reward
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards('reward-claim', amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String('reward-claim'), 0)

        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(amount)

        // Claim reward
        const claimRequest = {
          claimer: owner.address,
          ids: [ethers.encodeBytes32String('reward-claim')],
          amounts: [amount],
        }
        const signature = await signClaimRequestManual(claimRequest, await aegisRewardsManualContract.getAddress())
        await aegisRewardsManualContract.claimRewards(claimRequest, signature)

        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(0)
      })

      it('should decrease reserved rewards after withdraw expired', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const amount = ethers.parseEther('25')

        // Setup expired reward
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsManualContract.getAddress(), amount)
        await aegisRewardsManualContract.depositRewards('reward-expired', amount)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String('reward-expired'), 1)

        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(amount)

        // Wait for expiry
        await time.increase(2)

        // Withdraw expired
        await aegisRewardsManualContract.withdrawExpiredRewards(
          ethers.encodeBytes32String('reward-expired'),
          owner.address,
        )

        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(0)
      })
    })
  })

  describe('#availableBalanceForDeposits', () => {
    describe('success', () => {
      it('should calculate available balance correctly', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const contractAddress = await aegisRewardsManualContract.getAddress()
        const depositAmount = ethers.parseEther('30')

        // Check initial state
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(0)

        // Transfer tokens to contract
        await yusdContract.mint(owner, depositAmount)
        await yusdContract.transfer(contractAddress, depositAmount)

        // Check after transfer
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(depositAmount)

        // Deposit some rewards
        const rewardAmount = ethers.parseEther('10')
        await aegisRewardsManualContract.depositRewards('reward-balance', rewardAmount)

        // Check after deposit
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(depositAmount - rewardAmount)
      })

      it('should prevent double spending', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const contractAddress = await aegisRewardsManualContract.getAddress()
        const totalAmount = ethers.parseEther('100')
        const firstDeposit = ethers.parseEther('60')
        const secondDeposit = ethers.parseEther('50') // This should fail

        // Transfer tokens to contract
        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(contractAddress, totalAmount)

        // First deposit should succeed
        await aegisRewardsManualContract.depositRewards('reward-1', firstDeposit)
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(totalAmount - firstDeposit)

        // Second deposit should fail due to insufficient available balance
        await expect(
          aegisRewardsManualContract.depositRewards('reward-2', secondDeposit),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'InsufficientContractBalance')

        // Available balance should remain unchanged
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(totalAmount - firstDeposit)
      })
    })
  })

  describe('#setAegisConfigAddress', () => {
    describe('error', () => {
      it('should revert when caller is not admin', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        const mockConfigAddress = '0x1234567890123456789012345678901234567890'

        await expect(
          aegisRewardsManualContract.connect(user).setAegisConfigAddress(mockConfigAddress),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#getDomainSeparator', () => {
    describe('success', () => {
      it('should return correct domain separator', async () => {
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        const domainSeparator = await aegisRewardsManualContract.getDomainSeparator()
        expect(domainSeparator).to.not.equal(ethers.ZeroHash)
        expect(domainSeparator.length).to.equal(66) // 0x + 32 bytes
      })

      it('should return cached domain separator for same chain', async () => {
        const { aegisRewardsManualContract } = await loadFixture(deployFixture)

        const domain1 = await aegisRewardsManualContract.getDomainSeparator()
        const domain2 = await aegisRewardsManualContract.getDomainSeparator()

        expect(domain1).to.equal(domain2)
      })
    })
  })

  // ===== DOUBLE SPENDING PREVENTION TESTS =====

  describe('#doubleSpendingPrevention', () => {
    describe('success', () => {
      it('should prevent double spending with exact balance', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const contractAddress = await aegisRewardsManualContract.getAddress()
        const depositAmount = ethers.parseEther('100')

        // Transfer exact amount
        await yusdContract.mint(owner, depositAmount)
        await yusdContract.transfer(contractAddress, depositAmount)

        // First deposit should succeed
        await aegisRewardsManualContract.depositRewards('reward-exact', depositAmount)
        expect(await aegisRewardsManualContract.totalReservedRewards()).to.equal(depositAmount)
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(0)

        // Second deposit should fail
        await expect(
          aegisRewardsManualContract.depositRewards('reward-double', depositAmount),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'InsufficientContractBalance')
      })

      it('should allow partial deposits within available balance', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const contractAddress = await aegisRewardsManualContract.getAddress()
        const totalAmount = ethers.parseEther('100')
        const firstDeposit = ethers.parseEther('40')
        const secondDeposit = ethers.parseEther('30')
        const thirdDeposit = ethers.parseEther('30')

        // Transfer tokens
        await yusdContract.mint(owner, totalAmount)
        await yusdContract.transfer(contractAddress, totalAmount)

        // First deposit
        await aegisRewardsManualContract.depositRewards('reward-1', firstDeposit)
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(totalAmount - firstDeposit)

        // Second deposit
        await aegisRewardsManualContract.depositRewards('reward-2', secondDeposit)
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(
          totalAmount - firstDeposit - secondDeposit,
        )

        // Third deposit
        await aegisRewardsManualContract.depositRewards('reward-3', thirdDeposit)
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(0)

        // Fourth deposit should fail
        await expect(
          aegisRewardsManualContract.depositRewards('reward-4', ethers.parseEther('1')),
        ).to.be.revertedWithCustomError(aegisRewardsManualContract, 'InsufficientContractBalance')
      })

      it('should handle complex scenario with claims and new deposits', async () => {
        const [owner, user] = await ethers.getSigners()
        const { aegisRewardsManualContract, yusdContract } = await loadFixture(deployFixture)

        await yusdContract.setMinter(owner.address)
        await aegisRewardsManualContract.grantRole(REWARDS_MANAGER_ROLE, owner)

        const contractAddress = await aegisRewardsManualContract.getAddress()
        const initialAmount = ethers.parseEther('200')
        const firstReward = ethers.parseEther('80')
        const secondReward = ethers.parseEther('60')

        // Setup initial balance
        await yusdContract.mint(owner, initialAmount)
        await yusdContract.transfer(contractAddress, initialAmount)

        // Create two rewards
        await aegisRewardsManualContract.depositRewards('reward-1', firstReward)
        await aegisRewardsManualContract.depositRewards('reward-2', secondReward)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String('reward-1'), 0)
        await aegisRewardsManualContract.finalizeRewards(ethers.encodeBytes32String('reward-2'), 0)

        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(
          initialAmount - firstReward - secondReward,
        )

        // User claims first reward
        const claimRequest = {
          claimer: user.address,
          ids: [ethers.encodeBytes32String('reward-1')],
          amounts: [firstReward],
        }
        const signature = await signClaimRequestManual(claimRequest, contractAddress)
        await aegisRewardsManualContract.connect(user).claimRewards(claimRequest, signature)

        // After claim, tokens are transferred to user (80 YUSD), but reward-2 still reserves 60 YUSD
        // Contract balance: 200 - 80 = 120 YUSD, Reserved: 60 YUSD, Available: 60 YUSD
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(ethers.parseEther('60'))

        // Should be able to create new reward with available balance
        const newReward = ethers.parseEther('50')
        await aegisRewardsManualContract.depositRewards('reward-3', newReward)
        expect(await aegisRewardsManualContract.availableBalanceForDeposits()).to.equal(ethers.parseEther('10'))
      })
    })
  })
})
