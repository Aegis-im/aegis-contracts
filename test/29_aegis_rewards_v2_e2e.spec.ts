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

/**
 * E2E test simulating a full multichain rewards lifecycle:
 *   1. Deposit rewards from multiple sources
 *   2. Set merkle root with account/claimer pairs
 *   3. Bridge to destination chains
 *   4. Perform daily operations (root update + bridge atomically)
 *   5. Users claim across root updates (delta claiming)
 *   6. Claimer rotation
 *   7. Rescue flows
 *   8. Verify invariants throughout
 */
describe('AegisRewardsV2 — E2E Multichain & Daily Operations', function () {
  this.timeout(240_000)

  // Chain IDs and LayerZero endpoint IDs for simulated chains
  const ARBITRUM = { chainId: 42161, dstEid: 30110 }
  const OPTIMISM = { chainId: 10, dstEid: 30111 }

  async function deployE2EFixture() {
    const [owner, depositor, signer, user1, user2, user3, claimer1, claimer2, stakingAddr] =
      await ethers.getSigners()

    const yusdContract = await ethers.deployContract('YUSD', [owner.address])
    const yusdAddress = await yusdContract.getAddress()

    // Main chain rewards contract
    const mainRewards = await ethers.deployContract('AegisRewardsV2', [
      yusdAddress,
      owner.address,
      true, // isMainChain
    ])
    const mainRewardsAddr = await mainRewards.getAddress()

    // Destination chain rewards contracts (simulated — same Hardhat network)
    const destArbitrum = await ethers.deployContract('AegisRewardsV2', [
      yusdAddress,
      owner.address,
      false, // not main chain
    ])
    const destArbitrumAddr = await destArbitrum.getAddress()

    const destOptimism = await ethers.deployContract('AegisRewardsV2', [
      yusdAddress,
      owner.address,
      false,
    ])
    const destOptimismAddr = await destOptimism.getAddress()

    // Setup YUSD
    await yusdContract.setMinter(owner.address)

    // Grant roles on main chain
    await mainRewards.grantRole(DEPOSITOR_ROLE, depositor.address)
    await mainRewards.grantRole(TRUSTED_SIGNER_ROLE, signer.address)

    // Grant roles on destination chains
    await destArbitrum.grantRole(DEPOSITOR_ROLE, owner.address)
    await destArbitrum.grantRole(TRUSTED_SIGNER_ROLE, signer.address)
    await destOptimism.grantRole(DEPOSITOR_ROLE, owner.address)
    await destOptimism.grantRole(TRUSTED_SIGNER_ROLE, signer.address)

    // Deploy MockOFTAdapter
    const mockOFTAdapter = await ethers.deployContract('MockOFTAdapter', [yusdAddress])
    const mockOFTAdapterAddr = await mockOFTAdapter.getAddress()
    await mainRewards.setOFTAdapter(mockOFTAdapterAddr)

    // Configure chains on main contract
    await mainRewards.configureChain(ARBITRUM.chainId, ARBITRUM.dstEid, destArbitrumAddr, true)
    await mainRewards.configureChain(OPTIMISM.chainId, OPTIMISM.dstEid, destOptimismAddr, true)

    // Set staking
    await mainRewards.setStakingContract(stakingAddr.address)

    return {
      yusdContract,
      yusdAddress,
      mainRewards,
      mainRewardsAddr,
      destArbitrum,
      destArbitrumAddr,
      destOptimism,
      destOptimismAddr,
      mockOFTAdapter,
      mockOFTAdapterAddr,
      owner,
      depositor,
      signer,
      user1,
      user2,
      user3,
      claimer1,
      claimer2,
      stakingAddr,
    }
  }

  // Simulate receiving bridged tokens on destination chain (mint + deposit)
  async function simulateBridgeReceive(
    fixture: Awaited<ReturnType<typeof deployE2EFixture>>,
    destContract: Awaited<ReturnType<typeof ethers.deployContract>>,
    amount: bigint,
  ) {
    const { yusdContract, owner } = fixture
    await yusdContract.mint(owner.address, amount)
    await yusdContract.transfer(await destContract.getAddress(), amount)
    await destContract.depositRewards(encodeString('bridge-deposit'), amount)
  }

  describe('Full lifecycle — Week 1 through Week 3', () => {
    it('should handle deposits, bridging, claiming, root updates, and claimer changes across weeks', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const {
        yusdContract, mainRewards, mainRewardsAddr,
        destArbitrum, destArbitrumAddr, destOptimism, destOptimismAddr,
        mockOFTAdapter,
        owner, depositor, signer,
        user1, user2, user3, claimer1, claimer2,
        stakingAddr,
      } = fixture

      // ================================================================
      // WEEK 1: Initial deposits and distribution
      // ================================================================

      // --- Deposit rewards (simulating AegisMinting calling depositRewards) ---
      const week1Total = ethers.parseEther('100000')
      await yusdContract.mint(depositor.address, week1Total)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, week1Total)
      await mainRewards.connect(depositor).depositRewards(encodeString('week1-minting'), week1Total)

      expect(await mainRewards.getMerklePoolBalance()).to.equal(week1Total)

      // --- Send portion to staking ---
      const stakingAmount = ethers.parseEther('20000')
      await mainRewards.connect(signer).sendToStaking(stakingAmount)

      expect(await mainRewards.getMerklePoolBalance()).to.equal(week1Total - stakingAmount)
      expect(await yusdContract.balanceOf(stakingAddr.address)).to.equal(stakingAmount)

      // --- Build Week 1 merkle tree ---
      // user1 self-claims, user2 is claimed by claimer1, user3 self-claims
      const week1Tree = buildRewardsTree([
        [user1.address, user1.address, ethers.parseEther('10000')],
        [user2.address, claimer1.address, ethers.parseEther('15000')],
        [user3.address, user3.address, ethers.parseEther('5000')],
      ])

      // --- Bridge to Arbitrum and Optimism, set merkle root — all in performDailyOperations ---
      const arbBridgeAmount = ethers.parseEther('25000')
      const optBridgeAmount = ethers.parseEther('15000')
      const nativeFee = ethers.parseEther('0.01')

      await mainRewards.connect(signer).performDailyOperations(
        week1Tree.root,
        [
          { chainId: ARBITRUM.chainId, amount: arbBridgeAmount, nativeFee, extraOptions: '0x' },
          { chainId: OPTIMISM.chainId, amount: optBridgeAmount, nativeFee, extraOptions: '0x' },
        ],
        { value: nativeFee * 2n },
      )

      // Verify main chain state after daily ops
      const expectedMainPool = week1Total - stakingAmount - arbBridgeAmount - optBridgeAmount
      expect(await mainRewards.getMerklePoolBalance()).to.equal(expectedMainPool)
      expect(await mainRewards.getMerkleRoot()).to.equal(week1Tree.root)

      // Verify bridge calls recorded on MockOFTAdapter
      const bridgeCall0 = await mockOFTAdapter.getBridgeCall(0)
      expect(bridgeCall0.dstEid).to.equal(ARBITRUM.dstEid)
      expect(bridgeCall0.amountLD).to.equal(arbBridgeAmount)
      expect(bridgeCall0.to).to.equal(
        ethers.zeroPadValue(destArbitrumAddr, 32),
      )

      const bridgeCall1 = await mockOFTAdapter.getBridgeCall(1)
      expect(bridgeCall1.dstEid).to.equal(OPTIMISM.dstEid)
      expect(bridgeCall1.amountLD).to.equal(optBridgeAmount)

      // --- Simulate destination chains receiving bridged tokens ---
      await simulateBridgeReceive(fixture, destArbitrum, arbBridgeAmount)
      await simulateBridgeReceive(fixture, destOptimism, optBridgeAmount)

      // Set same merkle root on destination chains
      await destArbitrum.connect(signer).setMerkleRoot(week1Tree.root)
      await destOptimism.connect(signer).setMerkleRoot(week1Tree.root)

      expect(await destArbitrum.getMerklePoolBalance()).to.equal(arbBridgeAmount)
      expect(await destOptimism.getMerklePoolBalance()).to.equal(optBridgeAmount)

      // --- User1 claims on main chain (self-claim) ---
      const user1Week1 = ethers.parseEther('10000')
      const proof1 = getMerkleProof(week1Tree, user1.address, user1.address)
      await mainRewards.connect(user1).claimMerkleRewards(user1.address, user1Week1, proof1)

      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Week1)
      expect(await mainRewards.getCumulativeClaimed(user1.address)).to.equal(user1Week1)

      // --- Claimer1 claims for user2 on Arbitrum ---
      const user2Week1 = ethers.parseEther('15000')
      const proof2 = getMerkleProof(week1Tree, user2.address, claimer1.address)
      await destArbitrum.connect(claimer1).claimMerkleRewards(user2.address, user2Week1, proof2)

      // Funds go to claimer1, cumulative tracked under user2's account
      expect(await yusdContract.balanceOf(claimer1.address)).to.equal(user2Week1)
      expect(await destArbitrum.getCumulativeClaimed(user2.address)).to.equal(user2Week1)

      // --- User3 claims on Optimism ---
      const user3Week1 = ethers.parseEther('5000')
      const proof3 = getMerkleProof(week1Tree, user3.address, user3.address)
      await destOptimism.connect(user3).claimMerkleRewards(user3.address, user3Week1, proof3)

      expect(await yusdContract.balanceOf(user3.address)).to.equal(user3Week1)

      // ================================================================
      // WEEK 2: New deposits, cumulative root update, delta claiming
      // ================================================================

      const week2Deposit = ethers.parseEther('80000')
      await yusdContract.mint(depositor.address, week2Deposit)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, week2Deposit)
      await mainRewards.connect(depositor).depositRewards(encodeString('week2-minting'), week2Deposit)

      // Cumulative amounts grow
      const week2Tree = buildRewardsTree([
        [user1.address, user1.address, ethers.parseEther('25000')],  // was 10k, earned 15k more
        [user2.address, claimer1.address, ethers.parseEther('30000')], // was 15k, earned 15k more
        [user3.address, user3.address, ethers.parseEther('12000')],   // was 5k, earned 7k more
      ])

      // --- performDailyOperations: only root update, no bridges this week ---
      await mainRewards.connect(signer).performDailyOperations(week2Tree.root, [])

      expect(await mainRewards.getMerkleRoot()).to.equal(week2Tree.root)

      // Update destination chains too
      await destArbitrum.connect(signer).setMerkleRoot(week2Tree.root)
      await destOptimism.connect(signer).setMerkleRoot(week2Tree.root)

      // --- User1 delta claim on main chain: 25000 - 10000 = 15000 ---
      const user1Week2 = ethers.parseEther('25000')
      const proof1w2 = getMerkleProof(week2Tree, user1.address, user1.address)
      await mainRewards.connect(user1).claimMerkleRewards(user1.address, user1Week2, proof1w2)

      const user1Delta = user1Week2 - user1Week1
      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Week2) // total received
      expect(await mainRewards.getCumulativeClaimed(user1.address)).to.equal(user1Week2)

      // --- Verify user1 can't claim again with same root ---
      await expect(
        mainRewards.connect(user1).claimMerkleRewards(user1.address, user1Week2, proof1w2),
      ).to.be.revertedWithCustomError(mainRewards, 'NothingToClaim')

      // --- User2 hasn't claimed week2 yet — claimer1 does delta claim on Arbitrum ---
      const user2Week2 = ethers.parseEther('30000')
      const proof2w2 = getMerkleProof(week2Tree, user2.address, claimer1.address)

      // Fund Arbitrum with more tokens to cover delta
      const arbDelta = user2Week2 - user2Week1
      await simulateBridgeReceive(fixture, destArbitrum, arbDelta)

      await destArbitrum.connect(claimer1).claimMerkleRewards(user2.address, user2Week2, proof2w2)
      expect(await yusdContract.balanceOf(claimer1.address)).to.equal(user2Week2)
      expect(await destArbitrum.getCumulativeClaimed(user2.address)).to.equal(user2Week2)

      // ================================================================
      // WEEK 3: Claimer rotation + multi-chain bridge + new user
      // ================================================================

      const week3Deposit = ethers.parseEther('60000')
      await yusdContract.mint(depositor.address, week3Deposit)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, week3Deposit)
      await mainRewards.connect(depositor).depositRewards(encodeString('week3-minting'), week3Deposit)

      // user2's claimer changes from claimer1 to claimer2
      const week3Tree = buildRewardsTree([
        [user1.address, user1.address, ethers.parseEther('40000')],
        [user2.address, claimer2.address, ethers.parseEther('45000')], // claimer changed!
        [user3.address, user3.address, ethers.parseEther('20000')],
      ])

      // Bridge to both chains and set root atomically
      const week3ArbBridge = ethers.parseEther('10000')
      const week3OptBridge = ethers.parseEther('10000')

      await mainRewards.connect(signer).performDailyOperations(
        week3Tree.root,
        [
          { chainId: ARBITRUM.chainId, amount: week3ArbBridge, nativeFee, extraOptions: '0x' },
          { chainId: OPTIMISM.chainId, amount: week3OptBridge, nativeFee, extraOptions: '0x' },
        ],
        { value: nativeFee * 2n },
      )

      // Simulate bridge receive on destinations
      await simulateBridgeReceive(fixture, destArbitrum, week3ArbBridge)
      await simulateBridgeReceive(fixture, destOptimism, week3OptBridge)
      await destArbitrum.connect(signer).setMerkleRoot(week3Tree.root)
      await destOptimism.connect(signer).setMerkleRoot(week3Tree.root)

      // --- Old claimer1 is rejected for user2 ---
      const oldProof = getMerkleProof(week2Tree, user2.address, claimer1.address)
      await expect(
        destArbitrum.connect(claimer1).claimMerkleRewards(user2.address, ethers.parseEther('45000'), oldProof),
      ).to.be.revertedWithCustomError(destArbitrum, 'InvalidMerkleProof')

      // --- New claimer2 succeeds for user2 on Arbitrum ---
      const user2Week3 = ethers.parseEther('45000')
      const proof2w3 = getMerkleProof(week3Tree, user2.address, claimer2.address)
      await destArbitrum.connect(claimer2).claimMerkleRewards(user2.address, user2Week3, proof2w3)

      // Delta: 45000 - 30000 = 15000 (30000 was already claimed in week 2)
      const user2Week3Delta = user2Week3 - user2Week2
      expect(await yusdContract.balanceOf(claimer2.address)).to.equal(user2Week3Delta)
      expect(await destArbitrum.getCumulativeClaimed(user2.address)).to.equal(user2Week3)

      // --- User3 skipped week 2, claims everything in week 3 on Optimism ---
      const user3Week3 = ethers.parseEther('20000')
      const proof3w3 = getMerkleProof(week3Tree, user3.address, user3.address)

      // Need more tokens on Optimism to cover delta
      const optDelta = user3Week3 - user3Week1
      await simulateBridgeReceive(fixture, destOptimism, optDelta)

      await destOptimism.connect(user3).claimMerkleRewards(user3.address, user3Week3, proof3w3)
      // Total received: 5000 (week1) + 15000 (week2+3 delta) = 20000
      expect(await yusdContract.balanceOf(user3.address)).to.equal(user3Week3)
      expect(await destOptimism.getCumulativeClaimed(user3.address)).to.equal(user3Week3)
    })
  })

  describe('Rescue flow across chains', () => {
    it('should rescue rewards on destination chain when user loses access', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { yusdContract, destArbitrum, signer, user1, user2, owner } = fixture

      // Setup destination chain with funds
      const amount = ethers.parseEther('5000')
      await simulateBridgeReceive(fixture, destArbitrum, amount)

      // user1 has rewards with self-claim
      const tree = buildRewardsTree([
        [user1.address, user1.address, amount],
      ])
      await destArbitrum.connect(signer).setMerkleRoot(tree.root)

      // Admin rescues to user2 (e.g., user1 lost wallet)
      const proof = getMerkleProof(tree, user1.address, user1.address)
      await destArbitrum.rescueMerkleRewards(user1.address, user1.address, user2.address, amount, proof)

      expect(await yusdContract.balanceOf(user2.address)).to.equal(amount)
      expect(await destArbitrum.getCumulativeClaimed(user1.address)).to.equal(amount)

      // user1 can't claim anymore
      await expect(
        destArbitrum.connect(user1).claimMerkleRewards(user1.address, amount, proof),
      ).to.be.revertedWithCustomError(destArbitrum, 'NothingToClaim')
    })

    it('should rescue rewards with separate claimer leaf', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { yusdContract, mainRewards, mainRewardsAddr, signer, user1, user2, user3, depositor } = fixture

      const amount = ethers.parseEther('10000')
      await yusdContract.mint(depositor.address, amount)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, amount)
      await mainRewards.connect(depositor).depositRewards(encodeString('rescue-test'), amount)

      // user1 is account, user2 is claimer
      const tree = buildRewardsTree([
        [user1.address, user2.address, amount],
      ])
      await mainRewards.connect(signer).setMerkleRoot(tree.root)

      // Both user1 and user2 lost access — admin rescues to user3
      const proof = getMerkleProof(tree, user1.address, user2.address)
      await mainRewards.rescueMerkleRewards(user1.address, user2.address, user3.address, amount, proof)

      expect(await yusdContract.balanceOf(user3.address)).to.equal(amount)
    })
  })

  describe('bridgeToChain standalone', () => {
    it('should bridge individually and verify OFT adapter state', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const {
        yusdContract, mainRewards, mainRewardsAddr,
        mockOFTAdapter, destArbitrumAddr,
        depositor, signer,
      } = fixture

      const amount = ethers.parseEther('50000')
      await yusdContract.mint(depositor.address, amount)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, amount)
      await mainRewards.connect(depositor).depositRewards(encodeString('bridge-test'), amount)

      const bridgeAmount = ethers.parseEther('20000')
      const nativeFee = ethers.parseEther('0.01')

      await mainRewards.connect(signer).bridgeToChain(
        ARBITRUM.chainId, bridgeAmount, '0x',
        { value: nativeFee },
      )

      // Verify pool decreased
      expect(await mainRewards.getMerklePoolBalance()).to.equal(amount - bridgeAmount)

      // Verify OFT adapter received tokens
      expect(await yusdContract.balanceOf(await mockOFTAdapter.getAddress())).to.equal(bridgeAmount)

      // Verify bridge call recorded
      const call = await mockOFTAdapter.getBridgeCall(0)
      expect(call.dstEid).to.equal(ARBITRUM.dstEid)
      expect(call.amountLD).to.equal(bridgeAmount)
      expect(call.to).to.equal(ethers.zeroPadValue(destArbitrumAddr, 32))
    })

    it('should not allow bridging on non-main chain', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { destArbitrum, signer } = fixture

      await expect(
        destArbitrum.connect(signer).bridgeToChain(OPTIMISM.chainId, ethers.parseEther('100'), '0x'),
      ).to.be.revertedWithCustomError(destArbitrum, 'NotMainChain')
    })
  })

  describe('quoteBridging', () => {
    it('should return correct fee quote', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { mainRewards } = fixture

      const fee = await mainRewards.quoteBridging(ARBITRUM.chainId, ethers.parseEther('1000'), '0x')
      expect(fee.nativeFee).to.equal(ethers.parseEther('0.01')) // MockOFTAdapter default
    })
  })

  describe('Multi-depositor scenario', () => {
    it('should handle deposits from multiple DEPOSITOR_ROLE holders', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const {
        yusdContract, mainRewards, mainRewardsAddr,
        owner, depositor, signer, user1,
      } = fixture

      // Grant DEPOSITOR_ROLE to a second depositor
      const secondDepositor = user1
      await mainRewards.grantRole(DEPOSITOR_ROLE, secondDepositor.address)

      // Depositor 1 deposits
      const amount1 = ethers.parseEther('30000')
      await yusdContract.mint(depositor.address, amount1)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, amount1)
      await mainRewards.connect(depositor).depositRewards(encodeString('dep-from-minting'), amount1)

      // Depositor 2 deposits
      const amount2 = ethers.parseEther('20000')
      await yusdContract.mint(secondDepositor.address, amount2)
      await yusdContract.connect(secondDepositor).transfer(mainRewardsAddr, amount2)
      await mainRewards.connect(secondDepositor).depositRewards(encodeString('dep-from-income'), amount2)

      expect(await mainRewards.getMerklePoolBalance()).to.equal(amount1 + amount2)
      expect(await mainRewards.availableBalanceForDeposits()).to.equal(0n)
    })
  })

  describe('Invariants', () => {
    it('should maintain balance >= merklePoolBalance at all times', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const {
        yusdContract, mainRewards, mainRewardsAddr,
        depositor, signer, user1, stakingAddr,
      } = fixture

      const amount = ethers.parseEther('50000')
      await yusdContract.mint(depositor.address, amount)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, amount)
      await mainRewards.connect(depositor).depositRewards(encodeString('inv-test'), amount)

      // After deposit
      let balance = await yusdContract.balanceOf(mainRewardsAddr)
      let pool = await mainRewards.getMerklePoolBalance()
      expect(balance).to.be.gte(pool)

      // After staking
      await mainRewards.connect(signer).sendToStaking(ethers.parseEther('10000'))
      balance = await yusdContract.balanceOf(mainRewardsAddr)
      pool = await mainRewards.getMerklePoolBalance()
      expect(balance).to.be.gte(pool)

      // After claiming
      const tree = buildRewardsTree([[user1.address, user1.address, ethers.parseEther('5000')]])
      await mainRewards.connect(signer).setMerkleRoot(tree.root)
      const proof = getMerkleProof(tree, user1.address, user1.address)
      await mainRewards.connect(user1).claimMerkleRewards(user1.address, ethers.parseEther('5000'), proof)

      balance = await yusdContract.balanceOf(mainRewardsAddr)
      pool = await mainRewards.getMerklePoolBalance()
      expect(balance).to.be.gte(pool)

      // availableBalanceForDeposits should be 0 (no excess tokens)
      expect(await mainRewards.availableBalanceForDeposits()).to.equal(0n)
    })
  })
})
