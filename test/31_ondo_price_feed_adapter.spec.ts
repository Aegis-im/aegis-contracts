import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'

const e = ethers.parseEther

async function fixture() {
  const [admin] = await ethers.getSigners()
  // $1.148778 at 18 dp — the value the live Ondo oracle returns.
  const oracle: any = await ethers.deployContract('MockOndoOracle', [1148778020000000000n])
  const adapter: any = await ethers.deployContract('OndoPriceFeedAdapter', [oracle.target, 'USDY / USD (Ondo)'])
  return { admin, oracle, adapter }
}

describe('OndoPriceFeedAdapter', () => {
  it('presents the Ondo oracle in AggregatorV3 shape', async () => {
    const f = await loadFixture(fixture)
    expect(await f.adapter.decimals()).eq(18)
    expect(await f.adapter.description()).eq('USDY / USD (Ondo)')
    expect(await f.adapter.version()).eq(1)
    expect(await f.adapter.oracle()).eq(f.oracle.target)

    const [roundId, answer, startedAt, updatedAt, answeredInRound] = await f.adapter.latestRoundData()
    const ts = await f.oracle.timestamp()
    expect(answer).eq(1148778020000000000n)
    expect(updatedAt).eq(ts)
    expect(startedAt).eq(ts)
    // No rounds upstream: the timestamp stands in, and answeredInRound must not trail roundId
    // or every consumer that checks round completeness would reject the price.
    expect(roundId).eq(ts)
    expect(answeredInRound).eq(roundId)
  })

  it('tracks price updates and keeps the round id monotonic', async () => {
    const f = await loadFixture(fixture)
    const before = await f.adapter.latestRoundData()
    await time.increase(3600)
    await f.oracle.setPrice(1200000000000000000n)
    const after = await f.adapter.latestRoundData()
    expect(after[1]).eq(1200000000000000000n)
    expect(after[0]).gt(before[0])
  })

  it('refuses historical rounds rather than inventing one', async () => {
    const f = await loadFixture(fixture)
    await expect(f.adapter.getRoundData(1)).revertedWithCustomError(f.adapter, 'NoHistoricalData')
  })

  it('rejects a zero oracle address', async () => {
    await expect(ethers.deployContract('OndoPriceFeedAdapter', [ethers.ZeroAddress, 'x']))
      .revertedWithCustomError(await ethers.getContractFactory('OndoPriceFeedAdapter'), 'ZeroAddress')
  })

  it('prices USDY through the guard, and fails closed when the oracle goes stale or bad', async () => {
    const f = await loadFixture(fixture)
    const [admin, operator, gatekeeper] = await ethers.getSigners()
    const usdy: any = await ethers.deployContract('TestToken', ['Ondo US Dollar Yield', 'USDY', 18])
    const minting: any = await ethers.deployContract('TestToken', ['Sink', 'SINK', 6])
    const guard: any = await ethers.deployContract('JUSDAssetGuard', [minting.target, admin.address, 86400, [], [], [], 0, 0, [operator.address], [gatekeeper.address], ethers.ZeroAddress, [], ethers.ZeroAddress, 0, []])
    await guard.connect(gatekeeper).setPriceFeed(usdy.target, f.adapter.target, 86400)
    await guard.connect(gatekeeper).setOndoAsset(usdy.target, true)

    // 1000 USDY at $1.14877802 = $1148.77802
    expect(await guard.assetUsdValue(usdy.target, e('1000'))).eq(e('1148.77802'))

    // Stale beyond the heartbeat.
    await time.increase(86401)
    await expect(guard.assetUsdValue(usdy.target, e('1'))).revertedWithCustomError(guard, 'InvalidPrice')
    await f.oracle.setPrice(1148778020000000000n)
    expect(await guard.assetUsdValue(usdy.target, e('1'))).eq(e('1.14877802'))

    // Zero price, and a future-dated answer, both fail closed.
    await f.oracle.setPrice(0)
    await expect(guard.assetUsdValue(usdy.target, e('1'))).revertedWithCustomError(guard, 'InvalidPrice')
    await f.oracle.setPrice(1148778020000000000n)
    await f.oracle.setTimestamp((await time.latest()) + 3600)
    await expect(guard.assetUsdValue(usdy.target, e('1'))).revertedWithCustomError(guard, 'InvalidPrice')
  })
})
