import { ethers } from 'hardhat'
import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  SETTINGS_MANAGER_ROLE,
  MAX_BPS,
  custodianAccount,
  deployJUSDFixture,
  FUNDS_MANAGER_ROLE,
  trustedSignerAccount,
} from '../utils/helpers'

describe('AegisMintingJUSD', () => {
  describe('#setAegisRewardsAddress', () => {
    describe('success', () => {
      it('should update AegisRewards address', async () => {
        const [owner] = await ethers.getSigners()
        const aegisRewardsAccount = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setAegisRewardsAddress(aegisRewardsAccount.address)).to.
          emit(aegisMintingJUSDContract, 'SetAegisRewardsAddress').
          withArgs(aegisRewardsAccount.address)

        await expect(aegisMintingJUSDContract.aegisRewards()).eventually.to.be.equal(aegisRewardsAccount.address)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const aegisRewardsAccount = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setAegisRewardsAddress(aegisRewardsAccount.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when new AegisRewards is zero address', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setAegisRewardsAddress(ethers.ZeroAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'ZeroAddress')
      })
    })
  })

  describe('#setInsuranceFundAddress', () => {
    describe('success', () => {
      it('should update InsuranceFund address', async () => {
        const [owner] = await ethers.getSigners()
        const insuranceFundAccount = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setInsuranceFundAddress(insuranceFundAccount.address)).to.
          emit(aegisMintingJUSDContract, 'SetInsuranceFundAddress').
          withArgs(insuranceFundAccount.address)

        await expect(aegisMintingJUSDContract.insuranceFundAddress()).eventually.to.be.equal(insuranceFundAccount.address)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const insuranceFundAccount = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setInsuranceFundAddress(insuranceFundAccount.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#setIncomeFeeBP', () => {
    describe('success', () => {
      it('should update insurance fund percent', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        const newPercentBP = 3_000
        await expect(aegisMintingJUSDContract.setIncomeFeeBP(newPercentBP)).to.
          emit(aegisMintingJUSDContract, 'SetIncomeFeeBP').
          withArgs(newPercentBP)

        await expect(aegisMintingJUSDContract.incomeFeeBP()).eventually.to.be.equal(newPercentBP)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setIncomeFeeBP(2000)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when value greater than 50%', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setIncomeFeeBP((MAX_BPS / 2n) + 1n)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidPercentBP')
      })
    })
  })

  describe('#addSupportedAsset', () => {
    describe('success', () => {
      it('should add new asset address', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)
        const newAssetContract = await ethers.deployContract('TestToken', ['Test', 'TST', 18])
        const newAssetAddress = await newAssetContract.getAddress()

        const heartbeat = 86400
        await expect(aegisMintingJUSDContract.addSupportedAsset(newAssetAddress, heartbeat)).to.
          emit(aegisMintingJUSDContract, 'AssetAdded').
          withArgs(newAssetAddress, heartbeat)

        await expect(aegisMintingJUSDContract.isSupportedAsset(newAssetAddress)).eventually.to.be.equal(true)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have DEFAULT_ADMIN_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const newAsset = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).addSupportedAsset(newAsset.address, 86400)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when new asset address is zero', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.addSupportedAsset(ethers.ZeroAddress, 86400)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when new asset address is YUSD address', async () => {
        const { aegisMintingJUSDContract, jusdAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.addSupportedAsset(jusdAddress, 86400)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when adding existing asset address', async () => {
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.addSupportedAsset(assetAddress, 86400)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })
    })
  })

  describe('#removeSupportedAsset', () => {
    describe('success', () => {
      it('should remove supported asset address', async () => {
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.removeSupportedAsset(assetAddress)).to.
          emit(aegisMintingJUSDContract, 'AssetRemoved').
          withArgs(assetAddress)

        await expect(aegisMintingJUSDContract.isSupportedAsset(assetAddress)).eventually.to.be.equal(false)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have DEFAULT_ADMIN_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).removeSupportedAsset(assetAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when removing unknown asset', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        const unknownAsset = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.removeSupportedAsset(unknownAsset.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })
    })
  })

  describe('#addCustodianAddress', () => {
    describe('success', () => {
      it('should add new custodian address', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)
        const newCustodianAccount = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.addCustodianAddress(newCustodianAccount.address)).to.
          emit(aegisMintingJUSDContract, 'CustodianAddressAdded').
          withArgs(newCustodianAccount.address)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have DEFAULT_ADMIN_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const newCustodian = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).addCustodianAddress(newCustodian.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when new custodian address is zero', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.addCustodianAddress(ethers.ZeroAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidCustodianAddress')
      })

      it('should revert when new custodian address is YUSD address', async () => {
        const { aegisMintingJUSDContract, jusdAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.addCustodianAddress(jusdAddress)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidCustodianAddress')
      })

      it('should revert when adding existing custodian address', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.addCustodianAddress(custodianAccount.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidCustodianAddress')
      })
    })
  })

  describe('#removeCustodianAddress', () => {
    describe('success', () => {
      it('should remove custodian address', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.removeCustodianAddress(custodianAccount.address)).to.
          emit(aegisMintingJUSDContract, 'CustodianAddressRemoved').
          withArgs(custodianAccount.address)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have DEFAULT_ADMIN_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).removeCustodianAddress(custodianAccount.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when removing unknown custodian', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        const unknownCustodianAccount = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.removeCustodianAddress(unknownCustodianAccount.address)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidCustodianAddress')
      })
    })
  })

  describe('#setMintPaused', () => {
    describe('success', () => {
      it('should pause mint', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setMintPaused(true)).to.
          emit(aegisMintingJUSDContract, 'MintPauseChanged').
          withArgs(true)

        await expect(aegisMintingJUSDContract.mintPaused()).eventually.to.be.equal(true)
      })

      it('should unpause mint', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await aegisMintingJUSDContract.setMintPaused(true)

        await expect(aegisMintingJUSDContract.setMintPaused(false)).to.
          emit(aegisMintingJUSDContract, 'MintPauseChanged').
          withArgs(false)

        await expect(aegisMintingJUSDContract.mintPaused()).eventually.to.be.equal(false)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have SETTINGS_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setMintPaused(true)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#setRedeemPaused', () => {
    describe('success', () => {
      it('should pause redeem', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setRedeemPaused(true)).to.
          emit(aegisMintingJUSDContract, 'RedeemPauseChanged').
          withArgs(true)

        await expect(aegisMintingJUSDContract.redeemPaused()).eventually.to.be.equal(true)
      })

      it('should unpause redeem', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await aegisMintingJUSDContract.setRedeemPaused(true)

        await expect(aegisMintingJUSDContract.setRedeemPaused(false)).to.
          emit(aegisMintingJUSDContract, 'RedeemPauseChanged').
          withArgs(false)

        await expect(aegisMintingJUSDContract.redeemPaused()).eventually.to.be.equal(false)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have SETTINGS_MANAGER_ROLE role', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setRedeemPaused(true)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#setMintFeeBP', () => {
    describe('success', () => {
      it('should update mint fee bp', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        const bp = 300
        await expect(aegisMintingJUSDContract.setMintFeeBP(bp)).to.
          emit(aegisMintingJUSDContract, 'SetMintFeeBP').
          withArgs(bp)

        await expect(aegisMintingJUSDContract.mintFeeBP()).eventually.to.be.equal(bp)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setMintFeeBP(500)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when value greater than 50%', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setMintFeeBP((MAX_BPS / 2n) + 1n)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidPercentBP')
      })
    })
  })

  describe('#setRedeemFeeBP', () => {
    describe('success', () => {
      it('should update redeem fee bp', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        const bp = 300
        await expect(aegisMintingJUSDContract.setRedeemFeeBP(bp)).to.
          emit(aegisMintingJUSDContract, 'SetRedeemFeeBP').
          withArgs(bp)

        await expect(aegisMintingJUSDContract.redeemFeeBP()).eventually.to.be.equal(bp)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setRedeemFeeBP(500)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when value greater than 50%', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner)

        await expect(aegisMintingJUSDContract.setRedeemFeeBP((MAX_BPS / 2n) + 1n)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidPercentBP')
      })
    })
  })

  describe('#freezeFunds', () => {
    describe('success', () => {
      it('should freeze funds', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)

        const freezeAmount = 1n
        const frozenFundsBefore = await aegisMintingJUSDContract.assetFrozenFunds(assetAddress)

        await assetContract.mint(aegisMintingJUSDAddress, freezeAmount)

        await expect(aegisMintingJUSDContract.freezeFunds(assetAddress, freezeAmount)).to.
          emit(aegisMintingJUSDContract, 'FreezeFunds').
          withArgs(assetAddress, freezeAmount)

        await expect(aegisMintingJUSDContract.assetFrozenFunds(assetAddress)).to.be.eventually.equal(frozenFundsBefore + freezeAmount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role FUNDS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).freezeFunds(ethers.ZeroAddress, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when freezing unknown asset', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)

        const unknownAsset = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.freezeFunds(unknownAsset.address, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when freezing amount exceeds contract balance', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)

        await expect(aegisMintingJUSDContract.freezeFunds(assetAddress, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })
    })
  })

  describe('#unfreezeFunds', () => {
    describe('success', () => {
      it('should unfreeze durty funds', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, aegisMintingJUSDAddress, assetContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)

        const freezeAmount = 1n
        await assetContract.mint(aegisMintingJUSDAddress, freezeAmount)

        await expect(aegisMintingJUSDContract.freezeFunds(assetAddress, freezeAmount)).to.be.not.reverted

        const frozenFundsBefore = await aegisMintingJUSDContract.assetFrozenFunds(assetAddress)

        await expect(aegisMintingJUSDContract.unfreezeFunds(assetAddress, freezeAmount)).to.
          emit(aegisMintingJUSDContract, 'UnfreezeFunds').
          withArgs(assetAddress, freezeAmount)

        await expect(aegisMintingJUSDContract.assetFrozenFunds(assetAddress)).to.be.eventually.equal(frozenFundsBefore - freezeAmount)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role FUNDS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).unfreezeFunds(ethers.ZeroAddress, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when unfreezing unknown asset', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)

        const unknownAsset = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.unfreezeFunds(unknownAsset.address, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })

      it('should revert when unfreezing amount excess frozen amount', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(FUNDS_MANAGER_ROLE, owner.address)

        await expect(aegisMintingJUSDContract.unfreezeFunds(assetAddress, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAmount')
      })
    })
  })

  describe('#setMintLimits', () => {
    describe('success', () => {
      it('should set mint limits', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)

        const periodDuration = 60
        const maxMintAmount = ethers.parseEther('1000')

        await expect(aegisMintingJUSDContract.setMintLimits(periodDuration, maxMintAmount)).to.
          emit(aegisMintingJUSDContract, 'SetMintLimits').
          withArgs(periodDuration, maxMintAmount)

        const mintLimit = await aegisMintingJUSDContract.mintLimit()

        expect(mintLimit.maxPeriodAmount).to.be.equal(maxMintAmount)
        expect(mintLimit.periodDuration).to.be.equal(periodDuration)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setMintLimits(1, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#setRedeemLimits', () => {
    describe('success', () => {
      it('should set redeem limits', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)

        const periodDuration = 60
        const maxMintAmount = ethers.parseEther('1000')

        await expect(aegisMintingJUSDContract.setRedeemLimits(periodDuration, maxMintAmount)).to.
          emit(aegisMintingJUSDContract, 'SetRedeemLimits').
          withArgs(periodDuration, maxMintAmount)

        const redeemLimit = await aegisMintingJUSDContract.redeemLimit()

        expect(redeemLimit.maxPeriodAmount).to.be.equal(maxMintAmount)
        expect(redeemLimit.periodDuration).to.be.equal(periodDuration)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setRedeemLimits(1, 1)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#setAegisConfigAddress', () => {
    describe('success', () => {
      it('should change AegisConfig address', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        const aegisConfig = await ethers.deployContract('AegisConfig', [trustedSignerAccount, [], owner])

        await expect(aegisMintingJUSDContract.setAegisConfigAddress(aegisConfig)).to.
          emit(aegisMintingJUSDContract, 'SetAegisConfigAddress').
          withArgs(aegisConfig)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role DEFAULT_ADMIN_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        const someAccount = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.connect(notOwner).setAegisConfigAddress(someAccount)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when passed address does not support IAegisConfig interface', async () => {
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        const someAccount = await ethers.Wallet.createRandom()

        await expect(aegisMintingJUSDContract.setAegisConfigAddress(someAccount)).to.be.reverted
      })
    })
  })

  describe('#setChainlinkAssetHeartbeat', () => {
    describe('success', () => {
      it('should update chainlink asset heartbeat', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)

        const heartbeat = 3600
        await expect(aegisMintingJUSDContract.setChainlinkAssetHeartbeat(assetAddress, heartbeat)).to.
          emit(aegisMintingJUSDContract, 'SetChainlinkAssetHeartbeat').
          withArgs(assetAddress, heartbeat)
      })
    })

    describe('error', () => {
      it('should revert when caller does not have role SETTINGS_MANAGER_ROLE', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]

        const { aegisMintingJUSDContract, assetAddress } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setChainlinkAssetHeartbeat(assetAddress, 86400)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })

      it('should revert when asset is not supported', async () => {
        const [owner] = await ethers.getSigners()
        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.grantRole(SETTINGS_MANAGER_ROLE, owner.address)

        const testAssetContract = await ethers.deployContract('TestToken', ['Test', 'TST', 18])

        await expect(aegisMintingJUSDContract.setChainlinkAssetHeartbeat(testAssetContract, 86400)).to.be.
          revertedWithCustomError(aegisMintingJUSDContract, 'InvalidAssetAddress')
      })
    })
  })

  describe('#setPreCollateralizedMinter', () => {
    describe('success', () => {
      it('should set new pre-collateralized minter', async () => {
        await ethers.getSigners()
        const newMinter = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.setPreCollateralizedMinter(newMinter.address))
          .to.emit(aegisMintingJUSDContract, 'SetPreCollateralizedMinter')
          .withArgs(newMinter.address, ethers.ZeroAddress)

        expect(await aegisMintingJUSDContract.preCollateralizedMinter()).to.equal(newMinter.address)
      })

      it('should update existing pre-collateralized minter', async () => {
        await ethers.getSigners()
        const oldMinter = await ethers.Wallet.createRandom()
        const newMinter = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.setPreCollateralizedMinter(oldMinter.address)

        await expect(aegisMintingJUSDContract.setPreCollateralizedMinter(newMinter.address))
          .to.emit(aegisMintingJUSDContract, 'SetPreCollateralizedMinter')
          .withArgs(newMinter.address, oldMinter.address)

        expect(await aegisMintingJUSDContract.preCollateralizedMinter()).to.equal(newMinter.address)
      })
    })

    describe('error', () => {
      it('should revert when caller is not admin', async () => {
        const signers = await ethers.getSigners()
        const notOwner = signers[1]
        const newMinter = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await expect(aegisMintingJUSDContract.connect(notOwner).setPreCollateralizedMinter(newMinter.address))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'AccessControlUnauthorizedAccount')
      })
    })
  })

  describe('#mintPreCollateralized', () => {
    describe('success', () => {
      it('should mint pre-collateralized JUSD tokens', async () => {
        const signers = await ethers.getSigners()
        const preCollateralizedMinter = signers[1]
        const recipient = signers[2]

        const { aegisMintingJUSDContract, jusdContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.setPreCollateralizedMinter(preCollateralizedMinter.address)

        const amount = ethers.parseEther('1000')
        const initialBalance = await jusdContract.balanceOf(recipient.address)

        await expect(aegisMintingJUSDContract.connect(preCollateralizedMinter).mintPreCollateralized(recipient.address, amount))
          .to.emit(aegisMintingJUSDContract, 'PreCollateralizedMint')
          .withArgs(recipient.address, amount)

        const finalBalance = await jusdContract.balanceOf(recipient.address)
        expect(finalBalance - initialBalance).to.equal(amount)
      })
    })

    describe('error', () => {
      it('should revert when caller is not pre-collateralized minter', async () => {
        const signers = await ethers.getSigners()
        const preCollateralizedMinter = signers[1]
        const notMinter = signers[2]
        const recipient = signers[3]

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        await aegisMintingJUSDContract.setPreCollateralizedMinter(preCollateralizedMinter.address)

        const amount = ethers.parseEther('1000')

        await expect(aegisMintingJUSDContract.connect(notMinter).mintPreCollateralized(recipient.address, amount))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'NotAuthorized')
      })

      it('should revert when pre-collateralized minter is not set', async () => {
        await ethers.getSigners()
        const recipient = await ethers.Wallet.createRandom()

        const { aegisMintingJUSDContract } = await loadFixture(deployJUSDFixture)

        const amount = ethers.parseEther('1000')

        await expect(aegisMintingJUSDContract.mintPreCollateralized(recipient.address, amount))
          .to.be.revertedWithCustomError(aegisMintingJUSDContract, 'NotAuthorized')
      })
    })
  })
})
