import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  MAX_BPS,
  OrderType,
  deployJUSDFixture,
  insuranceFundAccount,
  signOrderJUSD,
  signOrderJUSDByWallet,
  encodeString,
  SETTINGS_MANAGER_ROLE,
  USD_FEED_ADDRESS,
} from '../utils/helpers'

describe('AegisMintingJUSD', function() {
  this.timeout(300000) // 5 minutes
  describe('#mint', () => {
    describe('success', () => {
      it('should mint correct amount of JUSD in exchange for collateral asset', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.999')

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

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)

        const senderYUSDBalanceBefore = await jusdContract.balanceOf(sender.address)
        const senderAssetBalanceBefore = await assetContract.balanceOf(sender.address)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.
          emit(aegisMintingJUSDContract, 'Mint').
          withArgs(sender.address, order.collateralAsset, order.collateralAmount, order.yusdAmount, 0)

        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore + collateralAmount)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore + collateralAmount)
        await expect(jusdContract.balanceOf(sender.address)).eventually.to.be.equal(senderYUSDBalanceBefore + yusdAmount)
        await expect(assetContract.balanceOf(sender.address)).eventually.to.be.equal(senderAssetBalanceBefore - collateralAmount)
      })

      it('should mint when benefactor is in whitelist', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.999')

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

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)

        const senderYUSDBalanceBefore = await jusdContract.balanceOf(sender.address)
        const senderAssetBalanceBefore = await assetContract.balanceOf(sender.address)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.
          emit(aegisMintingJUSDContract, 'Mint').
          withArgs(sender.address, order.collateralAsset, order.collateralAmount, order.yusdAmount, 0)

        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore + collateralAmount)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore + collateralAmount)
        await expect(jusdContract.balanceOf(sender.address)).eventually.to.be.equal(senderYUSDBalanceBefore + yusdAmount)
        await expect(assetContract.balanceOf(sender.address)).eventually.to.be.equal(senderAssetBalanceBefore - collateralAmount)
      })

      it('should mint correct amount of YUSD in exchange for collateral asset and take fee', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feeBP = 500n
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.setMintFeeBP(feeBP)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.999')
        const feeAmount = yusdAmount * feeBP / MAX_BPS
        const mintAmount = yusdAmount - feeAmount

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

        const mintingContractAssetBalanceBefore = await assetContract.balanceOf(aegisMintingJUSDAddress)
        const custodyAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)

        const senderYUSDBalanceBefore = await jusdContract.balanceOf(sender.address)
        const senderAssetBalanceBefore = await assetContract.balanceOf(sender.address)
        const insuranceFundYUSDBalanceBefore = await jusdContract.balanceOf(insuranceFundAccount.address)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.
          emit(aegisMintingJUSDContract, 'Mint').
          withArgs(sender, order.collateralAsset, order.collateralAmount, mintAmount, feeAmount).
          emit(jusdContract, 'Transfer').
          withArgs(ethers.ZeroAddress, insuranceFundAccount.address, feeAmount)

        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).eventually.to.be.equal(mintingContractAssetBalanceBefore + collateralAmount)
        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).eventually.to.be.equal(custodyAvailableAssetBalanceBefore + collateralAmount)
        await expect(jusdContract.balanceOf(sender.address)).eventually.to.be.equal(senderYUSDBalanceBefore + mintAmount)
        await expect(assetContract.balanceOf(sender.address)).eventually.to.be.equal(senderAssetBalanceBefore - collateralAmount)
        await expect(jusdContract.balanceOf(insuranceFundAccount.address)).eventually.to.be.equal(insuranceFundYUSDBalanceBefore + feeAmount)
      })

      it('should mint within limits', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set limits
        const mintMaxAmount = ethers.parseEther('10')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setMintLimits(60, mintMaxAmount)

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.999')

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

        const mintLimitBefore = await aegisMintingJUSDContract.mintLimit()

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.not.reverted

        const mintLimitAfter = await aegisMintingJUSDContract.mintLimit()
        expect(mintLimitAfter.currentPeriodTotalAmount).to.be.equal(mintLimitBefore.currentPeriodTotalAmount + yusdAmount)
      })

      it('should reset mint limit counters at the beginning of new period', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set limits
        const mintMaxAmount = ethers.parseEther('10')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setMintLimits(60, mintMaxAmount)

        const collateralAmount = ethers.parseEther('10')
        let blockTime = await time.latest()

        {
          const yusdAmount = ethers.parseEther('9.999')

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

          await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.not.reverted
        }

        await time.increase(60)

        const yusdAmount = ethers.parseEther('8')

        blockTime = await time.latest()
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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.not.reverted

        blockTime = await time.latest()

        const mintLimit = await aegisMintingJUSDContract.mintLimit()

        expect(mintLimit.currentPeriodTotalAmount).to.be.equal(yusdAmount)
        expect(mintLimit.currentPeriodStartTime).to.be.equal(blockTime)
      })
    })

    describe('error', () => {
      it('should revert when OrderType is not MINT', async () => {
        const [,sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidOrder')
      })

      it('should revert when collateral asset is not supported', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const fakeAsset = await ethers.Wallet.createRandom()

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: fakeAsset.address,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when signer by unknown signer', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const unknownSigner = await ethers.Wallet.createRandom()

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSDByWallet(order, aegisMintingJUSDAddress, unknownSigner)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidSignature')
      })

      it('should revert when collateral amount is zero', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: 0,
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when yusd amount is zero', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: 0,
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when order expired', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const blockTime = await time.latest()

        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime - 1000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'SignatureExpired')
      })

      it('should revert when paused', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](owner, true)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.setMintPaused(true)

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: owner.address,
          beneficiary: owner.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime - 1000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'MintPaused')
      })

      it('should revert when minting amount exceeds max amount within period', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set limits
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setMintLimits(60, ethers.parseEther('15'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.999')

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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.not.reverted

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })

      it('should revert when minting amount exceeds max amount at the beginning of period', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set limits
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setMintLimits(60, ethers.parseEther('15'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('16')

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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })

      it('should revert when benefactor is not in whitelist', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress } = await loadFixture(deployJUSDFixture)

        const yusdAmount = ethers.parseEther('9.999')
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.MINT,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(''),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'NotWhitelisted')
      })

      it('should revert when Chainlink asset price is less than 0', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '0')

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')

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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWith('Invalid price')
      })

      it('should revert when Chainlink asset price is stale', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '99963000')
        await feedRegistry.setUpdatedAt((await time.latest()) - 86400)

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')

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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWith('Stale price')
      })

      it('should revert when calculated YUSD amount by Chainlink price is less than min receive amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '99963000')

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')

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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'PriceSlippage')
      })

      it('should revert when order was already processed', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')

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

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.not.reverted

        await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidNonce')
      })

      it('should revert when caller is not benefactor', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')

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

        await expect(aegisMintingJUSDContract.mint(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidSender')
      })
    })
  })
})
