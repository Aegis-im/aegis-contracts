import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'

import { COLLATERAL_MANAGER_ROLE, OrderType, deployJUSDFixture, encodeString, signOrderJUSD } from '../utils/helpers'

const WHITELIST_MANAGER_ROLE = ethers.id('WHITELIST_MANAGER_ROLE')
const z = ethers.ZeroAddress, e = ethers.parseEther, usd = ethers.parseEther
const u = (v: string) => ethers.parseUnits(v, 6)

async function fixture() {
  const base = await deployJUSDFixture()
  const [owner, operator, gatekeeper, venue, ondo, stranger] = await ethers.getSigners()
  const minting: any = base.aegisMintingJUSDContract

  const usdc: any = await ethers.deployContract('TestToken', ['USD Coin', 'USDC', 6])
  const usdy: any = await ethers.deployContract('TestToken', ['Ondo US Dollar Yield', 'USDY', 18])
  const usdcFeed: any = await ethers.deployContract('VaultChainlinkOracleV3', ['USDC / USD', 8, [owner.address], owner.address])
  const usdyFeed: any = await ethers.deployContract('VaultChainlinkOracleV3', ['USDY / USD', 8, [owner.address], owner.address])
  await usdcFeed.updatePrice(100_000_000)  // $1.00
  await usdyFeed.updatePrice(109_000_000)  // $1.09

  const guard: any = await ethers.deployContract('JUSDAssetGuard', [base.aegisMintingJUSDAddress, owner.address, 86400, [venue.address], ['Exchange'], [[usdc.target]], 0, 0])
  await minting.addCustodianAddress(guard.target)
  await minting.grantRole(COLLATERAL_MANAGER_ROLE, guard.target)
  await minting.addSupportedAsset(usdc.target, 86400)
  await guard.grantRole(COLLATERAL_MANAGER_ROLE, operator.address)
  await guard.grantRole(WHITELIST_MANAGER_ROLE, gatekeeper.address)

  // The whitelist manager opens the Ondo leg: multisig, priced assets, and a $10M cap.
  await guard.connect(gatekeeper).setOndoMultisig(ondo.address)
  await guard.connect(gatekeeper).setPriceFeed(usdc.target, usdcFeed.target, 86400)
  await guard.connect(gatekeeper).setPriceFeed(usdy.target, usdyFeed.target, 86400)
  await guard.connect(gatekeeper).setOndoAsset(usdc.target, true)
  await guard.connect(gatekeeper).setOndoAsset(usdy.target, true)
  await guard.connect(gatekeeper).setMaxOndoOutstanding(usd('10000000'))

  await usdc.mint(guard.target, u('5000000'))
  await usdy.mint(ondo.address, e('5000000'))
  await usdc.mint(ondo.address, u('5000000'))
  await usdy.connect(ondo).approve(guard.target, ethers.MaxUint256)
  await usdc.connect(ondo).approve(guard.target, ethers.MaxUint256)

  return { ...base, owner, operator, gatekeeper, venue, ondo, stranger, minting, usdc, usdy, usdcFeed, usdyFeed, guard }
}

describe('JUSDAssetGuard Ondo reserve leg', () => {
  it('meters USDC sent to the multisig and releases it as USDY comes back', async () => {
    const f = await loadFixture(fixture)
    expect(await f.guard.assetUsdValue(f.usdc.target, u('1'))).eq(usd('1'))
    expect(await f.guard.assetUsdValue(f.usdy.target, e('1'))).eq(usd('1.09'))

    await expect(f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000000')))
      .emit(f.guard, 'OndoWithdrawal').withArgs(f.usdc.target, u('1000000'), usd('1000000'), usd('1000000'))
    expect(await f.usdc.balanceOf(f.ondo.address)).eq(u('6000000'))
    expect(await f.guard.ondoOutstanding()).eq(usd('1000000'))
    expect(await f.guard.ondoHeadroom()).eq(usd('9000000'))

    // 900,000 USDY at $1.09 settles $981,000 of the $1,000,000 position.
    await expect(f.guard.connect(f.operator).pullFromOndo(f.usdy.target, e('900000')))
      .emit(f.guard, 'OndoReturn').withArgs(f.usdy.target, e('900000'), usd('981000'), usd('19000'))
    expect(await f.guard.ondoOutstanding()).eq(usd('19000'))
    expect(await f.guard.ondoAssetValue()).eq(usd('4000000') + usd('981000'))
  })

  it('caps outstanding exposure and refuses to exceed it', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.gatekeeper).setMaxOndoOutstanding(usd('1000000'))
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('600000'))
    await expect(f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('400001')))
      .revertedWithCustomError(f.guard, 'OndoLimitExceeded').withArgs(usd('400001'), usd('400000'))
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('400000'))
    expect(await f.guard.ondoHeadroom()).eq(0)
    await expect(f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1')))
      .revertedWithCustomError(f.guard, 'OndoLimitExceeded')

    // Lowering the cap below the live position parks the leg without touching the position.
    await f.guard.connect(f.gatekeeper).setMaxOndoOutstanding(usd('100000'))
    expect(await f.guard.ondoHeadroom()).eq(0)
    expect(await f.guard.ondoOutstanding()).eq(usd('1000000'))
  })

  it('leaves the counter untouched when assets go to whitelisted venues', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000000'))
    const outstanding = await f.guard.ondoOutstanding()
    await f.guard.connect(f.operator).withdraw(f.usdc.target, f.venue.address, u('2000000'))
    await f.guard.connect(f.operator).withdrawBatch([f.usdc.target], [f.venue.address], [u('500000')])
    expect(await f.usdc.balanceOf(f.venue.address)).eq(u('2500000'))
    expect(await f.guard.ondoOutstanding()).eq(outstanding)
  })

  it('stays neutral across a redemption round trip', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000000'))
    await f.guard.connect(f.operator).pullFromOndo(f.usdy.target, e('900000'))
    const before = await f.guard.ondoOutstanding()

    // Sending USDY back for redemption raises the counter by its value...
    await f.guard.connect(f.operator).withdrawToOndo(f.usdy.target, e('900000'))
    expect(await f.guard.ondoOutstanding()).eq(before + usd('981000'))
    // ...and the returning USDC lowers it again.
    await f.guard.connect(f.operator).pullFromOndo(f.usdc.target, u('981000'))
    expect(await f.guard.ondoOutstanding()).eq(before)
  })

  it('keeps the multisig off the withdrawal whitelist in both directions', async () => {
    const f = await loadFixture(fixture)
    await expect(f.guard.connect(f.operator).withdraw(f.usdc.target, f.ondo.address, u('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.ondo.address, 'Ondo multisig', [f.usdc.target]))
      .revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.connect(f.gatekeeper).setOndoMultisig(f.venue.address))
      .revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.beginMintingAddressChange(f.ondo.address))
      .revertedWithCustomError(f.guard, 'InvalidAddress')
    // Nor can an unregistered asset ride the Ondo leg.
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 18])
    await other.mint(f.guard.target, e('1'))
    await expect(f.guard.connect(f.operator).withdrawToOndo(other.target, e('1')))
      .revertedWithCustomError(f.guard, 'NotOndoAsset')
  })

  it('fails closed on missing, stale, zero or unregistered prices', async () => {
    const f = await loadFixture(fixture)
    const unpriced: any = await ethers.deployContract('TestToken', ['Unpriced', 'UNP', 18])
    await expect(f.guard.assetUsdValue(unpriced.target, e('1'))).revertedWithCustomError(f.guard, 'MissingPriceFeed')
    await expect(f.guard.connect(f.gatekeeper).setOndoAsset(unpriced.target, true)).revertedWithCustomError(f.guard, 'MissingPriceFeed')

    await time.increase(86401)
    await expect(f.guard.assetUsdValue(f.usdy.target, e('1'))).revertedWithCustomError(f.guard, 'InvalidPrice')
    await expect(f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1'))).revertedWithCustomError(f.guard, 'InvalidPrice')
    await expect(f.guard.connect(f.operator).pullFromOndo(f.usdy.target, e('1'))).revertedWithCustomError(f.guard, 'InvalidPrice')

    await f.usdcFeed.updatePrice(100_000_000)
    await f.usdyFeed.updatePrice(109_000_000)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1'))

    // A feed cannot be unset while the asset is live on the Ondo leg, and zero heartbeats are refused.
    await expect(f.guard.connect(f.gatekeeper).setPriceFeed(f.usdc.target, z, 0)).revertedWithCustomError(f.guard, 'OndoAssetInUse')
    await expect(f.guard.connect(f.gatekeeper).setPriceFeed(f.usdc.target, f.usdcFeed.target, 0)).revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.connect(f.gatekeeper).setPriceFeed(f.usdc.target, f.venue.address, 86400)).revertedWithCustomError(f.guard, 'InvalidAddress')
  })

  it('reserves limits, pricing and the multisig to the whitelist manager', async () => {
    const f = await loadFixture(fixture)
    for (const call of [
      () => f.guard.connect(f.operator).setMaxOndoOutstanding(usd('1')),
      () => f.guard.connect(f.operator).setOndoOutstanding(0),
      () => f.guard.connect(f.operator).setOndoMultisig(f.stranger.address),
      () => f.guard.connect(f.operator).setOndoAsset(f.usdc.target, false),
      () => f.guard.connect(f.operator).setPriceFeed(f.usdc.target, f.usdcFeed.target, 1),
    ]) await expect(call()).revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.operator.address, WHITELIST_MANAGER_ROLE)

    // And the limit setter cannot move assets.
    await expect(f.guard.connect(f.gatekeeper).withdrawToOndo(f.usdc.target, u('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.gatekeeper.address, COLLATERAL_MANAGER_ROLE)
    await expect(f.guard.connect(f.stranger).pullFromOndo(f.usdy.target, e('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.stranger.address, COLLATERAL_MANAGER_ROLE)
  })

  it('settles a return worth more than the position without going negative', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('100000'))
    // USDY accrues: the multisig can hand back more value than left.
    await f.usdyFeed.updatePrice(120_000_000)
    await f.guard.connect(f.operator).pullFromOndo(f.usdy.target, e('100000'))
    expect(await f.guard.ondoOutstanding()).eq(0)
    expect(await f.guard.ondoHeadroom()).eq(usd('10000000'))
  })

  it('lets the whitelist manager reconcile an off-path return and rotate only when settled', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000000'))
    // The multisig pushes USDY straight in; a plain transfer cannot move the counter by itself.
    await f.usdy.connect(f.ondo).transfer(f.guard.target, e('900000'))
    expect(await f.guard.ondoOutstanding()).eq(usd('1000000'))
    await expect(f.guard.connect(f.gatekeeper).setOndoMultisig(f.stranger.address))
      .revertedWithCustomError(f.guard, 'OutstandingNotSettled').withArgs(usd('1000000'))

    await expect(f.guard.connect(f.gatekeeper).setOndoOutstanding(usd('19000')))
      .emit(f.guard, 'OndoOutstandingReconciled').withArgs(usd('1000000'), usd('19000'))
    await f.guard.connect(f.gatekeeper).setOndoOutstanding(0)
    await expect(f.guard.connect(f.gatekeeper).setOndoMultisig(f.stranger.address))
      .emit(f.guard, 'OndoMultisigChanged').withArgs(f.stranger.address)
  })

  it('pauses outflow to Ondo but never the return leg', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000000'))
    await f.guard.connect(f.gatekeeper).setPaused(true)
    await expect(f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1'))).revertedWithCustomError(f.guard, 'Paused')
    // The multisig can settle its own position while the guard is paused.
    await expect(f.guard.connect(f.ondo).pullFromOndo(f.usdy.target, e('900000')))
      .emit(f.guard, 'OndoReturn').withArgs(f.usdy.target, e('900000'), usd('981000'), usd('19000'))
  })

  it('starts with the Ondo leg closed', async () => {
    const f = await loadFixture(fixture)
    const fresh: any = await ethers.deployContract('JUSDAssetGuard', [f.aegisMintingJUSDAddress, f.owner.address, 86400, [], [], [], 0, 0])
    await fresh.grantRole(COLLATERAL_MANAGER_ROLE, f.operator.address)
    await fresh.grantRole(WHITELIST_MANAGER_ROLE, f.gatekeeper.address)
    expect(await fresh.ondoMultisig()).eq(z)
    expect(await fresh.maxOndoOutstanding()).eq(0)
    await expect(fresh.connect(f.operator).withdrawToOndo(f.usdc.target, u('1'))).revertedWithCustomError(fresh, 'OndoNotConfigured')
    await expect(fresh.connect(f.operator).pullFromOndo(f.usdc.target, u('1'))).revertedWithCustomError(fresh, 'OndoNotConfigured')

    // Even fully wired, a zero cap keeps the leg shut until the whitelist manager raises it.
    await fresh.connect(f.gatekeeper).setOndoMultisig(f.ondo.address)
    await fresh.connect(f.gatekeeper).setPriceFeed(f.usdc.target, f.usdcFeed.target, 86400)
    await fresh.connect(f.gatekeeper).setOndoAsset(f.usdc.target, true)
    await f.usdc.mint(fresh.target, u('1'))
    await expect(fresh.connect(f.operator).withdrawToOndo(f.usdc.target, u('1')))
      .revertedWithCustomError(fresh, 'OndoLimitExceeded').withArgs(usd('1'), 0)
  })

  it('applies the whitelist cooldown to venues, not to the separately governed Ondo multisig', async () => {
    const f = await loadFixture(fixture)
    const guard: any = await ethers.deployContract('JUSDAssetGuard', [f.aegisMintingJUSDAddress, f.owner.address, 86400, [f.venue.address], ['Exchange'], [[f.usdc.target]], 3600, 0])
    await guard.grantRole(COLLATERAL_MANAGER_ROLE, f.operator.address)
    await guard.grantRole(WHITELIST_MANAGER_ROLE, f.gatekeeper.address)
    await guard.connect(f.gatekeeper).setOndoMultisig(f.ondo.address)
    await guard.connect(f.gatekeeper).setPriceFeed(f.usdc.target, f.usdcFeed.target, 86400)
    await guard.connect(f.gatekeeper).setOndoAsset(f.usdc.target, true)
    await guard.connect(f.gatekeeper).setMaxOndoOutstanding(usd('1000'))
    await f.usdc.mint(guard.target, u('1000'))

    await expect(guard.connect(f.operator).withdraw(f.usdc.target, f.venue.address, u('1')))
      .revertedWithCustomError(guard, 'DestinationInCooldown')
    await guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1'))
    await time.increase(3601)
    await guard.connect(f.operator).withdraw(f.usdc.target, f.venue.address, u('1'))
  })

  it('refuses to return the USDY reserve to minting, which could never release it', async () => {
    const f = await loadFixture(fixture)
    await f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000000'))
    await f.guard.connect(f.operator).pullFromOndo(f.usdy.target, e('900000'))

    // USDY is a reserve asset, not JUSD mint collateral.
    expect(await f.minting.isSupportedAsset(f.usdy.target)).eq(false)
    await expect(f.guard.connect(f.operator).returnAllToMinting(f.usdy.target))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(f.usdy.target)
    await expect(f.guard.connect(f.operator).returnToMinting(f.usdy.target, e('1')))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(f.usdy.target)
    // Returns are never paused, so pausing must not be what protects the reserve.
    await f.guard.connect(f.gatekeeper).setPaused(true)
    await expect(f.guard.connect(f.operator).returnAllToMinting(f.usdy.target))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(f.usdy.target)
    expect(await f.usdy.balanceOf(f.aegisMintingJUSDAddress)).eq(0)
    expect(await f.usdy.balanceOf(f.guard.target)).eq(e('900000'))

    // USDC is mint collateral, so it still returns as redemption liquidity — paused or not.
    await expect(f.guard.connect(f.operator).returnToMinting(f.usdc.target, u('1000000')))
      .emit(f.guard, 'ReturnedToMinting').withArgs(f.usdc.target, f.aegisMintingJUSDAddress, u('1000000'))
    expect(await f.minting.untrackedAvailableAssetBalance(f.usdc.target)).eq(u('1000000'))
  })

  it('keeps a scheduled minting change and the Ondo multisig from colliding', async () => {
    const f = await loadFixture(fixture)
    const next: any = await ethers.deployContract('TestToken', ['Next Minting', 'NXT', 6])
    await f.guard.beginMintingAddressChange(next.target)

    // Neither end of the scheduled change can be turned into the metered destination...
    await expect(f.guard.connect(f.gatekeeper).setOndoMultisig(next.target))
      .revertedWithCustomError(f.guard, 'InvalidAddress')
    // ...and the metered destination cannot be scheduled as the sink.
    await f.guard.cancelMintingAddressChange()
    await expect(f.guard.beginMintingAddressChange(f.ondo.address))
      .revertedWithCustomError(f.guard, 'InvalidAddress')

    // The multisig is not a whitelisted destination, so it carries no asset list of its own:
    // what it may receive is governed by the Ondo asset registry instead.
    expect(await f.guard.isDestination(f.ondo.address)).eq(false)
    expect(await f.guard.destinationAssets(f.ondo.address)).deep.eq([])
    await expect(f.guard.connect(f.operator).withdrawToOndo(f.usdc.target, u('1000')))
      .emit(f.guard, 'OndoWithdrawal').withArgs(f.usdc.target, u('1000'), usd('1000'), usd('1000'))

    // A venue, by contrast, needs USDY on its own list before any reserve can reach it.
    await f.guard.connect(f.operator).pullFromOndo(f.usdy.target, e('1000'))
    await expect(f.guard.connect(f.operator).withdraw(f.usdy.target, f.venue.address, e('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination').withArgs(f.venue.address, f.usdy.target)
    await f.guard.connect(f.gatekeeper).setDestinationAssets(f.venue.address, [f.usdy.target], true)
    await f.guard.connect(f.operator).withdraw(f.usdy.target, f.venue.address, e('1'))
    expect(await f.usdy.balanceOf(f.venue.address)).eq(e('1'))
  })

  it('carries real JUSD mint collateral through custody and back as redemption liquidity', async () => {
    const f = await loadFixture(fixture)
    const [, sender] = await ethers.getSigners()
    await f.aegisConfig.setOperator(f.owner.address, true)
    await f.aegisConfig['whitelistAddress(address,bool)'](sender.address, true)
    await f.assetContract.mint(sender.address, e('1000'))
    await f.assetContract.connect(sender).approve(f.aegisMintingJUSDAddress, e('1000'))

    const order = {
      orderType: OrderType.MINT, userWallet: sender.address, collateralAsset: f.assetAddress,
      collateralAmount: e('100'), yusdAmount: e('99.999'), slippageAdjustedAmount: e('99.999'),
      expiry: (await time.latest()) + 10000, nonce: Date.now(), additionalData: encodeString(''),
    }
    await f.minting.connect(sender).mint(order, await signOrderJUSD(order, f.aegisMintingJUSDAddress))
    expect(await f.minting.custodyAvailableAssetBalance(f.assetAddress)).eq(e('100'))

    // The guard draws its own collateral out of AegisMintingJUSD as a registered custodian.
    await expect(f.guard.connect(f.operator).pullFromMinting(f.assetAddress, e('60')))
      .emit(f.guard, 'PulledFromMinting').withArgs(f.assetAddress, f.aegisMintingJUSDAddress, e('60'))
    expect(await f.assetContract.balanceOf(f.guard.target)).eq(e('60'))
    // Collateral that never touched the Ondo multisig leaves the meter alone.
    expect(await f.guard.ondoOutstanding()).eq(0)

    // And it returns as untracked liquidity that funds redemptions.
    await expect(f.guard.connect(f.operator).returnToMinting(f.assetAddress, e('60')))
      .emit(f.guard, 'ReturnedToMinting').withArgs(f.assetAddress, f.aegisMintingJUSDAddress, e('60'))
    expect(await f.minting.untrackedAvailableAssetBalance(f.assetAddress)).eq(e('60'))
    expect(await f.minting.custodyAvailableAssetBalance(f.assetAddress)).eq(e('40'))
  })
})
