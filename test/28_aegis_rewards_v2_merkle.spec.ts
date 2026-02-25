import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { REWARDS_MANAGER_ROLE, encodeString, buildRewardsTree, getMerkleProof } from '../utils/helpers'

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
    await rewardsContract.grantRole(REWARDS_MANAGER_ROLE, owner.address)
    await rewardsContract.setAegisMintingAddress(owner.address)

    // Fund contract and deposit to a snapshot
    const totalRewards = ethers.parseEther('10000')
    await yusdContract.mint(owner.address, totalRewards)
    await yusdContract.transfer(await rewardsContract.getAddress(), totalRewards)

    const snapshotId = 'week-2024-01'
    await rewardsContract.depositRewards(encodeString(snapshotId), totalRewards)

    const bytes32SnapshotId = ethers.encodeBytes32String(snapshotId)

    return {
      rewardsContract,
      yusdContract,
      owner,
      user1,
      user2,
      user3,
      snapshotId,
      bytes32SnapshotId,
      totalRewards,
    }
  }

  // Helper: deposit, fund merkle pool, set root
  async function setupMerklePool(
    fixture: Awaited<ReturnType<typeof deployFixture>>,
    rewards: Array<[string, bigint]>,
    poolAmount: bigint,
  ) {
    const { rewardsContract, bytes32SnapshotId } = fixture
    const tree = buildRewardsTree(rewards)

    // Move funds from snapshot to Merkle pool
    await rewardsContract.fundMerklePool(bytes32SnapshotId, poolAmount)
    // Set root
    await rewardsContract.setMerkleRoot(tree.root)

    return tree
  }

  // ─── setMerkleRoot ──────────────────────────────────────────────────

  describe('#setMerkleRoot', () => {
    it('should set cumulative Merkle root and emit event', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const tree = buildRewardsTree([
        [user1.address, ethers.parseEther('100')],
        [user2.address, ethers.parseEther('200')],
      ])

      await expect(rewardsContract.setMerkleRoot(tree.root))
        .to.emit(rewardsContract, 'SetMerkleRoot')
        .withArgs(tree.root)

      expect(await rewardsContract.getMerkleRoot()).to.equal(tree.root)
    })

    it('should allow updating the root (new rewards period)', async () => {
      const { rewardsContract, user1, user2 } = await loadFixture(deployFixture)

      const tree1 = buildRewardsTree([[user1.address, ethers.parseEther('100')]])
      await rewardsContract.setMerkleRoot(tree1.root)

      // New period: cumulative amounts grow
      const tree2 = buildRewardsTree([
        [user1.address, ethers.parseEther('250')],
        [user2.address, ethers.parseEther('200')],
      ])
      await rewardsContract.setMerkleRoot(tree2.root)

      expect(await rewardsContract.getMerkleRoot()).to.equal(tree2.root)
    })

    it('should revert when caller is not REWARDS_MANAGER_ROLE', async () => {
      const { rewardsContract, user1 } = await loadFixture(deployFixture)

      const tree = buildRewardsTree([[user1.address, ethers.parseEther('100')]])
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

  // ─── fundMerklePool ─────────────────────────────────────────────────

  describe('#fundMerklePool', () => {
    it('should move funds from snapshot to Merkle pool', async () => {
      const { rewardsContract, bytes32SnapshotId, totalRewards } = await loadFixture(deployFixture)

      const moveAmount = ethers.parseEther('5000')

      await expect(rewardsContract.fundMerklePool(bytes32SnapshotId, moveAmount))
        .to.emit(rewardsContract, 'FundMerklePool')
        .withArgs(bytes32SnapshotId, moveAmount)

      expect(await rewardsContract.getMerklePoolBalance()).to.equal(moveAmount)

      // Total reserved unchanged
      expect(await rewardsContract.totalReservedRewards()).to.equal(totalRewards)
    })

    it('should revert when amount exceeds snapshot balance', async () => {
      const { rewardsContract, bytes32SnapshotId, totalRewards } = await loadFixture(deployFixture)

      await expect(
        rewardsContract.fundMerklePool(bytes32SnapshotId, totalRewards + 1n),
      ).to.be.revertedWithCustomError(rewardsContract, 'InsufficientContractBalance')
    })

    it('should revert with zero amount', async () => {
      const { rewardsContract, bytes32SnapshotId } = await loadFixture(deployFixture)

      await expect(rewardsContract.fundMerklePool(bytes32SnapshotId, 0)).to.be.revertedWithCustomError(
        rewardsContract,
        'ZeroRewards',
      )
    })

    it('should revert when caller is not REWARDS_MANAGER_ROLE', async () => {
      const { rewardsContract, bytes32SnapshotId, user1 } = await loadFixture(deployFixture)

      await expect(
        rewardsContract.connect(user1).fundMerklePool(bytes32SnapshotId, ethers.parseEther('100')),
      ).to.be.reverted
    })
  })

  // ─── claimMerkleRewards ─────────────────────────────────────────────

  describe('#claimMerkleRewards', () => {
    it('should allow user to claim with valid proof', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2 } = fixture

      const user1Amount = ethers.parseEther('100')
      const user2Amount = ethers.parseEther('200')
      const poolAmount = user1Amount + user2Amount

      const tree = await setupMerklePool(fixture, [
        [user1.address, user1Amount],
        [user2.address, user2Amount],
      ], poolAmount)

      const proof = getMerkleProof(tree, user1.address)

      await expect(rewardsContract.connect(user1).claimMerkleRewards(user1Amount, proof))
        .to.emit(rewardsContract, 'ClaimMerkleRewards')
        .withArgs(user1.address, user1Amount)

      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Amount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(user1Amount)
    })

    it('should allow multiple users to claim from same tree', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2 } = fixture

      const user1Amount = ethers.parseEther('100')
      const user2Amount = ethers.parseEther('200')

      const tree = await setupMerklePool(fixture, [
        [user1.address, user1Amount],
        [user2.address, user2Amount],
      ], user1Amount + user2Amount)

      await rewardsContract.connect(user1).claimMerkleRewards(user1Amount, getMerkleProof(tree, user1.address))
      await rewardsContract.connect(user2).claimMerkleRewards(user2Amount, getMerkleProof(tree, user2.address))

      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Amount)
      expect(await yusdContract.balanceOf(user2.address)).to.equal(user2Amount)
    })

    it('should pay only the delta on subsequent claims (cumulative)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, owner, user1 } = fixture

      // Week 1: user1 earns 100
      const week1Amount = ethers.parseEther('100')
      const tree1 = await setupMerklePool(fixture, [
        [user1.address, week1Amount],
      ], week1Amount)

      await rewardsContract.connect(user1).claimMerkleRewards(week1Amount, getMerkleProof(tree1, user1.address))
      expect(await yusdContract.balanceOf(user1.address)).to.equal(week1Amount)

      // Week 2: user1's cumulative total is now 350 (earned 250 more)
      // Fund more into Merkle pool
      const additionalDeposit = ethers.parseEther('5000')
      await yusdContract.mint(owner.address, additionalDeposit)
      await yusdContract.transfer(await rewardsContract.getAddress(), additionalDeposit)
      await rewardsContract.depositRewards(encodeString('week-2024-02'), additionalDeposit)

      const week2SnapshotId = ethers.encodeBytes32String('week-2024-02')
      const week2CumulativeAmount = ethers.parseEther('350')
      await rewardsContract.fundMerklePool(week2SnapshotId, ethers.parseEther('250'))

      const tree2 = buildRewardsTree([[user1.address, week2CumulativeAmount]])
      await rewardsContract.setMerkleRoot(tree2.root)

      // Claim delta: 350 - 100 = 250
      await rewardsContract.connect(user1).claimMerkleRewards(week2CumulativeAmount, getMerkleProof(tree2, user1.address))

      expect(await yusdContract.balanceOf(user1.address)).to.equal(week2CumulativeAmount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(week2CumulativeAmount)
    })

    it('should revert when nothing to claim (already fully claimed)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, amount]], amount)
      const proof = getMerkleProof(tree, user1.address)

      await rewardsContract.connect(user1).claimMerkleRewards(amount, proof)

      // Same root, same amount — nothing new to claim
      await expect(
        rewardsContract.connect(user1).claimMerkleRewards(amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'NothingToClaim')
    })

    it('should revert with wrong amount', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const correctAmount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, correctAmount]], correctAmount)
      const proof = getMerkleProof(tree, user1.address)

      await expect(
        rewardsContract.connect(user1).claimMerkleRewards(ethers.parseEther('999'), proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'InvalidMerkleProof')
    })

    it('should revert when wrong user tries another users proof', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [
        [user1.address, amount],
        [user2.address, ethers.parseEther('200')],
      ], ethers.parseEther('300'))

      const proof1 = getMerkleProof(tree, user1.address)
      await expect(
        rewardsContract.connect(user2).claimMerkleRewards(amount, proof1),
      ).to.be.revertedWithCustomError(rewardsContract, 'InvalidMerkleProof')
    })

    it('should revert when no Merkle root is set', async () => {
      const { rewardsContract, user1 } = await loadFixture(deployFixture)

      await expect(
        rewardsContract.connect(user1).claimMerkleRewards(ethers.parseEther('100'), []),
      ).to.be.revertedWithCustomError(rewardsContract, 'MerkleRootNotSet')
    })
  })

  // ─── rescueMerkleRewards ────────────────────────────────────────────

  describe('#rescueMerkleRewards', () => {
    it('should allow admin to rescue with valid proof', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, yusdContract, user1, user2 } = fixture

      const user1Amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [
        [user1.address, user1Amount],
        [user2.address, ethers.parseEther('200')],
      ], ethers.parseEther('300'))

      const proof = getMerkleProof(tree, user1.address)

      await expect(rewardsContract.rescueMerkleRewards(user1.address, user2.address, user1Amount, proof))
        .to.emit(rewardsContract, 'RescueMerkleRewards')
        .withArgs(user1.address, user2.address, user1Amount)

      expect(await yusdContract.balanceOf(user2.address)).to.equal(user1Amount)
      expect(await rewardsContract.getCumulativeClaimed(user1.address)).to.equal(user1Amount)
    })

    it('should revert when caller is not admin', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, amount]], amount)
      const proof = getMerkleProof(tree, user1.address)

      await expect(
        rewardsContract.connect(user1).rescueMerkleRewards(user1.address, user2.address, amount, proof),
      ).to.be.reverted
    })

    it('should revert when nothing to rescue (already claimed)', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1, user2 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [
        [user1.address, amount],
        [user2.address, ethers.parseEther('200')],
      ], ethers.parseEther('300'))

      const proof = getMerkleProof(tree, user1.address)
      await rewardsContract.connect(user1).claimMerkleRewards(amount, proof)

      await expect(
        rewardsContract.rescueMerkleRewards(user1.address, user2.address, amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'NothingToClaim')
    })

    it('should revert with zero destination address', async () => {
      const fixture = await loadFixture(deployFixture)
      const { rewardsContract, user1 } = fixture

      const amount = ethers.parseEther('100')
      const tree = await setupMerklePool(fixture, [[user1.address, amount]], amount)
      const proof = getMerkleProof(tree, user1.address)

      await expect(
        rewardsContract.rescueMerkleRewards(user1.address, ethers.ZeroAddress, amount, proof),
      ).to.be.revertedWithCustomError(rewardsContract, 'ZeroAddress')
    })
  })

  // ─── Coexistence with old paths ─────────────────────────────────────

  describe('coexistence', () => {
    it('old on-chain path and cumulative Merkle path work side by side', async () => {
      const { rewardsContract, yusdContract, owner, user1, user2, bytes32SnapshotId } =
        await loadFixture(deployFixture)

      // --- Old path: setUserRewards + claimOnChainRewards ---
      await rewardsContract.setUserRewards(bytes32SnapshotId, [user1.address], [ethers.parseEther('50')])
      await rewardsContract.finalizeRewards(bytes32SnapshotId, 0)
      await rewardsContract.connect(user1).claimOnChainRewards(bytes32SnapshotId)
      expect(await yusdContract.balanceOf(user1.address)).to.equal(ethers.parseEther('50'))

      // --- Cumulative Merkle path ---
      // Deposit fresh funds for a new snapshot
      const newAmount = ethers.parseEther('1000')
      await yusdContract.mint(owner.address, newAmount)
      await yusdContract.transfer(await rewardsContract.getAddress(), newAmount)
      await rewardsContract.depositRewards(encodeString('week-2024-02'), newAmount)

      const newSnapshotId = ethers.encodeBytes32String('week-2024-02')
      const user2Amount = ethers.parseEther('75')

      await rewardsContract.fundMerklePool(newSnapshotId, user2Amount)

      const tree = buildRewardsTree([[user2.address, user2Amount]])
      await rewardsContract.setMerkleRoot(tree.root)

      await rewardsContract.connect(user2).claimMerkleRewards(user2Amount, getMerkleProof(tree, user2.address))
      expect(await yusdContract.balanceOf(user2.address)).to.equal(user2Amount)
    })
  })

  // ─── Gas comparison ─────────────────────────────────────────────────

  describe('gas comparison', () => {
    it('setMerkleRoot + fundMerklePool vs setUserRewards', async () => {
      const { rewardsContract, bytes32SnapshotId, user1, user2, user3 } = await loadFixture(deployFixture)

      const tree = buildRewardsTree([
        [user1.address, ethers.parseEther('100')],
        [user2.address, ethers.parseEther('200')],
        [user3.address, ethers.parseEther('300')],
      ])

      // Measure Merkle path gas (fundMerklePool + setMerkleRoot)
      const fundTx = await rewardsContract.fundMerklePool(bytes32SnapshotId, ethers.parseEther('600'))
      const fundReceipt = await fundTx.wait()

      const rootTx = await rewardsContract.setMerkleRoot(tree.root)
      const rootReceipt = await rootTx.wait()

      const merkleGas = fundReceipt!.gasUsed + rootReceipt!.gasUsed

      // Measure setUserRewards gas (different snapshot)
      const otherSnapshotId = ethers.encodeBytes32String('week-other')
      const userRewardsTx = await rewardsContract.setUserRewards(
        otherSnapshotId,
        [user1.address, user2.address, user3.address],
        [ethers.parseEther('100'), ethers.parseEther('200'), ethers.parseEther('300')],
      )
      const userRewardsReceipt = await userRewardsTx.wait()
      const userRewardsGas = userRewardsReceipt!.gasUsed

      console.log(`\n  Cumulative Merkle (fundMerklePool + setMerkleRoot): ${merkleGas.toLocaleString()} gas`)
      console.log(`  setUserRewards (3 users):                           ${userRewardsGas.toLocaleString()} gas`)
      console.log(`  Savings:                                            ${((1 - Number(merkleGas) / Number(userRewardsGas)) * 100).toFixed(1)}%`)
      console.log(`  setUserRewards extrapolated to 10K users:           ~${((Number(userRewardsGas) / 3) * 10000).toLocaleString()} gas`)
      console.log(`  Cumulative Merkle for 10K users:                    ${merkleGas.toLocaleString()} gas (same)\n`)

      expect(merkleGas).to.be.lessThan(userRewardsGas)
    })
  })
})
