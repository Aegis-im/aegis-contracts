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
        // Note: AegisRewardsManual does not require tokens to be pre-transferred
        // The depositRewards function only tracks rewards, tokens are handled separately

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
})
