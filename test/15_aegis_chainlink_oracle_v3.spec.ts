import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

describe('#AegisChainlinkOracleV3', () => {
  describe('#setOperator', () => {
    describe('success', () => {
      it('should add new operator', async function () {
        this.timeout(240000) // 4 minutes
        const [owner, operator] = await ethers.getSigners()

        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        await expect(contract.setOperator(operator, true)).to.emit(contract, 'SetOperator').withArgs(operator, true)
      })

      it('should remove existing operator', async () => {
        const [owner, operator] = await ethers.getSigners()

        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        await expect(contract.setOperator(operator, true)).to.be.not.reverted

        await expect(contract.setOperator(operator, false)).to.emit(contract, 'SetOperator').withArgs(operator, false)
      })
    })

    describe('error', () => {
      it('should revert when caller is not an owner', async () => {
        const [owner, notOwner] = await ethers.getSigners()

        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        await expect(contract.connect(notOwner).setOperator(notOwner, true)).to.be.revertedWithCustomError(
          contract,
          'OwnableUnauthorizedAccount',
        )
      })
    })
  })

  describe('#updateYUSDPrice', () => {
    describe('success', () => {
      it('should update yusd price', async () => {
        const [owner] = await ethers.getSigners()

        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        const price = 99963000n
        const timestamp = (await time.latest()) + 1

        await expect(contract.updateYUSDPrice(price)).to.emit(contract, 'UpdateYUSDPrice').withArgs(price, timestamp)

        await expect(contract.yusdUSDPrice()).to.be.eventually.equal(price)
        await expect(contract.lastUpdateTimestamp()).to.be.eventually.equal(timestamp)
      })
    })

    describe('error', () => {
      it('should revert when caller is not an operator', async () => {
        const [owner] = await ethers.getSigners()

        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[], owner])

        await expect(contract.updateYUSDPrice(99963000)).to.be.revertedWithCustomError(contract, 'AccessForbidden')
      })
    })
  })

  describe('#getRoundData', () => {
    describe('success', () => {
      it('should return round data for existing rounds', async () => {
        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        const price1 = 100000000n
        const tx1 = await contract.updateYUSDPrice(price1)
        await tx1.wait()
        const ts1 = await time.latest()

        const price2 = 99999000n
        const tx2 = await contract.updateYUSDPrice(price2)
        await tx2.wait()
        const ts2 = await time.latest()

        const r1 = await contract.getRoundData(1)
        expect(r1.roundId).to.equal(1n)
        expect(r1.answer).to.equal(price1)
        expect(r1.startedAt).to.equal(BigInt(ts1))
        expect(r1.updatedAt).to.equal(BigInt(ts1))
        expect(r1.answeredInRound).to.equal(1n)

        const r2 = await contract.getRoundData(2)
        expect(r2.roundId).to.equal(2n)
        expect(r2.answer).to.equal(price2)
        expect(r2.startedAt).to.equal(BigInt(ts2))
        expect(r2.updatedAt).to.equal(BigInt(ts2))
        expect(r2.answeredInRound).to.equal(2n)
      })
    })

    describe('error', () => {
      it('should revert when round has no data', async () => {
        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        await expect(contract.getRoundData(1)).to.be.revertedWith('No data present')
      })
    })
  })

  describe('#latestRoundData', () => {
    describe('success', () => {
      it('should return latest round data', async () => {
        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        const price1 = 101000000n
        const tx1 = await contract.updateYUSDPrice(price1)
        await tx1.wait()
        await time.latest() // advance reference

        const price2 = 100500000n
        const tx2 = await contract.updateYUSDPrice(price2)
        await tx2.wait()
        const ts2 = await time.latest()

        const latest = await contract.latestRoundData()
        expect(latest.roundId).to.equal(2n)
        expect(latest.answer).to.equal(price2)
        expect(latest.startedAt).to.equal(BigInt(ts2))
        expect(latest.updatedAt).to.equal(BigInt(ts2))
        expect(latest.answeredInRound).to.equal(2n)
      })
    })

    describe('error', () => {
      it('should revert when no rounds exist', async () => {
        const [owner] = await ethers.getSigners()
        const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])

        await expect(contract.latestRoundData()).to.be.revertedWith('No data present')
      })
    })
  })

  describe('#metadata', () => {
    it('should return decimals = 8', async () => {
      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])
      expect(await contract.decimals()).to.equal(8)
    })

    it('should return correct description', async () => {
      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])
      expect(await contract.description()).to.equal('Aegis Oracle sYUSD / YUSD')
    })

    it('should return version = 1', async () => {
      const [owner] = await ethers.getSigners()
      const contract = await ethers.deployContract('AegisChainlinkOracleV3', [[owner], owner])
      expect(await contract.version()).to.equal(1n)
    })
  })
})
