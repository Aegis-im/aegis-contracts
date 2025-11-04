import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  MAX_BPS,
  FUNDS_MANAGER_ROLE,
  COLLATERAL_MANAGER_ROLE,
  INCOME_FEE_BP,
  OrderType,
  deployJUSDFixture,
  custodianAccount,
  insuranceFundAccount,
  signOrderJUSD,
  signOrderJUSDByWallet,
  encodeString,
  SETTINGS_MANAGER_ROLE,
} from '../utils/helpers'

describe('AegisMintingJUSD', function() {
  this.timeout(300000) // 5 minutes
  describe('#transferToCustody', () => {
    describe('success', () => {
      it('should transfer correct amount of selected asset to a custody', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisConfig.setOperator(owner, true)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.999')

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        // Mint tokens first
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)
        const custodyBalanceBefore = await assetContract.balanceOf(custodianAccount.address)

        const transferAmount = ethers.parseEther('60')
        await expect(aegisMintingJUSDContract.transferToCustody(custodianAccount.address, assetAddress, transferAmount)).to.
          emit(aegisMintingJUSDContract, 'CustodyTransfer').
          withArgs(custodianAccount.address, assetAddress, transferAmount)

        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore - transferAmount)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore - transferAmount)
        await expect(assetContract.balanceOf(custodianAccount.address)).eventually.to.be.equal(custodyBalanceBefore + transferAmount)
      })

      it('should transfer correct amount of selected asset except frozen funds to a custody', async () => {
        const [owner, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDContract, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.999')

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        // Mint tokens first
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        const freezeFunds = ethers.parseEther('10')
        await aegisMintingJUSDContract.freezeFunds(assetContract, freezeFunds)

        const transferAmount = collateralAmount - freezeFunds
        await expect(aegisMintingJUSDContract.transferToCustody(custodianAccount.address, assetContract, transferAmount)).to.
          emit(aegisMintingJUSDContract, 'CustodyTransfer').
          withArgs(custodianAccount.address, assetAddress, transferAmount)

        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).to.be.eventually.equal(0)
        await expect(aegisMintingJUSDContract.assetFrozenFunds(assetAddress)).to.be.eventually.equal(freezeFunds)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have COLLATERAL_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).transferToCustody(custodianAccount.address, assetAddress, ethers.parseEther('1'))).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when transferring unsupported asset', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)

        const unknownAsset = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.transferToCustody(custodianAccount.address, unknownAsset.address, ethers.parseEther('1'))).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when transferring to unknown custody wallet', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)

        const unknownCustody = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.transferToCustody(unknownCustody.address, assetAddress, ethers.parseEther('1'))).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidCustodianAddress')
      })

      it('should revert when transferring amount is greater than available balance', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.transferToCustody(custodianAccount.address, assetAddress, ethers.parseEther('1'))).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'NotEnoughFunds')
      })

      it('should revert when transferring amount is greater than available balance with frozen funds', async () => {
        const [owner, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDContract, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.999')

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        // Mint tokens first
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        await aegisMintingJUSDContract.freezeFunds(assetContract, ethers.parseEther('10'))

        await expect(aegisMintingJUSDContract.transferToCustody(custodianAccount.address, assetContract, collateralAmount)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'NotEnoughFunds')
      })
    })
  })

  describe('#forceTransferToCustody', () => {
    describe('success', () => {
      it('should transfer all available funds of selected asset to a custody', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.999')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        const custodianBalanceBefore = await assetContract.balanceOf(custodianAccount)

        await expect(aegisMintingJUSDContract.forceTransferToCustody(custodianAccount, assetAddress)).to.
          emit(aegisMintingJUSDContract, 'ForceCustodyTransfer').
          withArgs(custodianAccount, assetAddress, collateralAmount)

        await expect(assetContract.balanceOf(aegisMintingJUSDContract)).to.be.eventually.equal(0)
        await expect(assetContract.balanceOf(custodianAccount)).to.be.eventually.equal(custodianBalanceBefore + collateralAmount)
      })

      it('should transfer all available funds of selected asset except frozen funds to a custody', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.999')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        const freezeAmount = ethers.parseEther('50')
        await aegisMintingJUSDContract.freezeFunds(assetAddress, freezeAmount)

        const transferAmount = collateralAmount - freezeAmount
        const custodianBalanceBefore = await assetContract.balanceOf(custodianAccount)

        await expect(aegisMintingJUSDContract.forceTransferToCustody(custodianAccount, assetAddress)).to.
          emit(aegisMintingJUSDContract, 'ForceCustodyTransfer').
          withArgs(custodianAccount, assetAddress, transferAmount)

        await expect(assetContract.balanceOf(aegisMintingJUSDContract)).to.be.eventually.equal(freezeAmount)
        await expect(assetContract.balanceOf(custodianAccount)).to.be.eventually.equal(custodianBalanceBefore + transferAmount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have COLLATERAL_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).forceTransferToCustody(custodianAccount.address, assetAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when transferring unsupported asset', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)

        const unknownAsset = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.forceTransferToCustody(custodianAccount.address, unknownAsset.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when transferring to unknown custody wallet', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)

        const unknownCustody = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.forceTransferToCustody(unknownCustody.address, assetAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidCustodianAddress')
      })

      it('should revert when transferring amount greater than available balance', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(COLLATERAL_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.forceTransferToCustody(custodianAccount.address, assetAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'NotEnoughFunds')
      })
    })
  })

  describe('#depositIncome', () => {
    describe('success', () => {
      it('should split YUSD rewards between InsuranceFund and AegisRewards addresses', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisRewardsAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const snapshotId = 'test'
        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.9999')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: owner.address,
          beneficiary: ethers.ZeroAddress,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)
        const insuranceFundYUSDBalanceBefore = await jusdContract.balanceOf(insuranceFundAccount.address)
        const aegisRewardsYUSDBalanceBefore = await jusdContract.balanceOf(aegisRewardsAddress)

        const incomeFee = (yusdAmount * INCOME_FEE_BP) / MAX_BPS
        const aegisRewardsYUSDRewardsAmount = yusdAmount - incomeFee

        await expect(aegisMintingJUSDContract.depositIncome(order, signature)).to.
          emit(jusdContract, 'Transfer').
          withArgs(ethers.ZeroAddress, aegisRewardsAddress, aegisRewardsYUSDRewardsAmount).
          emit(aegisMintingJUSDContract, 'DepositIncome').
          withArgs(snapshotId, owner.address, assetAddress, collateralAmount, aegisRewardsYUSDRewardsAmount, incomeFee, blockTime+1)

        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore + collateralAmount)
        await expect(jusdContract.balanceOf(insuranceFundAccount.address)).eventually.to.be.equal(insuranceFundYUSDBalanceBefore + incomeFee)
        await expect(jusdContract.balanceOf(aegisRewardsAddress)).eventually.to.be.equal(aegisRewardsYUSDBalanceBefore + aegisRewardsYUSDRewardsAmount)
      })

      it('should mint all YUSD rewards to AegisRewards when insuranceFundPercentBP is zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisRewardsAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('100'))
        await assetContract.approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set insurance fund percent to 0
        await aegisMintingJUSDContract.setIncomeFeeBP(0)

        const snapshotId = 'test'
        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.9999')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: owner.address,
          beneficiary: ethers.ZeroAddress,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)
        const aegisRewardsYUSDBalanceBefore = await jusdContract.balanceOf(aegisRewardsAddress)

        await expect(aegisMintingJUSDContract.depositIncome(order, signature)).to.
          emit(aegisMintingJUSDContract, 'DepositIncome').
          withArgs(snapshotId, owner.address, assetAddress, collateralAmount, yusdAmount, 0, blockTime+1)


        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore + collateralAmount)
        await expect(jusdContract.balanceOf(aegisRewardsAddress)).eventually.to.be.equal(aegisRewardsYUSDBalanceBefore + yusdAmount)
      })

      it('should mint all YUSD rewards to AegisRewards when InsuranceFund address is zero', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisRewardsAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set insurance fund to zero address
        await aegisMintingJUSDContract.setInsuranceFundAddress(ethers.ZeroAddress)

        const snapshotId = 'test'
        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('99.9999')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: owner.address,
          beneficiary: ethers.ZeroAddress,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)
        const aegisRewardsYUSDBalanceBefore = await jusdContract.balanceOf(aegisRewardsAddress)

        await expect(aegisMintingJUSDContract.depositIncome(order, signature)).to.
          emit(aegisMintingJUSDContract, 'DepositIncome').
          withArgs(snapshotId, owner.address, assetAddress, collateralAmount, yusdAmount, 0, blockTime+1)


        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore + collateralAmount)
        await expect(jusdContract.balanceOf(aegisRewardsAddress)).eventually.to.be.equal(aegisRewardsYUSDBalanceBefore + yusdAmount)
      })

      it('should not revert when beneficiary address is zero', async () => {
        const [sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          beneficiary: ethers.ZeroAddress,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).not.to.be.reverted
      })
    })

    describe('error', () => {
      it('should be reverted when caller does not have FUNDS_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          beneficiary: ethers.ZeroAddress,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when OrderType is not DEPOSIT_INCOME', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidOrder')
      })

      it('should revert when collateral asset is not supported', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const fakeAsset = await ethers.Wallet.createRandom()

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: fakeAsset.address,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when signed by unknown signer', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const unknownSigner = await ethers.Wallet.createRandom()

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSDByWallet(order, aegisMintingJUSDAddress, unknownSigner)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidSignature')
      })

      it('should revert when collateral amount is zero', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: 0,
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when yusd amount is zero', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const snapshotId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: 0,
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when order expired', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const blockTime = await time.latest()

        const snapshotId = 'test'
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime - 1000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'SignatureExpired')
      })

      it('should revert when order was already processed', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(aegisMintingJUSDContract, ethers.parseEther('100'))

        const blockTime = await time.latest()

        const snapshotId = 'test'
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 1000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.not.reverted

        await expect(aegisMintingJUSDContract.connect(sender).depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidNonce')
      })

      it('should revert when caller is not benefactor', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, sender)

        await assetContract.mint(aegisMintingJUSDContract, ethers.parseEther('100'))

        const blockTime = await time.latest()

        const snapshotId = 'test'
        const order = {
          orderType: OrderType.DEPOSIT_INCOME,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: 0,
          expiry: blockTime + 1000,
          nonce: Date.now(),
          additionalData: encodeString(snapshotId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.depositIncome(order, signature)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidSender')
      })
    })
  })

  describe('#setPreCollateralizedMintLimits', () => {
    describe('success', () => {
      it('should set pre-collateralized mint limits', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)

        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%

        await expect(aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)).to.
          emit(aegisMintingJUSDContract, 'SetPreCollateralizedMintLimits').
          withArgs(periodDuration, maxPeriodAmountBps)

        const preCollateralizedMintLimit = await aegisMintingJUSDContract.preCollateralizedMintLimit()

        expect(preCollateralizedMintLimit[2]).to.be.equal(maxPeriodAmountBps) // maxPeriodAmountBps
        expect(preCollateralizedMintLimit[0]).to.be.equal(periodDuration) // periodDuration
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setPreCollateralizedMintLimits(1, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#mintPreCollateralized', () => {
    describe('success', () => {
      it('should mint when limit is disabled (periodDuration is 0)', async () => {
        const [owner, minter, recipient] = await ethers.getSigners()
        const { aegisMintingJUSDContract, jusdContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)

        // periodDuration is 0 by default, so check is disabled
        const mintAmount = ethers.parseEther('1000')
        const balanceBefore = await jusdContract.balanceOf(recipient.address)

        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, mintAmount))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, mintAmount)

        await expect(jusdContract.balanceOf(recipient.address)).eventually.to.be.equal(balanceBefore + mintAmount)
      })

      it('should mint when amount is within limit', async () => {
        const [owner, minter, recipient, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, jusdContract, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // First mint some JUSD to establish total supply
        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('100')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        // Set pre-collateralized mint limits: 60 seconds period, 10% max per period
        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)

        // Try to mint 5% of total supply (should succeed)
        const totalSupply = await jusdContract.totalSupply()
        const mintAmount = (totalSupply * 500n) / 10000n // 5%
        const balanceBefore = await jusdContract.balanceOf(recipient.address)

        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, mintAmount))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, mintAmount)

        await expect(jusdContract.balanceOf(recipient.address)).eventually.to.be.equal(balanceBefore + mintAmount)
      })

      it('should mint multiple times within limit', async () => {
        const [owner, minter, recipient, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, jusdContract, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // First mint some JUSD to establish total supply
        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('100')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        // Set pre-collateralized mint limits: 60 seconds period, 10% max per period
        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)

        const totalSupply = await jusdContract.totalSupply()
        const maxPeriodAmount = (totalSupply * BigInt(maxPeriodAmountBps)) / 10000n
        const balanceBefore = await jusdContract.balanceOf(recipient.address)

        // First mint - 30% of limit
        const firstMint = (maxPeriodAmount * 30n) / 100n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, firstMint))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, firstMint)

        // Second mint - 40% of limit (total 70%)
        const secondMint = (maxPeriodAmount * 40n) / 100n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, secondMint))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, secondMint)

        // Third mint - 30% of limit (total 100% - exactly at limit)
        const thirdMint = maxPeriodAmount - firstMint - secondMint
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, thirdMint))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, thirdMint)

        await expect(jusdContract.balanceOf(recipient.address)).eventually.to.be.equal(balanceBefore + firstMint + secondMint + thirdMint)
      })

      it('should mint after period expires', async () => {
        const [owner, minter, recipient, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, jusdContract, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // First mint some JUSD to establish total supply
        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('100')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        // Set pre-collateralized mint limits: 60 seconds period, 10% max per period
        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)

        // First mint - use full limit
        const totalSupply = await jusdContract.totalSupply()
        const firstMint = (totalSupply * BigInt(maxPeriodAmountBps)) / 10000n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, firstMint))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, firstMint)

        // Wait for period to expire
        await time.increase(periodDuration + 1)

        // Second mint in new period - should succeed (limit recalculated from new totalSupply)
        const newTotalSupply = await jusdContract.totalSupply()
        const secondMint = (newTotalSupply * BigInt(maxPeriodAmountBps)) / 10000n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, secondMint))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, secondMint)
      })

      it('should mint when limit check is disabled', async () => {
        const [owner, minter, recipient] = await ethers.getSigners()
        const { aegisMintingJUSDContract, jusdContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)

        // Set limit with 0 periodDuration (disabled)
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(0, 1000)

        // Should be able to mint any amount
        const mintAmount = ethers.parseEther('1000')
        const balanceBefore = await jusdContract.balanceOf(recipient.address)

        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, mintAmount))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, mintAmount)

        await expect(jusdContract.balanceOf(recipient.address)).eventually.to.be.equal(balanceBefore + mintAmount)
      })
    })

    describe('error', () => {
      it('should revert when caller is not preCollateralizedMinter', async () => {
        const [owner, notMinter, recipient] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        const mintAmount = ethers.parseEther('100')

        await expect(aegisMintingJUSDContract.connect(notMinter).mintPreCollateralized(recipient.address, mintAmount))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'NotAuthorized')
      })

      it('should revert when amount exceeds limit', async () => {
        const [owner, minter, recipient, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, jusdContract, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // First mint some JUSD to establish total supply
        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('100')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        // Set pre-collateralized mint limits: 60 seconds period, 10% max per period
        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)

        // Try to mint more than limit (11% of total supply)
        const totalSupply = await jusdContract.totalSupply()
        const mintAmount = (totalSupply * 1100n) / 10000n // 11%

        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, mintAmount))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })

      it('should revert when cumulative amount exceeds limit in same period', async () => {
        const [owner, minter, recipient, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, jusdContract, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // First mint some JUSD to establish total supply
        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('100')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        // Set pre-collateralized mint limits: 60 seconds period, 10% max per period
        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)

        const totalSupply = await jusdContract.totalSupply()
        const maxPeriodAmount = (totalSupply * BigInt(maxPeriodAmountBps)) / 10000n

        // First mint - 60% of limit
        const firstMint = (maxPeriodAmount * 60n) / 100n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, firstMint))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, firstMint)

        // Second mint - 50% of limit (total would be 110%, exceeds limit)
        const secondMint = (maxPeriodAmount * 50n) / 100n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, secondMint))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })

      it('should revert when exceeding limit calculated from original totalSupply', async () => {
        const [owner, minter, recipient, sender] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, jusdContract, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setPreCollateralizedMinter(minter.address)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // First mint some JUSD to establish total supply
        await assetContract.mint(sender.address, ethers.parseEther('1000'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const collateralAmount = ethers.parseEther('100')
        const yusdAmount = ethers.parseEther('100')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)
        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).not.to.be.reverted

        // Set pre-collateralized mint limits: 60 seconds period, 10% max per period
        const periodDuration = 60
        const maxPeriodAmountBps = 1000 // 10%
        await aegisMintingJUSDContract.setPreCollateralizedMintLimits(periodDuration, maxPeriodAmountBps)

        const totalSupply = await jusdContract.totalSupply()
        const maxPeriodAmount = (totalSupply * BigInt(maxPeriodAmountBps)) / 10000n

        // Try to mint more than limit based on current totalSupply (should fail)
        const exceedingAmount = maxPeriodAmount + 1n
        await expect(aegisMintingJUSDContract.connect(minter).mintPreCollateralized(recipient.address, exceedingAmount))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })
    })
  })
})