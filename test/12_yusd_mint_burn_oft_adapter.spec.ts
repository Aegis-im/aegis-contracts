import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

describe('YUSD MintBurn OFT Adapter - Basic Tests', () => {
  async function deployBasicFixture() {
    const [owner, user1, user2] = await ethers.getSigners()

    // Deploy YUSD token
    const yusd = await ethers.deployContract('YUSD', [owner.address])
    const yusdAddress = await yusd.getAddress()

    // Mint some tokens to user1 for testing
    await yusd.setMinter(owner.address)
    await yusd.mint(user1.address, ethers.parseEther('1000'))

    return {
      yusd,
      yusdAddress,
      owner,
      user1,
      user2,
    }
  }

  describe('YUSD Token Basic Functionality', () => {
    it('should deploy YUSD correctly', async () => {
      const { yusd, yusdAddress } = await loadFixture(deployBasicFixture)

      expect(await yusd.getAddress()).to.equal(yusdAddress)
      expect(await yusd.name()).to.equal('YUSD')
      expect(await yusd.symbol()).to.equal('YUSD')
    })

    it('should have minter role functionality', async () => {
      const { yusd, owner, user1 } = await loadFixture(deployBasicFixture)

      expect(await yusd.minter()).to.equal(owner.address)

      // Test minting
      const initialBalance = await yusd.balanceOf(user1.address)
      await yusd.mint(user1.address, ethers.parseEther('100'))
      const finalBalance = await yusd.balanceOf(user1.address)

      expect(finalBalance - initialBalance).to.equal(ethers.parseEther('100'))
    })

    it('should have burn functionality', async () => {
      const { yusd, user1 } = await loadFixture(deployBasicFixture)

      const initialBalance = await yusd.balanceOf(user1.address)
      const burnAmount = ethers.parseEther('100')

      // Test burning
      await yusd.connect(user1).burn(burnAmount)
      const finalBalance = await yusd.balanceOf(user1.address)

      expect(initialBalance - finalBalance).to.equal(burnAmount)
    })

    it('should have burnFrom functionality', async () => {
      const { yusd, owner, user1 } = await loadFixture(deployBasicFixture)

      const initialBalance = await yusd.balanceOf(user1.address)
      const burnAmount = ethers.parseEther('100')

      // Approve owner to burn user1's tokens
      await yusd.connect(user1).approve(owner.address, burnAmount)

      // Test burnFrom
      await yusd.connect(owner).burnFrom(user1.address, burnAmount)
      const finalBalance = await yusd.balanceOf(user1.address)

      expect(initialBalance - finalBalance).to.equal(burnAmount)
    })

    it('should revert when non-minter tries to mint', async () => {
      const { yusd, user2, user1 } = await loadFixture(deployBasicFixture)

      await expect(
        yusd.connect(user2).mint(user1.address, ethers.parseEther('100')),
      ).to.be.revertedWithCustomError(yusd, 'OnlyMinter')
    })

    it('should allow owner to change minter', async () => {
      const { yusd, owner, user1 } = await loadFixture(deployBasicFixture)

      // Change minter to user1
      await yusd.connect(owner).setMinter(user1.address)
      expect(await yusd.minter()).to.equal(user1.address)

      // Now user1 should be able to mint
      await yusd.connect(user1).mint(user1.address, ethers.parseEther('100'))

      // Owner should no longer be able to mint
      await expect(
        yusd.connect(owner).mint(user1.address, ethers.parseEther('100')),
      ).to.be.revertedWithCustomError(yusd, 'OnlyMinter')
    })
  })

  describe('YUSD Blacklist Functionality', () => {
    it('should allow owner to add users to blacklist', async () => {
      const { yusd, owner, user1 } = await loadFixture(deployBasicFixture)

      expect(await yusd.getBlackListStatus(user1.address)).to.be.false

      await yusd.connect(owner).addBlackList(user1.address)
      expect(await yusd.getBlackListStatus(user1.address)).to.be.true
    })

    it('should prevent blacklisted users from transferring', async () => {
      const { yusd, owner, user1, user2 } = await loadFixture(deployBasicFixture)

      // Add user1 to blacklist
      await yusd.connect(owner).addBlackList(user1.address)

      // user1 should not be able to transfer
      await expect(
        yusd.connect(user1).transfer(user2.address, ethers.parseEther('100')),
      ).to.be.revertedWithCustomError(yusd, 'Blacklisted')
    })

    it('should allow owner to remove users from blacklist', async () => {
      const { yusd, owner, user1, user2 } = await loadFixture(deployBasicFixture)

      // Add user1 to blacklist
      await yusd.connect(owner).addBlackList(user1.address)
      expect(await yusd.getBlackListStatus(user1.address)).to.be.true

      // Remove user1 from blacklist
      await yusd.connect(owner).removeBlackList(user1.address)
      expect(await yusd.getBlackListStatus(user1.address)).to.be.false

      // user1 should now be able to transfer
      await yusd.connect(user1).transfer(user2.address, ethers.parseEther('100'))
      expect(await yusd.balanceOf(user2.address)).to.equal(ethers.parseEther('100'))
    })

    it('should emit events for blacklist operations', async () => {
      const { yusd, owner, user1 } = await loadFixture(deployBasicFixture)

      // Test AddedBlackList event
      await expect(yusd.connect(owner).addBlackList(user1.address))
        .to.emit(yusd, 'AddedBlackList')
        .withArgs(user1.address)

      // Test RemovedBlackList event
      await expect(yusd.connect(owner).removeBlackList(user1.address))
        .to.emit(yusd, 'RemovedBlackList')
        .withArgs(user1.address)
    })
  })

  describe('Integration Test Simulation', () => {
    it('should simulate cross-chain mint and burn operations', async () => {
      const { yusd, owner, user1, user2 } = await loadFixture(deployBasicFixture)

      // Simulate a cross-chain adapter scenario
      const initialBalance = await yusd.balanceOf(user1.address)
      const initialSupply = await yusd.totalSupply()
      const transferAmount = ethers.parseEther('100')

      // Step 1: Simulate burning tokens on source chain
      await yusd.connect(user1).burn(transferAmount)

      const balanceAfterBurn = await yusd.balanceOf(user1.address)
      const supplyAfterBurn = await yusd.totalSupply()

      expect(initialBalance - balanceAfterBurn).to.equal(transferAmount)
      expect(initialSupply - supplyAfterBurn).to.equal(transferAmount)

      // Step 2: Simulate minting tokens on destination chain (to different user)
      await yusd.connect(owner).mint(user2.address, transferAmount)

      const user2Balance = await yusd.balanceOf(user2.address)
      const finalSupply = await yusd.totalSupply()

      expect(user2Balance).to.equal(transferAmount)
      expect(finalSupply).to.equal(initialSupply) // Total supply restored

      console.log('✅ Cross-chain simulation completed successfully:')
      console.log(`  • Burned ${ethers.formatEther(transferAmount)} YUSD from user1`)
      console.log(`  • Minted ${ethers.formatEther(transferAmount)} YUSD to user2`)
      console.log(`  • Total supply maintained: ${ethers.formatEther(finalSupply)} YUSD`)
    })

    it('should demonstrate mint/burn adapter compatibility', async () => {
      const { yusd, owner, user1 } = await loadFixture(deployBasicFixture)

      // This test demonstrates that YUSD has all required functions for MintBurnOFTAdapter
      const amount = ethers.parseEther('50')

      // Test that required functions exist and work
      expect(yusd.mint).to.be.a('function')
      expect(yusd.burnFrom).to.be.a('function')

      // Test mint function
      const initialBalance = await yusd.balanceOf(user1.address)
      await yusd.connect(owner).mint(user1.address, amount)
      expect(await yusd.balanceOf(user1.address) - initialBalance).to.equal(amount)

      // Test burnFrom function (simulate adapter burning user's tokens)
      await yusd.connect(user1).approve(owner.address, amount)
      await yusd.connect(owner).burnFrom(user1.address, amount)
      expect(await yusd.balanceOf(user1.address)).to.equal(initialBalance)

      console.log('✅ YUSD is compatible with MintBurnOFTAdapter pattern')
    })
  })
}) 