import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  DEPOSITOR_ROLE,
  TRUSTED_SIGNER_ROLE,
  DEFAULT_ADMIN_ROLE,
  deployRewardsV2Fixture,
  encodeString,
  buildRewardsTree,
  getMerkleProof,
} from '../utils/helpers'

describe('AegisRewardsV2', () => {
  // Helper: deposit rewards and fund the merkle pool
  async function depositAndFund(fixture: Awaited<ReturnType<typeof deployRewardsV2Fixture>>, amount: bigint) {
    const [owner] = await ethers.getSigners()
    const { aegisRewardsV2Contract, yusdContract } = fixture

    await yusdContract.mint(owner, amount)
    await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
    await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), amount)
  }

  describe('#depositRewards', () => {
    describe('success', () => {
      it('should add rewards to merkle pool balance', async function () {
        this.timeout(240000)
        const [owner] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract, yusdContract } = fixture

        const amount = ethers.parseEther('1000')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)

        await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), amount)

        expect(await aegisRewardsV2Contract.getMerklePoolBalance()).to.equal(amount)
      })

      it('should emit DepositRewards event', async () => {
        const [owner] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract, yusdContract } = fixture

        const amount = ethers.parseEther('500')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)

        await expect(aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), amount))
          .to.emit(aegisRewardsV2Contract, 'DepositRewards')
      })

      it('should accumulate multiple deposits', async () => {
        const [owner] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract, yusdContract } = fixture

        const amount1 = ethers.parseEther('1000')
        const amount2 = ethers.parseEther('2000')
        const total = amount1 + amount2

        await yusdContract.mint(owner, total)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), total)

        await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), amount1)
        await aegisRewardsV2Contract.depositRewards(encodeString('deposit-2'), amount2)

        expect(await aegisRewardsV2Contract.getMerklePoolBalance()).to.equal(total)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have DEPOSITOR_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).depositRewards(encodeString('test'), ethers.parseEther('1')),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when no tokens were transferred before deposit', async () => {
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.depositRewards(encodeString('no-transfer'), ethers.parseEther('1000')),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InsufficientContractBalance')
      })

      it('should revert when transferred amount is less than deposit amount', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

        const transferAmount = ethers.parseEther('500')
        const depositAmount = ethers.parseEther('1000')

        await yusdContract.mint(owner, transferAmount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), transferAmount)

        await expect(
          aegisRewardsV2Contract.depositRewards(encodeString('partial'), depositAmount),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InsufficientContractBalance')
      })

      it('should revert on second deposit without additional transfer', async () => {
        const [owner] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract, yusdContract } = fixture

        const amount = ethers.parseEther('1000')
        await yusdContract.mint(owner, amount)
        await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)

        await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), amount)

        // Second deposit without transferring more tokens
        await expect(
          aegisRewardsV2Contract.depositRewards(encodeString('deposit-2'), ethers.parseEther('1')),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InsufficientContractBalance')
      })
    })
  })

  describe('#sendToStaking', () => {
    describe('success', () => {
      it('should send amount to staking contract and deduct from merkle pool', async () => {
        const [owner, stakingContract] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract, yusdContract } = fixture

        await aegisRewardsV2Contract.setStakingContract(stakingContract.address)

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        const stakingAmount = ethers.parseEther('5000')

        const stakingBalanceBefore = await yusdContract.balanceOf(stakingContract.address)
        await aegisRewardsV2Contract.sendToStaking(stakingAmount)
        const stakingBalanceAfter = await yusdContract.balanceOf(stakingContract.address)

        expect(stakingBalanceAfter - stakingBalanceBefore).to.equal(stakingAmount)
        expect(await aegisRewardsV2Contract.getMerklePoolBalance()).to.equal(amount - stakingAmount)
      })

      it('should emit SendToStaking event', async () => {
        const [, stakingContract] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        await aegisRewardsV2Contract.setStakingContract(stakingContract.address)

        const amount = ethers.parseEther('1000')
        await depositAndFund(fixture, amount)

        await expect(aegisRewardsV2Contract.sendToStaking(amount))
          .to.emit(aegisRewardsV2Contract, 'SendToStaking')
          .withArgs(stakingContract.address, amount)
      })
    })

    describe('error', () => {
      it('should revert when staking contract is not set', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const amount = ethers.parseEther('1000')
        await depositAndFund(fixture, amount)

        await expect(
          aegisRewardsV2Contract.sendToStaking(amount),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ZeroAddress')
      })

      it('should revert when amount exceeds merkle pool balance', async () => {
        const [, stakingContract] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        await aegisRewardsV2Contract.setStakingContract(stakingContract.address)

        const amount = ethers.parseEther('1000')
        await depositAndFund(fixture, amount)

        await expect(
          aegisRewardsV2Contract.sendToStaking(amount + 1n),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InsufficientContractBalance')
      })

      it('should revert when caller does not have TRUSTED_SIGNER_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).sendToStaking(ethers.parseEther('100')),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#bridgeToChain', () => {
    describe('success', () => {
      it('should bridge tokens and deduct from merkle pool', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const chainId = 56 // BNB
        const dstEid = 30102
        const rewardsAddr = ethers.Wallet.createRandom().address

        await aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true)

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        const bridgeAmount = ethers.parseEther('3000')

        await expect(aegisRewardsV2Contract.bridgeToChain(chainId, bridgeAmount, '0x', { value: ethers.parseEther('0.01') }))
          .to.emit(aegisRewardsV2Contract, 'CrossChainDistribution')
          .withArgs(chainId, rewardsAddr, bridgeAmount)

        expect(await aegisRewardsV2Contract.getMerklePoolBalance()).to.equal(amount - bridgeAmount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have TRUSTED_SIGNER_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).bridgeToChain(56, ethers.parseEther('100'), '0x'),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when chain not configured', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const amount = ethers.parseEther('1000')
        await depositAndFund(fixture, amount)

        await expect(
          aegisRewardsV2Contract.bridgeToChain(99999, amount, '0x', { value: ethers.parseEther('0.01') }),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidChain')
      })

      it('should revert when amount exceeds merkle pool', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const chainId = 56
        const dstEid = 30102
        const rewardsAddr = ethers.Wallet.createRandom().address
        await aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true)

        const amount = ethers.parseEther('1000')
        await depositAndFund(fixture, amount)

        await expect(
          aegisRewardsV2Contract.bridgeToChain(chainId, amount + 1n, '0x', { value: ethers.parseEther('0.01') }),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InsufficientContractBalance')
      })
    })
  })

  describe('#performDailyOperations', () => {
    describe('success', () => {
      it('should set merkle root and execute bridges atomically', async () => {
        const [, user1] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const chainId = 56
        const dstEid = 30102
        const rewardsAddr = ethers.Wallet.createRandom().address
        await aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true)

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        const tree = buildRewardsTree([[user1.address, user1.address, ethers.parseEther('100')]])

        const bridgeAmount = ethers.parseEther('2000')
        const nativeFee = ethers.parseEther('0.01')

        const tx = aegisRewardsV2Contract.performDailyOperations(
          tree.root,
          ethers.parseEther('100'),
          [{ chainId, amount: bridgeAmount, nativeFee, extraOptions: '0x' }],
          { value: nativeFee },
        )

        await expect(tx).to.emit(aegisRewardsV2Contract, 'SetMerkleRoot').withArgs(tree.root)
        await expect(tx).to.emit(aegisRewardsV2Contract, 'CrossChainDistribution').withArgs(chainId, rewardsAddr, bridgeAmount)

        expect(await aegisRewardsV2Contract.getMerkleRoot()).to.equal(tree.root)
        expect(await aegisRewardsV2Contract.getMerklePoolBalance()).to.equal(amount - bridgeAmount)
      })

      it('should skip merkle root when zero', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        const tx = aegisRewardsV2Contract.performDailyOperations(ethers.ZeroHash, 0, [])

        await expect(tx).to.not.emit(aegisRewardsV2Contract, 'SetMerkleRoot')
      })

      it('should execute only merkle root with no bridges', async () => {
        const [, user1] = await ethers.getSigners()
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        const tree = buildRewardsTree([[user1.address, user1.address, ethers.parseEther('100')]])

        await aegisRewardsV2Contract.performDailyOperations(tree.root, ethers.parseEther('100'), [])

        expect(await aegisRewardsV2Contract.getMerkleRoot()).to.equal(tree.root)
        expect(await aegisRewardsV2Contract.getMerklePoolBalance()).to.equal(amount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have TRUSTED_SIGNER_ROLE', async () => {
        const [, user] = await ethers.getSigners()
        const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

        await expect(
          aegisRewardsV2Contract.connect(user).performDailyOperations(ethers.ZeroHash, 0, []),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when bridge chain not configured', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        await expect(
          aegisRewardsV2Contract.performDailyOperations(ethers.ZeroHash, 0, [
            { chainId: 99999, amount: ethers.parseEther('100'), nativeFee: 0, extraOptions: '0x' },
          ]),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidChain')
      })

      it('should revert when msg.value does not match total native fees', async () => {
        const fixture = await loadFixture(deployRewardsV2Fixture)
        const { aegisRewardsV2Contract } = fixture

        const chainId = 56
        const dstEid = 30102
        const rewardsAddr = ethers.Wallet.createRandom().address
        await aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true)

        const amount = ethers.parseEther('10000')
        await depositAndFund(fixture, amount)

        const nativeFee = ethers.parseEther('0.01')

        await expect(
          aegisRewardsV2Contract.performDailyOperations(
            ethers.ZeroHash,
            0,
            [{ chainId, amount: ethers.parseEther('2000'), nativeFee, extraOptions: '0x' }],
            { value: nativeFee * 2n },
          ),
        ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidNativeFee')
      })
    })
  })

  describe('#quoteBridging', () => {
    it('should return fee quote for bridging', async () => {
      const fixture = await loadFixture(deployRewardsV2Fixture)
      const { aegisRewardsV2Contract } = fixture

      const chainId = 56
      const dstEid = 30102
      const rewardsAddr = ethers.Wallet.createRandom().address
      await aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true)

      const amount = ethers.parseEther('1000')
      const fee = await aegisRewardsV2Contract.quoteBridging(chainId, amount, '0x')

      expect(fee.nativeFee).to.be.gte(0)
    })

    it('should revert when OFT adapter not set', async () => {
      const [owner] = await ethers.getSigners()

      const yusdContract = await ethers.deployContract('YUSD', [owner.address])
      const yusdAddress = await yusdContract.getAddress()

      const contract = await ethers.deployContract('AegisRewardsV2', [
        yusdAddress,
        owner.address,
        true,
        owner.address, // rescueTo
      ])

      await expect(
        contract.quoteBridging(56, ethers.parseEther('100'), '0x'),
      ).to.be.revertedWithCustomError(contract, 'OFTAdapterNotSet')
    })

    it('should revert when chain not configured', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.quoteBridging(99999, ethers.parseEther('100'), '0x'),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidChain')
    })
  })

  describe('#configureChain', () => {
    it('should add a chain configuration', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const chainId = 56
      const dstEid = 30102
      const rewardsAddr = ethers.Wallet.createRandom().address

      await expect(aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true))
        .to.emit(aegisRewardsV2Contract, 'ChainConfigured')
        .withArgs(chainId, dstEid, rewardsAddr, true)

      const config = await aegisRewardsV2Contract.getChainConfig(chainId)
      expect(config.dstEid).to.equal(dstEid)
      expect(config.rewardsContract).to.equal(rewardsAddr)
      expect(config.configured).to.equal(true)

      const chains = await aegisRewardsV2Contract.getSupportedChains()
      expect(chains.length).to.equal(1)
      expect(chains[0]).to.equal(chainId)
    })

    it('should remove a chain configuration', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const chainId = 56
      const dstEid = 30102
      const rewardsAddr = ethers.Wallet.createRandom().address

      await aegisRewardsV2Contract.configureChain(chainId, dstEid, rewardsAddr, true)
      await aegisRewardsV2Contract.configureChain(chainId, 0, ethers.ZeroAddress, false)

      const config = await aegisRewardsV2Contract.getChainConfig(chainId)
      expect(config.configured).to.equal(false)

      const chains = await aegisRewardsV2Contract.getSupportedChains()
      expect(chains.length).to.equal(0)
    })

    it('should revert when adding with zero rewards contract', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.configureChain(56, 30102, ethers.ZeroAddress, true),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ZeroAddress')
    })

    it('should revert when adding already configured chain', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const rewardsAddr = ethers.Wallet.createRandom().address
      await aegisRewardsV2Contract.configureChain(56, 30102, rewardsAddr, true)

      await expect(
        aegisRewardsV2Contract.configureChain(56, 30102, rewardsAddr, true),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'ChainAlreadyConfigured')
    })

    it('should revert when adding with zero dstEid', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const rewardsAddr = ethers.Wallet.createRandom().address
      await expect(
        aegisRewardsV2Contract.configureChain(56, 0, rewardsAddr, true),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidChain')
    })

    it('should revert when removing non-configured chain', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.configureChain(56, 0, ethers.ZeroAddress, false),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'InvalidChain')
    })

    it('should revert when caller is not admin', async () => {
      const [, user] = await ethers.getSigners()
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.connect(user).configureChain(56, 30102, user.address, true),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('#rescueAssets', () => {
    it('should rescue excess YUSD above merkle pool balance', async () => {
      const [owner] = await ethers.getSigners()
      const fixture = await loadFixture(deployRewardsV2Fixture)
      const { aegisRewardsV2Contract, yusdContract } = fixture

      const deposited = ethers.parseEther('5000')
      const extra = ethers.parseEther('1000')
      const total = deposited + extra

      await yusdContract.mint(owner, total)
      await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), total)
      await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), deposited)

      const ownerBefore = await yusdContract.balanceOf(owner.address)
      await aegisRewardsV2Contract.rescueAssets(await yusdContract.getAddress())
      const ownerAfter = await yusdContract.balanceOf(owner.address)

      expect(ownerAfter - ownerBefore).to.equal(extra)
    })

    it('should revert when no excess YUSD', async () => {
      const fixture = await loadFixture(deployRewardsV2Fixture)
      const { aegisRewardsV2Contract, yusdContract } = fixture

      const amount = ethers.parseEther('1000')
      await depositAndFund(fixture, amount)

      await expect(
        aegisRewardsV2Contract.rescueAssets(await yusdContract.getAddress()),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'NoTokensToRescue')
    })

    it('should revert when caller is not admin', async () => {
      const [, user] = await ethers.getSigners()
      const { aegisRewardsV2Contract, yusdContract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.connect(user).rescueAssets(await yusdContract.getAddress()),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('#availableBalanceForDeposits', () => {
    it('should return balance minus merkle pool', async () => {
      const [owner] = await ethers.getSigners()
      const fixture = await loadFixture(deployRewardsV2Fixture)
      const { aegisRewardsV2Contract, yusdContract } = fixture

      const total = ethers.parseEther('10000')
      const deposited = ethers.parseEther('7000')

      await yusdContract.mint(owner, total)
      await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), total)
      await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), deposited)

      expect(await aegisRewardsV2Contract.availableBalanceForDeposits()).to.equal(total - deposited)
    })

    it('should return 0 when balance equals merkle pool', async () => {
      const [owner] = await ethers.getSigners()
      const fixture = await loadFixture(deployRewardsV2Fixture)
      const { aegisRewardsV2Contract, yusdContract } = fixture

      const amount = ethers.parseEther('1000')
      await yusdContract.mint(owner, amount)
      await yusdContract.transfer(await aegisRewardsV2Contract.getAddress(), amount)
      await aegisRewardsV2Contract.depositRewards(encodeString('deposit-1'), amount)

      expect(await aegisRewardsV2Contract.availableBalanceForDeposits()).to.equal(0n)
    })
  })

  describe('#admin setters', () => {
    it('should set staking contract', async () => {
      const [, stakingAddr] = await ethers.getSigners()
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(aegisRewardsV2Contract.setStakingContract(stakingAddr.address))
        .to.emit(aegisRewardsV2Contract, 'SetStakingContract')
        .withArgs(stakingAddr.address)

      expect(await aegisRewardsV2Contract.stakingContract()).to.equal(stakingAddr.address)
    })

    it('should set OFT adapter', async () => {
      const { aegisRewardsV2Contract, mockOFTAdapterAddress } = await loadFixture(deployRewardsV2Fixture)

      const newAdapter = ethers.Wallet.createRandom().address
      await expect(aegisRewardsV2Contract.setOFTAdapter(newAdapter))
        .to.emit(aegisRewardsV2Contract, 'SetOFTAdapter')
        .withArgs(newAdapter)
    })
  })

  describe('#receive', () => {
    it('should accept ETH sent to contract', async () => {
      const [owner] = await ethers.getSigners()
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const amount = ethers.parseEther('1')
      await owner.sendTransaction({
        to: await aegisRewardsV2Contract.getAddress(),
        value: amount,
      })

      expect(await ethers.provider.getBalance(await aegisRewardsV2Contract.getAddress())).to.equal(amount)
    })
  })

  describe('#rescueETH', () => {
    it('should rescue ETH sent to contract', async () => {
      const [owner] = await ethers.getSigners()
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const amount = ethers.parseEther('1')
      await owner.sendTransaction({
        to: await aegisRewardsV2Contract.getAddress(),
        value: amount,
      })

      const balanceBefore = await ethers.provider.getBalance(owner.address)
      const tx = await aegisRewardsV2Contract.rescueETH()
      const receipt = await tx.wait()
      const gasCost = receipt!.gasUsed * receipt!.gasPrice
      const balanceAfter = await ethers.provider.getBalance(owner.address)

      expect(balanceAfter - balanceBefore + gasCost).to.equal(amount)
    })

    it('should emit RescueAssets event with zero address for ETH', async () => {
      const [owner] = await ethers.getSigners()
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      const amount = ethers.parseEther('1')
      await owner.sendTransaction({
        to: await aegisRewardsV2Contract.getAddress(),
        value: amount,
      })

      await expect(aegisRewardsV2Contract.rescueETH())
        .to.emit(aegisRewardsV2Contract, 'RescueAssets')
        .withArgs(ethers.ZeroAddress, owner.address, amount)
    })

    it('should revert when no ETH to rescue', async () => {
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.rescueETH(),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'NoTokensToRescue')
    })

    it('should revert when caller is not admin', async () => {
      const [, user] = await ethers.getSigners()
      const { aegisRewardsV2Contract } = await loadFixture(deployRewardsV2Fixture)

      await expect(
        aegisRewardsV2Contract.connect(user).rescueETH(),
      ).to.be.revertedWithCustomError(aegisRewardsV2Contract, 'AccessControlUnauthorizedAccount')
    })
  })
})
