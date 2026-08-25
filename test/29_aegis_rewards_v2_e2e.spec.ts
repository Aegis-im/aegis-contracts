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
  const BNB = { chainId: 56, dstEid: 30102 }
  const AVALANCHE = { chainId: 43114, dstEid: 30106 }

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
      owner.address, // rescueTo
    ])
    const mainRewardsAddr = await mainRewards.getAddress()

    // Destination chain rewards contracts (simulated — same Hardhat network)
    const destBnb = await ethers.deployContract('AegisRewardsV2', [
      yusdAddress,
      owner.address,
      false, // not main chain
      owner.address, // rescueTo
    ])
    const destBnbAddr = await destBnb.getAddress()

    const destAvax = await ethers.deployContract('AegisRewardsV2', [
      yusdAddress,
      owner.address,
      false,
      owner.address, // rescueTo
    ])
    const destAvaxAddr = await destAvax.getAddress()

    // Setup YUSD
    await yusdContract.setMinter(owner.address)

    // Grant roles on main chain
    await mainRewards.grantRole(DEPOSITOR_ROLE, depositor.address)
    await mainRewards.grantRole(TRUSTED_SIGNER_ROLE, signer.address)

    // Grant roles on destination chains
    await destBnb.grantRole(DEPOSITOR_ROLE, owner.address)
    await destBnb.grantRole(TRUSTED_SIGNER_ROLE, signer.address)
    await destAvax.grantRole(DEPOSITOR_ROLE, owner.address)
    await destAvax.grantRole(TRUSTED_SIGNER_ROLE, signer.address)

    // Deploy MockOFTAdapter
    const mockOFTAdapter = await ethers.deployContract('MockOFTAdapter', [yusdAddress])
    const mockOFTAdapterAddr = await mockOFTAdapter.getAddress()
    await mainRewards.setOFTAdapter(mockOFTAdapterAddr)

    // Configure chains on main contract
    await mainRewards.configureChain(BNB.chainId, BNB.dstEid, destBnbAddr, true)
    await mainRewards.configureChain(AVALANCHE.chainId, AVALANCHE.dstEid, destAvaxAddr, true)

    // Set staking
    await mainRewards.setStakingContract(stakingAddr.address)

    return {
      yusdContract,
      yusdAddress,
      mainRewards,
      mainRewardsAddr,
      destBnb,
      destBnbAddr,
      destAvax,
      destAvaxAddr,
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
        destBnb, destBnbAddr, destAvax, destAvaxAddr,
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

      // --- Bridge to BNB and Avalanche, set merkle root — all in performDailyOperations ---
      const bnbBridgeAmount = ethers.parseEther('25000')
      const avaxBridgeAmount = ethers.parseEther('15000')
      const nativeFee = ethers.parseEther('0.01')

      // Total tree unclaimed = 10000 + 15000 + 5000 = 30000; pool after bridges = 40000
      await mainRewards.connect(signer).performDailyOperations(
        week1Tree.root,
        ethers.parseEther('30000'),
        [
          { chainId: BNB.chainId, amount: bnbBridgeAmount, nativeFee, extraOptions: '0x' },
          { chainId: AVALANCHE.chainId, amount: avaxBridgeAmount, nativeFee, extraOptions: '0x' },
        ],
        { value: nativeFee * 2n },
      )

      // Verify main chain state after daily ops
      const expectedMainPool = week1Total - stakingAmount - bnbBridgeAmount - avaxBridgeAmount
      expect(await mainRewards.getMerklePoolBalance()).to.equal(expectedMainPool)
      expect(await mainRewards.getMerkleRoot()).to.equal(week1Tree.root)

      // Verify bridge calls recorded on MockOFTAdapter
      const bridgeCall0 = await mockOFTAdapter.getBridgeCall(0)
      expect(bridgeCall0.dstEid).to.equal(BNB.dstEid)
      expect(bridgeCall0.amountLD).to.equal(bnbBridgeAmount)
      expect(bridgeCall0.to).to.equal(
        ethers.zeroPadValue(destBnbAddr, 32),
      )

      const bridgeCall1 = await mockOFTAdapter.getBridgeCall(1)
      expect(bridgeCall1.dstEid).to.equal(AVALANCHE.dstEid)
      expect(bridgeCall1.amountLD).to.equal(avaxBridgeAmount)

      // --- Simulate destination chains receiving bridged tokens ---
      await simulateBridgeReceive(fixture, destBnb, bnbBridgeAmount)
      await simulateBridgeReceive(fixture, destAvax, avaxBridgeAmount)

      // Set same merkle root on destination chains
      await destBnb.connect(signer).setMerkleRoot(week1Tree.root, bnbBridgeAmount)
      await destAvax.connect(signer).setMerkleRoot(week1Tree.root, avaxBridgeAmount)

      expect(await destBnb.getMerklePoolBalance()).to.equal(bnbBridgeAmount)
      expect(await destAvax.getMerklePoolBalance()).to.equal(avaxBridgeAmount)

      // --- User1 claims on main chain (self-claim) ---
      const user1Week1 = ethers.parseEther('10000')
      const proof1 = getMerkleProof(week1Tree, user1.address, user1.address)
      await mainRewards.connect(user1).claimMerkleRewards(user1.address, user1Week1, proof1)

      expect(await yusdContract.balanceOf(user1.address)).to.equal(user1Week1)
      expect(await mainRewards.getCumulativeClaimed(user1.address)).to.equal(user1Week1)

      // --- Claimer1 claims for user2 on BNB ---
      const user2Week1 = ethers.parseEther('15000')
      const proof2 = getMerkleProof(week1Tree, user2.address, claimer1.address)
      await destBnb.connect(claimer1).claimMerkleRewards(user2.address, user2Week1, proof2)

      // Funds go to claimer1, cumulative tracked under user2's account
      expect(await yusdContract.balanceOf(claimer1.address)).to.equal(user2Week1)
      expect(await destBnb.getCumulativeClaimed(user2.address)).to.equal(user2Week1)

      // --- User3 claims on Avalanche ---
      const user3Week1 = ethers.parseEther('5000')
      const proof3 = getMerkleProof(week1Tree, user3.address, user3.address)
      await destAvax.connect(user3).claimMerkleRewards(user3.address, user3Week1, proof3)

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
      // Unclaimed on main: (25000-10000) + (30000-0) + (12000-0) = 57000
      await mainRewards.connect(signer).performDailyOperations(week2Tree.root, ethers.parseEther('57000'), [])

      expect(await mainRewards.getMerkleRoot()).to.equal(week2Tree.root)

      // Fund BNB with tokens to cover user2's delta before setting root
      const user2Week2 = ethers.parseEther('30000')
      const bnbDelta = user2Week2 - user2Week1
      await simulateBridgeReceive(fixture, destBnb, bnbDelta)

      // Update destination chains (bridge first, then set root)
      // BNB pool: 25000 - 15000 (week1 claim) + 15000 (delta deposit) = 25000; user2 unclaimed = 15000
      await destBnb.connect(signer).setMerkleRoot(week2Tree.root, ethers.parseEther('15000'))
      // AVAX pool: 15000 - 5000 (week1 claim) = 10000; user3 unclaimed = 7000
      await destAvax.connect(signer).setMerkleRoot(week2Tree.root, ethers.parseEther('7000'))

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

      // --- User2 delta claim on BNB ---
      const proof2w2 = getMerkleProof(week2Tree, user2.address, claimer1.address)

      await destBnb.connect(claimer1).claimMerkleRewards(user2.address, user2Week2, proof2w2)
      expect(await yusdContract.balanceOf(claimer1.address)).to.equal(user2Week2)
      expect(await destBnb.getCumulativeClaimed(user2.address)).to.equal(user2Week2)

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
      const week3BnbBridge = ethers.parseEther('10000')
      const week3AvaxBridge = ethers.parseEther('10000')

      // Main pool before bridges: 110000 - 15000 (user1 delta claim) + 60000 (deposit) = 155000
      // After bridges: 155000 - 10000 - 10000 = 135000
      // Unclaimed on main: (40000-25000) + (45000-0) + (20000-0) = 80000
      await mainRewards.connect(signer).performDailyOperations(
        week3Tree.root,
        ethers.parseEther('80000'),
        [
          { chainId: BNB.chainId, amount: week3BnbBridge, nativeFee, extraOptions: '0x' },
          { chainId: AVALANCHE.chainId, amount: week3AvaxBridge, nativeFee, extraOptions: '0x' },
        ],
        { value: nativeFee * 2n },
      )

      // Simulate bridge receive on destinations
      await simulateBridgeReceive(fixture, destBnb, week3BnbBridge)
      await simulateBridgeReceive(fixture, destAvax, week3AvaxBridge)
      // Arb: pool = 25000 - 15000 (week2 claim) + 10000 (bridge) = 20000; user2 unclaimed = 45000 - 30000 = 15000
      await destBnb.connect(signer).setMerkleRoot(week3Tree.root, ethers.parseEther('15000'))
      // Opt: pool = 10000 + 10000 (bridge) = 20000; user3 unclaimed = 20000 - 5000 = 15000
      await destAvax.connect(signer).setMerkleRoot(week3Tree.root, ethers.parseEther('15000'))

      // --- Old claimer1 is rejected for user2 ---
      const oldProof = getMerkleProof(week2Tree, user2.address, claimer1.address)
      await expect(
        destBnb.connect(claimer1).claimMerkleRewards(user2.address, ethers.parseEther('45000'), oldProof),
      ).to.be.revertedWithCustomError(destBnb, 'InvalidMerkleProof')

      // --- New claimer2 succeeds for user2 on BNB ---
      const user2Week3 = ethers.parseEther('45000')
      const proof2w3 = getMerkleProof(week3Tree, user2.address, claimer2.address)
      await destBnb.connect(claimer2).claimMerkleRewards(user2.address, user2Week3, proof2w3)

      // Delta: 45000 - 30000 = 15000 (30000 was already claimed in week 2)
      const user2Week3Delta = user2Week3 - user2Week2
      expect(await yusdContract.balanceOf(claimer2.address)).to.equal(user2Week3Delta)
      expect(await destBnb.getCumulativeClaimed(user2.address)).to.equal(user2Week3)

      // --- User3 skipped week 2, claims everything in week 3 on Avalanche ---
      const user3Week3 = ethers.parseEther('20000')
      const proof3w3 = getMerkleProof(week3Tree, user3.address, user3.address)

      // Need more tokens on Avalanche to cover delta
      const avaxDelta = user3Week3 - user3Week1
      await simulateBridgeReceive(fixture, destAvax, avaxDelta)

      await destAvax.connect(user3).claimMerkleRewards(user3.address, user3Week3, proof3w3)
      // Total received: 5000 (week1) + 15000 (week2+3 delta) = 20000
      expect(await yusdContract.balanceOf(user3.address)).to.equal(user3Week3)
      expect(await destAvax.getCumulativeClaimed(user3.address)).to.equal(user3Week3)
    })
  })

  describe('Rescue flow across chains', () => {
    it('should rescue rewards on destination chain when user loses access', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { yusdContract, destBnb, signer, user1, user2, owner } = fixture

      // Setup destination chain with funds
      const amount = ethers.parseEther('5000')
      await simulateBridgeReceive(fixture, destBnb, amount)

      // user1 has rewards with self-claim
      const tree = buildRewardsTree([
        [user1.address, user1.address, amount],
      ])
      await destBnb.connect(signer).setMerkleRoot(tree.root, amount)

      // Admin rescues to user2 (e.g., user1 lost wallet)
      const proof = getMerkleProof(tree, user1.address, user1.address)
      await destBnb.rescueMerkleRewards(user1.address, user1.address, user2.address, amount, proof)

      expect(await yusdContract.balanceOf(user2.address)).to.equal(amount)
      expect(await destBnb.getCumulativeClaimed(user1.address)).to.equal(amount)

      // user1 can't claim anymore
      await expect(
        destBnb.connect(user1).claimMerkleRewards(user1.address, amount, proof),
      ).to.be.revertedWithCustomError(destBnb, 'NothingToClaim')
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
      await mainRewards.connect(signer).setMerkleRoot(tree.root, amount)

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
        mockOFTAdapter, destBnbAddr,
        depositor, signer,
      } = fixture

      const amount = ethers.parseEther('50000')
      await yusdContract.mint(depositor.address, amount)
      await yusdContract.connect(depositor).transfer(mainRewardsAddr, amount)
      await mainRewards.connect(depositor).depositRewards(encodeString('bridge-test'), amount)

      const bridgeAmount = ethers.parseEther('20000')
      const nativeFee = ethers.parseEther('0.01')

      await mainRewards.connect(signer).bridgeToChain(
        BNB.chainId, bridgeAmount, '0x',
        { value: nativeFee },
      )

      // Verify pool decreased
      expect(await mainRewards.getMerklePoolBalance()).to.equal(amount - bridgeAmount)

      // Verify OFT adapter received tokens
      expect(await yusdContract.balanceOf(await mockOFTAdapter.getAddress())).to.equal(bridgeAmount)

      // Verify bridge call recorded
      const call = await mockOFTAdapter.getBridgeCall(0)
      expect(call.dstEid).to.equal(BNB.dstEid)
      expect(call.amountLD).to.equal(bridgeAmount)
      expect(call.to).to.equal(ethers.zeroPadValue(destBnbAddr, 32))
    })

    it('should not allow bridging on non-main chain', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { destBnb, signer } = fixture

      await expect(
        destBnb.connect(signer).bridgeToChain(AVALANCHE.chainId, ethers.parseEther('100'), '0x'),
      ).to.be.revertedWithCustomError(destBnb, 'NotMainChain')
    })
  })

  describe('quoteBridging', () => {
    it('should return correct fee quote', async () => {
      const fixture = await loadFixture(deployE2EFixture)
      const { mainRewards } = fixture

      const fee = await mainRewards.quoteBridging(BNB.chainId, ethers.parseEther('1000'), '0x')
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
      await mainRewards.connect(signer).setMerkleRoot(tree.root, ethers.parseEther('5000'))
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
