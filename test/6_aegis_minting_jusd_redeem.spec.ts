import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  MAX_BPS,
  FUNDS_MANAGER_ROLE,
  OrderType,
  deployJUSDFixture,
  insuranceFundAccount,
  signOrderJUSD,
  signOrderJUSDByWallet,
  encodeString,
  SETTINGS_MANAGER_ROLE,
  RedeemRequestStatus,
  USD_FEED_ADDRESS,
} from '../utils/helpers'

describe('AegisMintingJUSD', function() {
  this.timeout(300000) // 5 minutes
  describe('#requestRedeem', () => {
    describe('success', () => {
      it('should create RedeemRequest', async function() {
        this.timeout(300000) // 5 minutes
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        const userYUSDBalanceBefore = await jusdContract.balanceOf(sender)
        const contractYUSDBalanceBefore = await jusdContract.balanceOf(aegisMintingJUSDContract)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.
          emit(aegisMintingJUSDContract, 'CreateRedeemRequest').
          withArgs(requestId, sender.address, assetAddress, collateralAmount, yusdAmount).
          emit(jusdContract, 'Transfer').
          withArgs(sender, aegisMintingJUSDContract, yusdAmount)

        const redeemRequest = await aegisMintingJUSDContract.getRedeemRequest(requestId)
        const blockTime = await time.latest()

        await expect(jusdContract.balanceOf(sender)).to.be.eventually.equal(userYUSDBalanceBefore - yusdAmount)
        await expect(jusdContract.balanceOf(aegisMintingJUSDContract)).to.be.eventually.equal(contractYUSDBalanceBefore + yusdAmount)
        expect(redeemRequest.status).to.be.equal(RedeemRequestStatus.PENDING)
        expect(redeemRequest.timestamp).to.be.equal(blockTime)
        expect(redeemRequest.order.orderType).to.be.equal(redeemOrder.orderType)
        expect(redeemRequest.order.userWallet).to.be.equal(redeemOrder.userWallet)
        expect(redeemRequest.order.collateralAsset).to.be.equal(redeemOrder.collateralAsset)
        expect(redeemRequest.order.collateralAmount).to.be.equal(redeemOrder.collateralAmount)
        expect(redeemRequest.order.yusdAmount).to.be.equal(redeemOrder.yusdAmount)
        expect(redeemRequest.order.slippageAdjustedAmount).to.be.equal(redeemOrder.slippageAdjustedAmount)
        expect(redeemRequest.order.expiry).to.be.equal(redeemOrder.expiry)
        expect(redeemRequest.order.additionalData).to.be.equal(redeemOrder.additionalData)
      })

      it('should create RedeemRequest within limits', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // Set limits
        const redeemMaxAmount = ethers.parseEther('10')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setRedeemLimits(60, redeemMaxAmount)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        const redeemLimitBefore = await aegisMintingJUSDContract.redeemLimit()

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        const redeemLimitAfter = await aegisMintingJUSDContract.redeemLimit()
        expect(redeemLimitAfter.currentPeriodTotalAmount).to.be.equal(redeemLimitBefore.currentPeriodTotalAmount + yusdAmount)
      })

      it('should reset redeem limit counters at the beginning of new period', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        // Set limits
        const redeemMaxAmount = ethers.parseEther('10')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setRedeemLimits(60, redeemMaxAmount)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        {
          const requestId = 'test'
          const collateralAmount = ethers.parseEther('10')
          const yusdAmount = ethers.parseEther('9.99')
          const redeemOrder = {
            orderType: OrderType.REDEEM,
            userWallet: sender.address,
            collateralAsset: assetAddress,
            collateralAmount: collateralAmount,
            yusdAmount: yusdAmount,
            slippageAdjustedAmount: yusdAmount,
            expiry: (await time.latest()) + 10000,
            nonce: Date.now(),
            additionalData: encodeString(requestId),
          }
          const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

          await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted
        }

        await time.increase(60)

        const requestId = 'test2'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        let blockTime = await time.latest()
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        blockTime = await time.latest()
        const redeemLimit = await aegisMintingJUSDContract.redeemLimit()

        expect(redeemLimit.currentPeriodTotalAmount).to.be.equal(yusdAmount)
        expect(redeemLimit.currentPeriodStartTime).to.be.equal(blockTime)
      })
    })

    describe('error', () => {
      it('should revert when OrderType is not REDEEM', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const requestId = 'test'
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
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidOrder')
      })

      it('should revert when collateral asset is not supported', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const fakeAsset = await ethers.Wallet.createRandom()

        const requestId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: fakeAsset.address,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when signed by unknown signer', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const unknownSigner = await ethers.Wallet.createRandom()

        const requestId = 'test'
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
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSDByWallet(order, aegisMintingJUSDAddress, unknownSigner)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidSignature')
      })

      it('should revert when collateral amount is zero', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const requestId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: 0,
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when yusd amount is zero', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const requestId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: 0,
          slippageAdjustedAmount: 0,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when order expired', async () => {
        const [, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const requestId = 'test'
        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('1'),
          yusdAmount: ethers.parseEther('1'),
          slippageAdjustedAmount: ethers.parseEther('1'),
          expiry: blockTime - 1000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'SignatureExpired')
      })

      it('should revert when redeem is paused', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](owner, true)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.setRedeemPaused(true)

        const blockTime = await time.latest()
        const order = {
          orderType: OrderType.REDEEM,
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

        await expect(aegisMintingJUSDContract.requestRedeem(order, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'RedeemPaused')
      })

      it('should revert when benefactor is not in whitelist', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        // Mint asset to sender
        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Mint asset to owner
        await assetContract.mint(owner.address, ethers.parseEther('100'))
        await assetContract.connect(owner).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const requestId = 'test'
        const blockTime = await time.latest()
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'NotWhitelisted')
      })

      it('should revert when RedeemRequest with id already exist', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when redeeming amount exceeds max amount within period', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set limits
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setRedeemLimits(60, ethers.parseEther('15'))

        // Mint YUSD to sender
        {
          const blockTime = await time.latest()

          const mintOrder = {
            orderType: OrderType.MINT,
            userWallet: sender.address,
            collateralAsset: assetAddress,
            collateralAmount: ethers.parseEther('50'),
            yusdAmount: ethers.parseEther('50'),
            slippageAdjustedAmount: ethers.parseEther('50'),
            expiry: blockTime + 10000,
            nonce: Date.now(),
            additionalData: encodeString(''),
          }
          const signature = await signOrderJUSD(mintOrder, aegisMintingJUSDAddress)

          await expect(aegisMintingJUSDContract.connect(sender).mint(mintOrder, signature)).not.to.be.reverted
        }

        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        // First redeem
        {
          const requestId = 'test'
          await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('10'))

          const redeemOrder = {
            orderType: OrderType.REDEEM,
            userWallet: sender.address,
            collateralAsset: assetAddress,
            collateralAmount: ethers.parseEther('10'),
            yusdAmount: ethers.parseEther('9.99'),
            slippageAdjustedAmount: ethers.parseEther('9.99'),
            expiry: (await time.latest()) + 10000,
            nonce: Date.now(),
            additionalData: encodeString(requestId),
          }
          const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

          await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted
        }

        const requestId = 'test2'
        await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('10'))

        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })

      it('should revert when redeeming amount exceeds max amount at the beginning of period', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Mint asset to owner
        await assetContract.mint(owner, ethers.parseEther('100'))
        await assetContract.connect(owner).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        // Set limits
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setRedeemLimits(60, ethers.parseEther('15'))

        // Mint YUSD to sender
        {
          const blockTime = await time.latest()

          const mintOrder = {
            orderType: OrderType.MINT,
            userWallet: sender.address,
            collateralAsset: assetAddress,
            collateralAmount: ethers.parseEther('10'),
            yusdAmount: ethers.parseEther('50'),
            slippageAdjustedAmount: ethers.parseEther('50'),
            expiry: blockTime + 10000,
            nonce: Date.now(),
            additionalData: encodeString(''),
          }
          const signature = await signOrderJUSD(mintOrder, aegisMintingJUSDAddress)

          await expect(aegisMintingJUSDContract.connect(sender).mint(mintOrder, signature)).not.to.be.reverted
        }

        // Approve YUSD to be locked by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('10'))

        const requestId = 'test2'
        await assetContract.mint(aegisMintingJUSDAddress, ethers.parseEther('16'))

        const blockTime = await time.latest()
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('16'),
          slippageAdjustedAmount: ethers.parseEther('16'),
          expiry: blockTime + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'LimitReached')
      })

      it('should revert when calculated collateral amount by Chainlink price is less than min receive amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, assetContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '100100000')

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'PriceSlippage')
      })

      it('should revert when calculated collateral amount by AegisOracleJUSD price is less than min receive amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, assetContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        // Set feed price to 1 asset/USD to pass check
        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '100000000')

        const aegisOracle = await ethers.deployContract('AegisOracleJUSD', [[owner], owner])
        await aegisMintingJUSDContract.setAegisOracleAddress(aegisOracle)

        await aegisOracle.updateJUSDPrice('99963000')

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'PriceSlippage')
      })

      it('should revert when caller is not benefator', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.requestRedeem(redeemOrder, signature)).to.be.revertedWithCustomError(aegisMintingJUSDContract, 'InvalidSender')
      })
    })
  })

  describe('#approveRedeemRequest', () => {
    describe('success', () => {
      it('should approve RedeemRequest', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, assetContract, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const yusdAmount = ethers.parseEther('9.99')
        const collateralAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        const custodianAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        const untrackedAvailableAssetBalanceBefore = await aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)
        const contractYUSDBalanceBefore = await jusdContract.balanceOf(aegisMintingJUSDContract)
        const userAssetBalanceBefore = await assetContract.balanceOf(sender)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'ApproveRedeemRequest').
          withArgs(requestId, owner.address, sender.address, assetAddress, collateralAmount, yusdAmount, 0).
          emit(jusdContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, ethers.ZeroAddress, yusdAmount).
          emit(assetContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, sender, collateralAmount)

        const redeemRequest = await aegisMintingJUSDContract.getRedeemRequest(requestId)

        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).to.be.eventually.equal(custodianAvailableAssetBalanceBefore)
        await expect(aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)).to.be.eventually.equal(untrackedAvailableAssetBalanceBefore - collateralAmount)
        await expect(jusdContract.balanceOf(aegisMintingJUSDContract)).to.be.eventually.equal(contractYUSDBalanceBefore - yusdAmount)
        await expect(assetContract.balanceOf(sender)).to.be.eventually.equal(userAssetBalanceBefore + collateralAmount)
        expect(redeemRequest.status).to.be.equal(RedeemRequestStatus.APPROVED)
      })

      it('should approve RedeemRequest and take fee', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, assetContract, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feeBP = 500n

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setRedeemFeeBP(feeBP)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const yusdAmount = ethers.parseEther('9.99')
        const collateralAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        const custodianAvailableAssetBalanceBefore = await aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        const untrackedAvailableAssetBalanceBefore = await aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)
        const contractYUSDBalanceBefore = await jusdContract.balanceOf(aegisMintingJUSDContract)
        const userAssetBalanceBefore = await assetContract.balanceOf(sender)

        const fee = (yusdAmount * feeBP) / MAX_BPS
        const receiveYUSDAmount = yusdAmount - fee

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'ApproveRedeemRequest').
          withArgs(requestId, owner.address, sender.address, assetAddress, collateralAmount, receiveYUSDAmount, fee).
          emit(jusdContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, ethers.ZeroAddress, receiveYUSDAmount).
          emit(jusdContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, insuranceFundAccount, fee).
          emit(assetContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, sender, collateralAmount)

        const redeemRequest = await aegisMintingJUSDContract.getRedeemRequest(requestId)

        await expect(aegisMintingJUSDContract.custodyAvailableAssetBalance(assetAddress)).to.be.eventually.equal(custodianAvailableAssetBalanceBefore)
        await expect(aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)).to.be.eventually.equal(untrackedAvailableAssetBalanceBefore - collateralAmount)
        await expect(jusdContract.balanceOf(aegisMintingJUSDContract)).to.be.eventually.equal(contractYUSDBalanceBefore - yusdAmount)
        await expect(assetContract.balanceOf(sender)).to.be.eventually.equal(userAssetBalanceBefore + collateralAmount)
        expect(redeemRequest.status).to.be.equal(RedeemRequestStatus.APPROVED)
      })

      it('should approve RedeemRequest and transfer smallest collateral amount by Chainlink price', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '100000000')

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount - ethers.parseEther('1'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        const chainlinkPrice = 100100000n
        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, chainlinkPrice)

        const chainlinkCollateralAmount = yusdAmount * 10n ** 8n / chainlinkPrice
        const untrackedAvailableAssetBalanceBefore = await aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)
        const userAssetBalanceBefore = await assetContract.balanceOf(sender)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'ApproveRedeemRequest').
          withArgs(requestId, owner.address, sender.address, assetAddress, chainlinkCollateralAmount, yusdAmount, 0).
          emit(jusdContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, ethers.ZeroAddress, yusdAmount).
          emit(assetContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, sender, chainlinkCollateralAmount)

        await expect(aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)).to.be.eventually.equal(untrackedAvailableAssetBalanceBefore - chainlinkCollateralAmount)
        await expect(assetContract.balanceOf(sender)).to.be.eventually.equal(userAssetBalanceBefore + chainlinkCollateralAmount)
      })

      it('should approve RedeemRequest and transfer smallest collateral amount of initial, Chainlink price based and AegisOracle price based', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '100000000')

        const aegisOracle = await ethers.deployContract('AegisOracleJUSD', [[owner], owner])
        await aegisOracle.setOperator(owner, true)
        await aegisMintingJUSDContract.setAegisOracleAddress(aegisOracle)

        await aegisOracle.updateJUSDPrice('100000000')

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount - ethers.parseEther('1'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        const chainlinkPrice = 100100000n
        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, chainlinkPrice)

        const oraclePrice = 99963000n
        await aegisOracle.updateJUSDPrice(oraclePrice)

        const chainlinkCollateralAmount = yusdAmount * 10n ** 8n / chainlinkPrice
        const oracleCollateralAmount = yusdAmount * 10n ** 8n / (chainlinkPrice * 10n ** 8n / oraclePrice)
        let smalletCollateralAmount = collateralAmount
        if (chainlinkCollateralAmount < smalletCollateralAmount) {
          smalletCollateralAmount = chainlinkCollateralAmount
        }
        if (oracleCollateralAmount < smalletCollateralAmount) {
          smalletCollateralAmount = oracleCollateralAmount
        }

        const untrackedAvailableAssetBalanceBefore = await aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)
        const userAssetBalanceBefore = await assetContract.balanceOf(sender)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'ApproveRedeemRequest').
          withArgs(requestId, owner.address, sender.address, assetAddress, smalletCollateralAmount, yusdAmount, 0).
          emit(jusdContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, ethers.ZeroAddress, yusdAmount).
          emit(assetContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, sender, smalletCollateralAmount)

        await expect(aegisMintingJUSDContract.untrackedAvailableAssetBalance(assetAddress)).to.be.eventually.equal(untrackedAvailableAssetBalanceBefore - smalletCollateralAmount)
        await expect(assetContract.balanceOf(sender)).to.be.eventually.equal(userAssetBalanceBefore + smalletCollateralAmount)
      })

      it('should reject RedeemRequest when underlying order is expired', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const orderExpiry = (await time.latest()) + 10000
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: orderExpiry,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        await time.increase(orderExpiry)

        await expect(aegisMintingJUSDContract.approveRedeemRequest('test', collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'RejectRedeemRequest').
          withArgs(requestId, owner.address, sender.address, yusdAmount)
      })

      it('should reject RedeemRequest when collateral amount is less than min receive amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        await expect(aegisMintingJUSDContract.approveRedeemRequest('test', 1)).to.
          emit(aegisMintingJUSDContract, 'RejectRedeemRequest').
          withArgs(requestId, owner.address, sender.address, yusdAmount)
      })

      it('should reject RedeemRequest when calculated collateral amount by Chainlink price is less than min receive amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '99963000')

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '100100000')

        await expect(aegisMintingJUSDContract.approveRedeemRequest('test', collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'RejectRedeemRequest').
          withArgs(requestId, owner.address, sender.address, yusdAmount)
      })

      it('should reject RedeemRequest when calculated collateral amount by AegisOracleJUSD price is less than min receive amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        // Mint asset funds
        await assetContract.mint(aegisMintingJUSDContract, collateralAmount)

        const feedRegistry = await ethers.deployContract('FeedRegistry')
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setFeedRegistryAddress(feedRegistry)

        await feedRegistry.setPrice(assetContract, USD_FEED_ADDRESS, '100000000')

        const aegisOracle = await ethers.deployContract('AegisOracleJUSD', [[owner], owner])
        await aegisOracle.setOperator(owner, true)
        await aegisMintingJUSDContract.setAegisOracleAddress(aegisOracle)

        await aegisOracle.updateJUSDPrice('99963000')

        await expect(aegisMintingJUSDContract.approveRedeemRequest('test', collateralAmount)).to.
          emit(aegisMintingJUSDContract, 'RejectRedeemRequest').
          withArgs(requestId, owner.address, sender.address, yusdAmount)
      })
    })

    describe('error', () => {
      it('should be reverted when caller does not have FUNDS_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract } = await loadFixture(deployJUSDFixture)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        await expect(aegisMintingJUSDContract.connect(sender).approveRedeemRequest('test', 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when RedeemRequest does not exist', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.approveRedeemRequest('test', 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when contract has zero asset balance', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'NotEnoughFunds')
      })

      it('should revert when contract has only asset funds for custodian', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, assetContract, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        const collateralAmount = ethers.parseEther('10')

        await assetContract.mint(sender, collateralAmount)
        await assetContract.connect(sender).approve(aegisMintingJUSDContract, collateralAmount)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        const yusdAmount = ethers.parseEther('9.99')
        // Mint YUSD
        {
          const order = {
            orderType: OrderType.MINT,
            userWallet: sender.address,
            collateralAsset: assetAddress,
            collateralAmount: collateralAmount,
            yusdAmount: yusdAmount,
            slippageAdjustedAmount: yusdAmount,
            expiry: (await time.latest()) + 10000,
            nonce: Date.now(),
            additionalData: encodeString(''),
          }
          const signature = await signOrderJUSD(order, aegisMintingJUSDAddress)

          await expect(aegisMintingJUSDContract.connect(sender).mint(order, signature)).to.be.not.reverted
        }

        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: collateralAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'NotEnoughFunds')
      })

      it('should revert when RedeemRequest already processed', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.rejectRedeemRequest(requestId)).to.not.reverted

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when passed zero amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, 0)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when passed amount is greter than order amount', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.approveRedeemRequest(requestId, collateralAmount + 1n)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })

      it('should revert when paused', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.setRedeemPaused(true)

        await expect(aegisMintingJUSDContract.approveRedeemRequest('test', 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'RedeemPaused')
      })
    })
  })

  describe('#rejectRedeemRequest', () => {
    describe('success', () => {
      it('should reject pending RedeemRequest', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const collateralAmount = ethers.parseEther('10')
        const yusdAmount = ethers.parseEther('9.99')
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: collateralAmount,
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        const userYUSDBalanceBefore = await jusdContract.balanceOf(sender)
        const contractYUSDBalanceBefore = await jusdContract.balanceOf(aegisMintingJUSDContract)

        await expect(aegisMintingJUSDContract.rejectRedeemRequest(requestId)).to.
          emit(aegisMintingJUSDContract, 'RejectRedeemRequest').
          withArgs(requestId, owner.address, sender.address, yusdAmount).
          emit(jusdContract, 'Transfer').
          withArgs(aegisMintingJUSDContract, sender, yusdAmount)

        const redeemRequest = await aegisMintingJUSDContract.getRedeemRequest(requestId)

        await expect(jusdContract.balanceOf(sender)).to.eventually.equal(userYUSDBalanceBefore + yusdAmount)
        await expect(jusdContract.balanceOf(aegisMintingJUSDContract)).to.eventually.equal(contractYUSDBalanceBefore - yusdAmount)
        expect(redeemRequest.status).to.equal(RedeemRequestStatus.REJECTED)
      })
    })

    describe('error', () => {
      it('should be reverted when caller does not have FUNDS_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const sender = signers[1]

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract } = await loadFixture(deployJUSDFixture)

        await assetContract.mint(sender.address, ethers.parseEther('100'))
        await assetContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('100'))

        await expect(aegisMintingJUSDContract.connect(sender).rejectRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when RedeemRequest does not exist', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.rejectRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when RedeemRequest already processed', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.rejectRedeemRequest('test')).to.not.reverted

        await expect(aegisMintingJUSDContract.rejectRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when paused', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)
        await aegisMintingJUSDContract.setRedeemPaused(true)

        await expect(aegisMintingJUSDContract.rejectRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'RedeemPaused')
      })
    })
  })

  describe('#withdrawRedeemRequest', () => {
    describe('success', () => {
      it('should withdraw expired deposit redeem', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const yusdAmount = ethers.parseEther('9.99')
        const orderExpiry = (await time.latest()) + 10000
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: yusdAmount,
          slippageAdjustedAmount: yusdAmount,
          expiry: orderExpiry,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await time.increase(orderExpiry)

        const benefactorYUSDBalanceBefore = await jusdContract.balanceOf(sender)

        await expect(aegisMintingJUSDContract.withdrawRedeemRequest(requestId)).to.
          emit(aegisMintingJUSDContract, 'WithdrawRedeemRequest').
          withArgs(requestId, sender.address, yusdAmount)

        await expect(assetContract.balanceOf(aegisMintingJUSDAddress)).to.be.eventually.equal(0)
        await expect(jusdContract.balanceOf(sender)).to.be.eventually.equal(benefactorYUSDBalanceBefore + yusdAmount)
      })
    })

    describe('error', () => {
      it('should revert when RedeemRequest does not exist', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.withdrawRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when RedeemRequest already processed', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.rejectRedeemRequest(requestId)

        await expect(aegisMintingJUSDContract.connect(sender).withdrawRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when RedeemRequest\'s underlying order is not expired', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await expect(aegisMintingJUSDContract.withdrawRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidRedeemRequest')
      })

      it('should revert when redeem is paused', async () => {
        const [owner, sender] = await ethers.getSigners()

        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetAddress, jusdContract, aegisConfig } = await loadFixture(deployJUSDFixture)

        await aegisConfig['whitelistAddress(address,bool)'](sender, true)

        await jusdContract.setMinter(owner)
        await jusdContract.mint(sender, ethers.parseEther('100'))
        await jusdContract.setMinter(aegisMintingJUSDAddress)
        // Approve YUSD to be sent by AegisMinting contract from sender
        await jusdContract.connect(sender).approve(aegisMintingJUSDAddress, ethers.parseEther('1000'))

        const requestId = 'test'
        const redeemOrder = {
          orderType: OrderType.REDEEM,
          userWallet: sender.address,
          collateralAsset: assetAddress,
          collateralAmount: ethers.parseEther('10'),
          yusdAmount: ethers.parseEther('9.99'),
          slippageAdjustedAmount: ethers.parseEther('9.99'),
          expiry: (await time.latest()) + 10000,
          nonce: Date.now(),
          additionalData: encodeString(requestId),
        }
        const signature = await signOrderJUSD(redeemOrder, aegisMintingJUSDAddress)

        await expect(aegisMintingJUSDContract.connect(sender).requestRedeem(redeemOrder, signature)).to.be.not.reverted

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)
        await aegisMintingJUSDContract.setRedeemPaused(true)

        await expect(aegisMintingJUSDContract.connect(sender).withdrawRedeemRequest('test')).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'RedeemPaused')
      })
    })
  })
})
