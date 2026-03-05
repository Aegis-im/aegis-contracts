import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  DEPOSITOR_ROLE,
  TRUSTED_SIGNER_ROLE,
  encodeString,
  buildRewardsTree,
  getMerkleProof,
} from '../utils/helpers'

describe('AegisRewardsV2 — Cumulative Merkle Rewards', function () {
  this.timeout(240_000)

  async function deployFixture() {
    const [owner, user1, user2, user3] = await ethers.getSigners()

    const yusdContract = await ethers.deployContract('YUSD', [owner.address])
    const yusdAddress = await yusdContract.getAddress()

    const rewardsContract = await ethers.deployContract('AegisRewardsV2', [
      yusdAddress,
      owner.address,
      true,
    ])

    await yusdContract.setMinter(owner.address)
    await rewardsContract.grantRole(DEPOSITOR_ROLE, owner.address)
    await rewardsContract.grantRole(TRUSTED_SIGNER_ROLE, owner.address)

    // Fund contract and deposit to merkle pool
    const totalRewards = ethers.parseEther('10000')
    await yusdContract.mint(owner.address, totalRewards)
    await yusdContract.transfer(await rewardsContract.getAddress(), totalRewards)
    await rewardsContract.depositRewards(encodeString('deposit-1'), totalRewards)

    return {
      rewardsContract,
      yusdContract,
      owner,
      user1,
      user2,
      user3,
      totalRewards,
    }
  }

  // Helper: build tree, set root
  async function setupMerklePool(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    rewards: Array<[string, string, bigint]>,
  ) {
    const { rewardsContract } = fixture
    const tree = buildRewardsTree(rewards)
    await rewardsContract.setMerkleRoot(tree.root)
    return tree
  }

  // ─── setMerkleRoot ──────────────────────────────────────────────────

  describe('#setMerkleRoot', () => {
    it('should set cumulative Merkle root and emit event', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const tree = buildRewardsTree([
        [user1.address, user1.address, ethers.parseEther('100')],
      ])

      await expect(rewardsContract.setMerkleRoot(tree.root))
        .to.emit(rewardsContract, 'SetMerkleRoot')
        .withArgs(tree.root)

      expect(await rewardsContract.getMerkleRoot()).to.equal(tree.root)
    })

    it('should allow updating the root (new rewards period)', async () => {
      const { rewardsContract, user1, user2 } = await loadFixture(deployFixture)

      const tree1 = buildRewardsTree([[user1.address, user1.address, ethers.parseEther('100')]])
      await rewardsContract.setMerkleRoot(tree1.root)

      const tree2 = buildRewardsTree([
        [user1.address, user1.address, ethers.parseEther('250')],
        [user2.address, user2.address, ethers.parseEther('200')],
      ])
      await rewardsContract.setMerkleRoot(tree2.root)

      expect(await rewardsContract.getMerkleRoot()).to.equal(tree2.root)
    })

    it('should revert when caller is not TRUSTED_SIGNER_ROLE', async () => {
      const { rewardsContract, user1 } = await loadFixture(deployFixture)

      const tree = buildRewardsTree([[user1.address, user1.address, ethers.parseEther('100')]])
      await expect(rewardsContract.connect(user1).setMerkleRoot(tree.root)).to.be.reverted
    })

    it('should revert with zero merkleRoot', async () => {
      const { rewardsContract } = await loadFixture(deployFixture)

      await expect(rewardsContract.setMerkleRoot(ethers.ZeroHash)).to.be.revertedWithCustomError(
        rewardsContract,
        'ZeroRewards',
      )
    })
  })

  // ─── claimMerkleRewards ─────────────────────────────────────────────

  describe('#claimMerkleRewards', () => {
    it('should allow claimer to claim with valid proof (self-claiming)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1 } = fixture

      const user1Amount = ethers.parseEther('100')

      const tree = await setupMerklePool(fixture, [
        [user1.address, user1.address, user1Amount],
      ])

      const proof = getMerkleProof(tree, user1.address, user1.address)

      await expect(rewardsContract.connect(user1).claimMerkleRewards(user1.address, user1Amount, proof))
        .to.emit(rewardsContract, 'ClaimMerkleRewards')
        .withArgs(user1.address, user1.address, user1Amount)

      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Amount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(user1Amount)
    })

    it('should allow separate claimer to claim for account', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2 } = fixture

      // user1 is the account, user2 is the claimer
      const amount = ethers.parseEther('100')

      const tree = await setupMerklePool(fixture, [
        [user1.address, user2.address, amount],
      ])

      const proof = getMerkleProof(tree, user1.address, user2.address)

      // user2 (claimer) calls the function
      await expect(rewardsContract.connect(user2).claimMerkleRewards(user1.address, amount, proof))
        .to.emit(rewardsContract, 'ClaimMerkleRewards')
        .withArgs(user1.address, user2.address, amount)

      // Funds go to claimer (user2)
      expect(await yusdContract.balanceOf(user2.address)).to.equal(amount)
      // Cumulative claimed keyed by account (user1)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(amount)
    })

    it('should allow multiple users to claim from same tree', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2 } = fixture

      const user1Amount = ethers.parseEther('100')
      const user2Amount = ethers.parseEther('200')

      const tree = await setupMerklePool(fixture, [
        [user1.address, user1.address, user1Amount],
        [user2.address, user2.address, user2Amount],
      ])

      await rewardsContract.connect(user1).claimMerkleRewards(user1.address, user1Amount, getMerkleProof(tree, user1.address, user1.address))
      await rewardsContract.connect(user2).claimMerkleRewards(user2.address, user2Amount, getMerkleProof(tree, user2.address, user2.address))

      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Amount)
      expect(await yusdContract.balanceOf(user2.address)).to.equal(user2Amount)
    })

    it('should pay only the delta on subsequent claims (cumulative)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, owner, user1 } = fixture

      // Week 1: user1 earns 100
      const week1Amount = ethers.parseEther('100')
      const tree1 = await setupMerklePool(fixture, [
        [user1.address, user1.address, week1Amount],
      ])

      await rewardsContract.connect(user1).claimMerkleRewards(user1.address, week1Amount, getMerkleProof(tree1, user1.address, user1.address))
      expect(await yusdContract.balanceOf(user1.address)).to.equal(week1Amount)

      // Week 2: user1's cumulative total is now 350 (earned 250 more)
      const additionalDeposit = ethers.parseEther('5000')
      await yusdContract.mint(owner.address, additionalDeposit)
      await yusdContract.transfer(await rewardsContract.getAddress(), additionalDeposit)
      await rewardsContract.depositRewards(encodeString('deposit-2'), additionalDeposit)

      const week2CumulativeAmount = ethers.parseEther('350')
      const tree2 = buildRewardsTree([[user1.address, user1.address, week2CumulativeAmount]])
      await rewardsContract.setMerkleRoot(tree2.root)

      // Claim delta: 350 - 100 = 250
      await rewardsContract.connect(user1).claimMerkleRewards(user1.address, week2CumulativeAmount, getMerkleProof(tree2, user1.address, user1.address))

      expect(await yusdContract.balanceOf(user1.address)).to.equal(week2CumulativeAmount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(week2CumulativeAmount)
    })

    it('should reject old claimer after claimer change', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2, user3 } = fixture

      // Initially user2 is the claimer for user1's account
      const amount = ethers.parseEther('100')
      const tree1 = await setupMerklePool(fixture, [
        [user1.address, user2.address, amount],
      ])

      // Now change claimer to user3 via new root
      const newAmount = ethers.parseEther('200')
      const tree2 = buildRewardsTree([[user1.address, user3.address, newAmount]])
      await rewardsContract.setMerkleRoot(tree2.root)

      // Old claimer (user2) should be rejected
      const oldProof = getMerkleProof(tree1, user1.address, user2.address)
      await expect(
        rewardsContract.connect(user2).claimMerkleRewards(user1.address, amount, oldProof),
      ).to.be.revertedWithCustomError(rewardsContract, 'InvalidMerkleProof')

      // New claimer (user3) should succeed
      const newProof = getMerkleProof(tree2, user1.address, user3.address)
      await rewardsContract.connect(user3).claimMerkleRewards(user1.address, newAmount, newProof)

      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(newAmount)
    })

    it('should revert when nothing to claim (already fully claimed)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, user1.address, amount]])
      const proof = getMerkleProof(tree, user1.address, user1.address)

      await rewardsContract.connect(user1).claimMerkleRewards(user1.address, amount, proof)

      await expect(
        rewardsContract.connect(user1).claimMerkleRewards(user1.address, amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'NothingToClaim')
    })

    it('should revert with wrong amount', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const correctAmount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, user1.address, correctAmount]])
      const proof = getMerkleProof(tree, user1.address, user1.address)

      await expect(
        rewardsContract.connect(user1).claimMerkleRewards(user1.address, ethers.parseEther('999'), proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'InvalidMerkleProof')
    })

    it('should revert when wrong claimer tries to claim', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const amount = ethers.parseEther('100')
      // user1 is both account and claimer
      const tree = await setupMerklePool(fixture, [
        [user1.address, user1.address, amount],
      ])

      const proof = getMerkleProof(tree, user1.address, user1.address)
      // user2 tries to use user1's proof (wrong msg.sender)
      await expect(
        rewardsContract.connect(user2).claimMerkleRewards(user1.address, amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'InvalidMerkleProof')
    })

    it('should revert when no Merkle root is set', async () => {
      const { rewardsContract, user1 } = await loadFixture(deployFixture)

      await expect(
        rewardsContract.connect(user1).claimMerkleRewards(user1.address, ethers.parseEther('100'), []),
      ).to.be.revertedWithCustomError(rewardsContract, 'MerkleRootNotSet')
    })
  })

  // ─── rescueMerkleRewards ────────────────────────────────────────────

  describe('#rescueMerkleRewards', () => {
    it('should allow admin to rescue with valid proof (self-claim leaf)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2 } = fixture

      const user1Amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [
        [user1.address, user1.address, user1Amount],
      ])

      const proof = getMerkleProof(tree, user1.address, user1.address)

      await expect(rewardsContract.rescueMerkleRewards(user1.address, user1.address, user2.address, user1Amount, proof))
        .to.emit(rewardsContract, 'RescueMerkleRewards')
        .withArgs(user1.address, user2.address, user1Amount)

      expect(await yusdContract.balanceOf(user2.address)).to.equal(user1Amount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(user1Amount)
    })

    it('should allow admin to rescue with separate claimer leaf', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2, user3 } = fixture

      const amount = ethers.parseEther('100')
      // Leaf has user1 as account, user2 as claimer
      const tree = await setupMerklePool(fixture, [
        [user1.address, user2.address, amount],
      ])

      const proof = getMerkleProof(tree, user1.address, user2.address)

      // Admin rescues to user3
      await rewardsContract.rescueMerkleRewards(user1.address, user2.address, user3.address, amount, proof)

      expect(await yusdContract.balanceOf(user3.address)).to.equal(amount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(amount)
    })

    it('should revert when caller is not admin', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, user1.address, amount]])
      const proof = getMerkleProof(tree, user1.address, user1.address)

      await expect(
        rewardsContract.connect(user1).rescueMerkleRewards(user1.address, user1.address, user2.address, amount, proof),
      ).to.be.reverted
    })

    it('should revert when nothing to rescue (already claimed)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [
        [user1.address, user1.address, amount],
      ])

      const proof = getMerkleProof(tree, user1.address, user1.address)
      await rewardsContract.connect(user1).claimMerkleRewards(user1.address, amount, proof)

      await expect(
        rewardsContract.rescueMerkleRewards(user1.address, user1.address, user2.address, amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'NothingToClaim')
    })

    it('should revert with zero destination address', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, user1.address, amount]])
      const proof = getMerkleProof(tree, user1.address, user1.address)

      await expect(
        rewardsContract.rescueMerkleRewards(user1.address, user1.address, ethers.ZeroAddress, amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'ZeroAddress')
    })
  })
})
