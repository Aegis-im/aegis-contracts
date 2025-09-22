import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

describe('#AegisChainlinkOracleV2', () => {
  describe('#constructor', () => {
    it('should deploy with correct initial state', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      // Check basic functionality
      expect(await contract.decimals()).to.equal(8)
      expect(await contract.owner()).to.equal(owner.address)

      // Check scale factor
      expect(await contract.SCALE_FACTOR()).to.equal(10n ** 28n) // 1e28

      // Check vaults are set to zero address
      expect(await contract.BASE_VAULT()).to.equal('0x0000000000000000000000000000000000000000')
      expect(await contract.QUOTE_VAULT()).to.equal('0x0000000000000000000000000000000000000000')

      // Check conversion samples
      expect(await contract.BASE_VAULT_CONVERSION_SAMPLE()).to.equal(1n)
      expect(await contract.QUOTE_VAULT_CONVERSION_SAMPLE()).to.equal(1n)

      // Check feeds are set to zero address
      expect(await contract.BASE_FEED_1()).to.equal('0x0000000000000000000000000000000000000000')
      expect(await contract.BASE_FEED_2()).to.equal('0x0000000000000000000000000000000000000000')
      expect(await contract.QUOTE_FEED_1()).to.equal('0x0000000000000000000000000000000000000000')
      expect(await contract.QUOTE_FEED_2()).to.equal('0x0000000000000000000000000000000000000000')
    })

    it('should set initial operators correctly', async function () {
      this.timeout(240000) // 4 minutes

      const [owner, operator1, operator2] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner, operator1, operator2], owner])

      // All initial operators should be able to update price
      await contract.connect(owner).updateYUSDPrice(100000000n)
      await contract.connect(operator1).updateYUSDPrice(200000000n)
      await contract.connect(operator2).updateYUSDPrice(300000000n)

      expect(await contract.yusdUSDPrice()).to.equal(300000000n)
    })

    it('should revert if initial owner is zero address', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      await expect(
        ethers.deployContract('AegisChainlinkOracleV2', [[owner], '0x0000000000000000000000000000000000000000']),
      ).to.be.revertedWithCustomError(contract, 'OwnableInvalidOwner')
    })
  })

  describe('#decimals', () => {
    it('should return 8 decimals', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      expect(await contract.decimals()).to.equal(8)
    })
  })

  describe('#setOperator', () => {
    describe('success', () => {
      it('should add new operator', async function () {
        this.timeout(240000) // 4 minutes

        const [owner, operator] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        await expect(contract.setOperator(operator, true))
          .to.emit(contract, 'SetOperator')
          .withArgs(operator.address, true)
      })

      it('should remove existing operator', async function () {
        this.timeout(240000) // 4 minutes

        const [owner, operator] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        await expect(contract.setOperator(operator, true)).to.be.not.reverted
        await expect(contract.setOperator(operator, false))
          .to.emit(contract, 'SetOperator')
          .withArgs(operator.address, false)
      })

      it('should handle multiple operators', async function () {
        this.timeout(240000) // 4 minutes

        const [owner, op1, op2, op3] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        // Add multiple operators
        await contract.setOperator(op1, true)
        await contract.setOperator(op2, true)
        await contract.setOperator(op3, true)

        // All should be able to update price
        await contract.connect(op1).updateYUSDPrice(100000000n)
        await contract.connect(op2).updateYUSDPrice(200000000n)
        await contract.connect(op3).updateYUSDPrice(300000000n)

        expect(await contract.yusdUSDPrice()).to.equal(300000000n)
      })
    })

    describe('error', () => {
      it('should revert when caller is not an owner', async function () {
        this.timeout(240000) // 4 minutes

        const [owner, notOwner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        await expect(contract.connect(notOwner).setOperator(notOwner, true)).to.be.revertedWithCustomError(
          contract,
          'OwnableUnauthorizedAccount',
        )
      })
    })
  })

  describe('#updateYUSDPrice', () => {
    describe('success', () => {
      it('should update yusd price', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        const price = 99963000n
        const timestamp = (await time.latest()) + 1

        await expect(contract.updateYUSDPrice(price)).to.emit(contract, 'UpdateYUSDPrice').withArgs(price, timestamp)

        await expect(contract.yusdUSDPrice()).to.be.eventually.equal(price)
        await expect(contract.lastUpdateTimestamp()).to.be.eventually.equal(timestamp)
      })

      it('should update price multiple times', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        const price1 = 99963000n
        const price2 = 100000000n

        await contract.updateYUSDPrice(price1)
        expect(await contract.yusdUSDPrice()).to.equal(price1)

        await contract.updateYUSDPrice(price2)
        expect(await contract.yusdUSDPrice()).to.equal(price2)
      })

      it('should handle different price values', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        const testCases = [
          { input: 100000000n, expected: 10n ** 36n }, // $1.00
          { input: 99999999n, expected: 99999999n * 10n ** 28n }, // $0.99999999
          { input: 100000001n, expected: 100000001n * 10n ** 28n }, // $1.00000001
        ]

        for (const testCase of testCases) {
          await contract.updateYUSDPrice(testCase.input)
          expect(await contract.price()).to.equal(testCase.expected)
        }
      })
    })

    describe('error', () => {
      it('should revert when caller is not an operator', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[], owner])

        await expect(contract.updateYUSDPrice(99963000)).to.be.revertedWithCustomError(contract, 'AccessForbidden')
      })

      it('should revert when caller is not set as operator', async function () {
        this.timeout(240000) // 4 minutes

        const [owner, notOperator] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        await expect(contract.connect(notOperator).updateYUSDPrice(99963000)).to.be.revertedWithCustomError(
          contract,
          'AccessForbidden',
        )
      })
    })
  })

  describe('#price', () => {
    describe('manual price mode', () => {
      it('should return default price when no price is set', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        // Default price should be 1 USD = 1e36
        expect(await contract.price()).to.equal(10n ** 36n)
      })

      it('should return scaled price when price is set', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        const price = 100000000n // $1.00 with 8 decimals
        const expectedPrice = price * 10n ** 28n // Scaled to 1e36

        await contract.updateYUSDPrice(price)
        expect(await contract.price()).to.equal(expectedPrice)
      })

      it('should handle different price values', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        const testCases = [
          { input: 100000000n, expected: 10n ** 36n }, // $1.00
          { input: 99999999n, expected: 99999999n * 10n ** 28n }, // $0.99999999
          { input: 100000001n, expected: 100000001n * 10n ** 28n }, // $1.00000001
        ]

        for (const testCase of testCases) {
          await contract.updateYUSDPrice(testCase.input)
          expect(await contract.price()).to.equal(testCase.expected)
        }
      })

      it('should return default price for zero or negative price', async function () {
        this.timeout(240000) // 4 minutes

        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

        // Test zero price
        await contract.updateYUSDPrice(0)
        expect(await contract.price()).to.equal(10n ** 36n)

        // Test negative price
        await contract.updateYUSDPrice(-100000000n)
        expect(await contract.price()).to.equal(10n ** 36n)
      })
    })
  })

  describe('#yusdUSDPrice', () => {
    it('should return current price', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      const price = 99963000n
      await contract.updateYUSDPrice(price)
      expect(await contract.yusdUSDPrice()).to.equal(price)
    })

    it('should return 0 when no price is set', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      expect(await contract.yusdUSDPrice()).to.equal(0n)
    })
  })

  describe('#lastUpdateTimestamp', () => {
    it('should return timestamp of last update', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      const timestamp = await time.latest()
      await contract.updateYUSDPrice(100000000n)

      const lastUpdate = await contract.lastUpdateTimestamp()
      expect(lastUpdate).to.be.greaterThanOrEqual(timestamp)
    })

    it('should return 0 when no price is set', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      expect(await contract.lastUpdateTimestamp()).to.equal(0n)
    })
  })

  describe('Morpho Blue compatibility', () => {
    it('should implement IOracle interface', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      // Check that price() function exists and returns uint256
      const price = await contract.price()
      expect(typeof price).to.equal('bigint')
      expect(price).to.be.greaterThan(0n)
    })

    it('should return price in correct format for Morpho Blue', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      // Set a price
      await contract.updateYUSDPrice(100000000n) // $1.00

      // Price should be in 1e36 format
      const price = await contract.price()
      expect(price).to.equal(10n ** 36n) // 1 USD in 1e36 format
    })

    it('should handle price scaling correctly', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      // Test different price values and their scaling
      const testCases = [
        { input: 100000000n, expected: 10n ** 36n }, // $1.00
        { input: 99999999n, expected: 99999999n * 10n ** 28n }, // $0.99999999
        { input: 100000001n, expected: 100000001n * 10n ** 28n }, // $1.00000001
      ]

      for (const testCase of testCases) {
        await contract.updateYUSDPrice(testCase.input)
        const scaledPrice = await contract.price()
        expect(scaledPrice).to.equal(testCase.expected)
      }
    })
  })

  describe('Events', () => {
    it('should emit UpdateYUSDPrice event', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      const price = 99963000n
      const timestamp = await time.latest()

      await expect(contract.updateYUSDPrice(price))
        .to.emit(contract, 'UpdateYUSDPrice')
        .withArgs(price, timestamp + 1)
    })

    it('should emit SetOperator event', async function () {
      this.timeout(240000) // 4 minutes

      const [owner, operator] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      await expect(contract.setOperator(operator, true))
        .to.emit(contract, 'SetOperator')
        .withArgs(operator.address, true)
      await expect(contract.setOperator(operator, false))
        .to.emit(contract, 'SetOperator')
        .withArgs(operator.address, false)
    })
  })

  describe('Edge cases', () => {
    it('should handle maximum price value', async function () {
      this.timeout(240000) // 4 minutes

      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      const maxPrice = 1000000000n // $10.00 with 8 decimals (reasonable max)
      await contract.updateYUSDPrice(maxPrice)

      const scaledPrice = await contract.price()
      expect(scaledPrice).to.equal(maxPrice * 10n ** 28n)
    })

    it('should handle multiple operators', async function () {
      this.timeout(240000) // 4 minutes

      const [owner, op1, op2, op3] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      // Add multiple operators
      await contract.setOperator(op1, true)
      await contract.setOperator(op2, true)
      await contract.setOperator(op3, true)

      // All should be able to update price
      await contract.connect(op1).updateYUSDPrice(100000000n)
      await contract.connect(op2).updateYUSDPrice(200000000n)
      await contract.connect(op3).updateYUSDPrice(300000000n)

      expect(await contract.yusdUSDPrice()).to.equal(300000000n)
    })

    it('should handle operator removal', async function () {
      this.timeout(240000) // 4 minutes

      const [owner, operator] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV2', [[owner], owner])

      await contract.setOperator(operator, true)

      // Operator can update price
      await contract.connect(operator).updateYUSDPrice(100000000n)
      expect(await contract.yusdUSDPrice()).to.equal(100000000n)

      // Remove operator
      await contract.setOperator(operator, false)

      // Operator cannot update price anymore
      await expect(contract.connect(operator).updateYUSDPrice(200000000n)).to.be.revertedWithCustomError(
        contract,
        'AccessForbidden',
      )
    })
  })
})
