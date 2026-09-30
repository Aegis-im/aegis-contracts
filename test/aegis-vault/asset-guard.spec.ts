import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'

const orderTypes = { Order: [
  { name: 'orderType', type: 'uint8' }, { name: 'userWallet', type: 'address' },
  { name: 'collateralAsset', type: 'address' }, { name: 'collateralAmount', type: 'uint256' },
  { name: 'tokenAmount', type: 'uint256' }, { name: 'slippageAdjustedAmount', type: 'uint256' },
  { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'additionalData', type: 'bytes' },
] }

const z = ethers.ZeroAddress, e = ethers.parseEther, u = (v: string) => ethers.parseUnits(v, 6)
const data = (s: string) => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [s])
const COLLATERAL_MANAGER = ethers.id('COLLATERAL_MANAGER_ROLE'), WHITELIST_MANAGER = ethers.id('WHITELIST_MANAGER_ROLE')

async function fixture() {
  const [admin, investor, operator, gatekeeper, venue, stranger, insurance] = await ethers.getSigners()
  const collateral: any = await ethers.deployContract('TestToken', ['Collateral', 'COL', 6])
  const token: any = await ethers.deployContract('VaultToken', ['Bank Dollar', 'BANK', admin.address])
  const config: any = await ethers.deployContract('VaultConfig', [admin.address, [admin.address], admin.address])
  await config.disableWhitelist()
  const oracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['BANK / USD', 8, [admin.address], admin.address])
  const assetOracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['COL / USD', 6, [admin.address], admin.address])
  await oracle.updatePrice(100000000); await assetOracle.updatePrice(1000000)
  const minting: any = await ethers.deployContract('VaultMinting', ['Bank Minting', token.target, config.target, z, oracle.target, z, insurance.address, [collateral.target], [86400], [admin.address], admin.address, 86400, 86400])
  for (const r of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) await minting.grantRole(ethers.id(r), admin.address)
  await minting.setAssetPriceFeed(collateral.target, assetOracle.target)
  await token.setMinter(minting.target)
  await minting.setIncomeFeeBP(0)

  // The guard replaces the custody wallet: registered as a custodian address at
  // minting, and holding minting's collateral manager role so it can draw collateral itself.
  const guard: any = await ethers.deployContract('VaultAssetGuard', [minting.target, admin.address, 86400, [venue.address], ['Trading venue']])
  await minting.addCustodianAddress(guard.target)
  await minting.grantRole(COLLATERAL_MANAGER, guard.target)
  await guard.grantRole(COLLATERAL_MANAGER, operator.address)
  await guard.grantRole(WHITELIST_MANAGER, gatekeeper.address)

  await collateral.mint(investor.address, u('10000'))
  await collateral.connect(investor).approve(minting.target, ethers.MaxUint256)
  let nonce = 0
  async function order(type = 0, units = '100', id = 'request') {
    const o = { orderType: type, userWallet: investor.address, collateralAsset: collateral.target, collateralAmount: u(units), tokenAmount: e(units), slippageAdjustedAmount: type === 1 ? u(units) : e(units), expiry: (await time.latest()) + 3600, nonce: ++nonce, additionalData: data(id) }
    const sig = await admin.signTypedData({ name: 'Bank Minting', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: minting.target }, orderTypes, o)
    return [o, sig] as const
  }
  async function mint(units = '100') { await minting.connect(investor).mint(...await order(0, units)) }
  // Puts `units` of collateral inside the guard, the way a live deployment would.
  async function fund(units = '100') { await mint(units); await guard.connect(operator).pullFromMinting(collateral.target, u(units)) }
  return { admin, investor, operator, gatekeeper, venue, stranger, insurance, collateral, token, minting, guard, order, mint, fund }
}

describe('VaultAssetGuard gated asset management', () => {
  it('replaces the custody wallet end to end: minting → guard → venue → back → redeem payout', async () => {
    const f = await loadFixture(fixture)
    await f.mint('100')
    expect(await f.minting.custodyAvailableAssetBalance(f.collateral.target)).eq(u('100'))

    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, u('100')))
      .emit(f.guard, 'PulledFromMinting').withArgs(f.collateral.target, f.minting.target, u('100'))
    expect(await f.guard.assetBalance(f.collateral.target)).eq(u('100'))

    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('60')))
      .emit(f.guard, 'Withdrawal').withArgs(f.collateral.target, f.venue.address, u('60'))
    expect(await f.collateral.balanceOf(f.venue.address)).eq(u('60'))

    // Venue returns the position; the guard pushes it back as redemption liquidity.
    await f.collateral.connect(f.venue).transfer(f.guard.target, u('60'))
    await expect(f.guard.connect(f.operator).returnAllToMinting(f.collateral.target))
      .emit(f.guard, 'ReturnedToMinting').withArgs(f.collateral.target, f.minting.target, u('100'))
    expect(await f.minting.untrackedAvailableAssetBalance(f.collateral.target)).eq(u('100'))

    await f.token.connect(f.investor).approve(f.minting.target, e('25'))
    await f.minting.connect(f.investor).requestRedeem(...await f.order(1, '25'))
    await expect(f.minting.approveRedeemRequest('request', u('25'))).changeTokenBalance(f.collateral, f.investor, u('25'))
  })

  it('only lets assets out to whitelisted destinations or the minting contract', async () => {
    const f = await loadFixture(fixture); await f.fund()
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination').withArgs(f.stranger.address)
    await expect(f.guard.connect(f.operator).withdrawAll(f.collateral.target, f.stranger.address))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.minting.target, u('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, 0))
      .revertedWithCustomError(f.guard, 'InvalidAmount')

    // Removing a destination closes the route immediately, and clears its label.
    await f.guard.connect(f.gatekeeper).removeDestination(f.venue.address)
    expect(await f.guard.destinationLabel(f.venue.address)).eq('')
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    await expect(f.guard.connect(f.gatekeeper).removeDestination(f.venue.address))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
  })

  it('exposes no arbitrary-destination escape hatch', async () => {
    const f = await loadFixture(fixture)
    const names = f.guard.interface.fragments.filter((x: any) => x.type === 'function').map((x: any) => x.name)
    for (const forbidden of ['approve', 'rescueTokens', 'rescue', 'sweep', 'execute', 'call'])
      expect(names, `${forbidden} would void the whitelist`).not.include(forbidden)
  })

  it('separates the asset-moving role from the whitelist-managing role', async () => {
    const f = await loadFixture(fixture); await f.fund()
    await expect(f.guard.connect(f.gatekeeper).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.gatekeeper.address, COLLATERAL_MANAGER)
    await expect(f.guard.connect(f.gatekeeper).returnToMinting(f.collateral.target, u('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
    await expect(f.guard.connect(f.operator).addDestination(f.stranger.address, 'Unapproved'))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.operator.address, WHITELIST_MANAGER)
    await expect(f.guard.connect(f.operator).setPaused(true))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
    await expect(f.guard.connect(f.stranger).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
    // Neither operational role can repoint the redemption sink.
    await expect(f.guard.connect(f.gatekeeper).setMintingAddress(f.minting.target))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
  })

  it('maintains the whitelist with labels and enumeration', async () => {
    const f = await loadFixture(fixture)
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A'))
      .emit(f.guard, 'DestinationAdded').withArgs(f.stranger.address, 'Bank A')
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A again'))
      .revertedWithCustomError(f.guard, 'AlreadyWhitelisted').withArgs(f.stranger.address)
    await expect(f.guard.connect(f.gatekeeper).addDestination(z, 'Zero')).revertedWithCustomError(f.guard, 'ZeroAddress')
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.guard.target, 'Self')).revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.connect(f.gatekeeper).addDestinations([f.insurance.address], [])).revertedWithCustomError(f.guard, 'InvalidArrayLength')
    // The two exit routes never overlap, in either direction.
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.minting.target, 'Minting')).revertedWithCustomError(f.guard, 'InvalidAddress')
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 6])
    await f.guard.connect(f.gatekeeper).addDestination(other.target, 'Elsewhere')
    await expect(f.guard.setMintingAddress(other.target)).revertedWithCustomError(f.guard, 'InvalidAddress')
    await f.guard.connect(f.gatekeeper).removeDestination(other.target)

    expect(await f.guard.destinationCount()).eq(2)
    expect(await f.guard.destinations()).deep.eq([f.venue.address, f.stranger.address])
    expect(await f.guard.destinationAt(0)).deep.eq([f.venue.address, 'Trading venue'])
    expect(await f.guard.isDestination(f.insurance.address)).eq(false)

    await f.guard.connect(f.gatekeeper).addDestinations([f.insurance.address, f.admin.address], ['Insurance', 'Treasury'])
    await f.guard.connect(f.gatekeeper).removeDestinations([f.insurance.address, f.admin.address])
    expect(await f.guard.destinationCount()).eq(2)
  })

  it('pauses outbound movement and draws, but never the return of redemption liquidity', async () => {
    const f = await loadFixture(fixture); await f.fund(); await f.mint()
    await expect(f.guard.connect(f.gatekeeper).setPaused(true)).emit(f.guard, 'PausedChanged').withArgs(true)
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1'))).revertedWithCustomError(f.guard, 'Paused')
    await expect(f.guard.connect(f.operator).withdrawBatch([f.collateral.target], [f.venue.address], [u('1')])).revertedWithCustomError(f.guard, 'Paused')
    await expect(f.guard.connect(f.operator).withdrawNative(f.venue.address, 1)).revertedWithCustomError(f.guard, 'Paused')
    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, u('1'))).revertedWithCustomError(f.guard, 'Paused')
    await expect(f.guard.connect(f.operator).pullAllFromMinting(f.collateral.target)).revertedWithCustomError(f.guard, 'Paused')

    await expect(f.guard.connect(f.operator).returnToMinting(f.collateral.target, u('40')))
      .emit(f.guard, 'ReturnedToMinting').withArgs(f.collateral.target, f.minting.target, u('40'))
    await f.guard.connect(f.gatekeeper).setPaused(false)
    await f.guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('60'))
    expect(await f.guard.assetBalance(f.collateral.target)).eq(0)
  })

  it('moves several assets in one call and refuses malformed batches', async () => {
    const f = await loadFixture(fixture); await f.fund('200')
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 18])
    await other.mint(f.guard.target, e('5'))
    await f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A')
    await f.guard.connect(f.operator).withdrawBatch(
      [f.collateral.target, f.collateral.target, other.target],
      [f.venue.address, f.stranger.address, f.venue.address],
      [u('50'), u('30'), e('5')],
    )
    expect(await f.collateral.balanceOf(f.venue.address)).eq(u('50'))
    expect(await f.collateral.balanceOf(f.stranger.address)).eq(u('30'))
    expect(await other.balanceOf(f.venue.address)).eq(e('5'))
    await expect(f.guard.connect(f.operator).withdrawBatch([f.collateral.target], [f.venue.address], []))
      .revertedWithCustomError(f.guard, 'InvalidArrayLength')
    await expect(f.guard.connect(f.operator).withdrawBatch([], [], []))
      .revertedWithCustomError(f.guard, 'InvalidArrayLength')
    // One bad leg reverts the whole batch.
    await expect(f.guard.connect(f.operator).withdrawBatch(
      [f.collateral.target, f.collateral.target], [f.venue.address, f.insurance.address], [u('1'), u('1')],
    )).revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    expect(await f.collateral.balanceOf(f.venue.address)).eq(u('50'))
  })

  it('returns collateral as redemption liquidity that cannot be drawn back out', async () => {
    const f = await loadFixture(fixture); await f.fund('100')
    expect(await f.minting.custodyAvailableAssetBalance(f.collateral.target)).eq(0)

    await f.guard.connect(f.operator).returnToMinting(f.collateral.target, u('100'))
    // Returned collateral lands as untracked liquidity — the balance redeem approvals pay from.
    expect(await f.minting.untrackedAvailableAssetBalance(f.collateral.target)).eq(u('100'))
    // It is not custody-transferrable, so no collateral manager — including the guard — can move it back out.
    expect(await f.minting.custodyAvailableAssetBalance(f.collateral.target)).eq(0)
    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, u('1')))
      .revertedWithCustomError(f.minting, 'NotEnoughFunds')
    await expect(f.guard.connect(f.operator).pullAllFromMinting(f.collateral.target))
      .revertedWithCustomError(f.minting, 'NotEnoughFunds')
    await expect(f.minting.forceTransferToCustody(f.guard.target, f.collateral.target))
      .revertedWithCustomError(f.minting, 'NotEnoughFunds')

    // A new mint brings its own collateral from the user; returned liquidity is untouched by it.
    await f.mint('50')
    expect(await f.minting.untrackedAvailableAssetBalance(f.collateral.target)).eq(u('100'))
    expect(await f.minting.custodyAvailableAssetBalance(f.collateral.target)).eq(u('50'))

    // The full returned amount is redeemable.
    await f.token.connect(f.investor).approve(f.minting.target, e('100'))
    await f.minting.connect(f.investor).requestRedeem(...await f.order(1, '100'))
    await expect(f.minting.approveRedeemRequest('request', u('100')))
      .changeTokenBalance(f.collateral, f.investor, u('100'))
    expect(await f.minting.untrackedAvailableAssetBalance(f.collateral.target)).eq(0)
  })

  it('returns only assets minting supports, so nothing can be stranded there', async () => {
    const f = await loadFixture(fixture); await f.fund()
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 18])
    await other.mint(f.guard.target, e('5'))
    await expect(f.guard.connect(f.operator).returnToMinting(other.target, e('1')))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(other.target)
    await expect(f.guard.connect(f.operator).returnAllToMinting(other.target))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(other.target)
    // This route is never paused, so the check is what holds during an incident.
    await f.guard.connect(f.gatekeeper).setPaused(true)
    await expect(f.guard.connect(f.operator).returnAllToMinting(other.target))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(other.target)
    expect(await other.balanceOf(f.minting.target)).eq(0)

    // Support is read from minting at the time of the call: listing opens the route, delisting closes it.
    await f.minting.addSupportedAsset(other.target, 86400)
    await expect(f.guard.connect(f.operator).returnToMinting(other.target, e('2')))
      .emit(f.guard, 'ReturnedToMinting').withArgs(other.target, f.minting.target, e('2'))
    await f.minting.removeSupportedAsset(other.target)
    await expect(f.guard.connect(f.operator).returnAllToMinting(other.target))
      .revertedWithCustomError(f.guard, 'NotSupportedAsset').withArgs(other.target)

    // A sink that is not a minting contract cannot vouch for any asset, so it receives nothing.
    await f.guard.setMintingAddress(other.target)
    await expect(f.guard.connect(f.operator).returnToMinting(f.collateral.target, u('1'))).reverted
    expect(await f.collateral.balanceOf(other.target)).eq(0)
  })

  it('draws collateral from minting only within what minting allows', async () => {
    const f = await loadFixture(fixture); await f.mint('100')
    await f.minting.freezeFunds(f.collateral.target, u('30'))
    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, u('71')))
      .revertedWithCustomError(f.minting, 'NotEnoughFunds')
    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, 0))
      .revertedWithCustomError(f.guard, 'InvalidAmount')
    await expect(f.guard.connect(f.operator).pullAllFromMinting(f.collateral.target))
      .emit(f.guard, 'PulledFromMinting').withArgs(f.collateral.target, f.minting.target, u('70'))
    await expect(f.guard.connect(f.operator).pullAllFromMinting(f.collateral.target))
      .revertedWithCustomError(f.minting, 'NotEnoughFunds')

    // Losing the role at minting, or the custodian registration, closes the draw.
    await f.mint('50')
    await f.minting.revokeRole(COLLATERAL_MANAGER, f.guard.target)
    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, u('10')))
      .revertedWithCustomError(f.minting, 'AccessControlUnauthorizedAccount')
    await f.minting.grantRole(COLLATERAL_MANAGER, f.guard.target)
    await f.minting.removeCustodianAddress(f.guard.target)
    await expect(f.guard.connect(f.operator).pullFromMinting(f.collateral.target, u('10')))
      .revertedWithCustomError(f.minting, 'InvalidCustodianAddress')
  })

  it('restricts the redemption sink to a contract set by the admin', async () => {
    const f = await loadFixture(fixture)
    await expect(f.guard.setMintingAddress(z)).revertedWithCustomError(f.guard, 'ZeroAddress')
    await expect(f.guard.setMintingAddress(f.stranger.address)).revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.setMintingAddress(f.guard.target)).revertedWithCustomError(f.guard, 'InvalidAddress')
    const replacement: any = await ethers.deployContract('TestToken', ['Next Minting', 'NXT', 6])
    await expect(f.guard.setMintingAddress(replacement.target))
      .emit(f.guard, 'MintingAddressChanged').withArgs(replacement.target)
    expect(await f.guard.mintingAddress()).eq(replacement.target)

    // A deployment that has not been pointed at minting yet cannot move funds there.
    const unbound: any = await ethers.deployContract('VaultAssetGuard', [z, f.admin.address, 86400, [], []])
    await unbound.grantRole(COLLATERAL_MANAGER, f.operator.address)
    expect(await unbound.mintingAddress()).eq(z)
    await expect(unbound.connect(f.operator).returnToMinting(f.collateral.target, u('1'))).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).returnAllToMinting(f.collateral.target)).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).pullFromMinting(f.collateral.target, u('1'))).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).pullAllFromMinting(f.collateral.target)).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(ethers.deployContract('VaultAssetGuard', [z, f.admin.address, 86400, [f.venue.address], []])).reverted
  })

  it('recovers native currency through the same gate', async () => {
    const f = await loadFixture(fixture)
    await expect(f.admin.sendTransaction({ to: f.guard.target, value: e('1') }))
      .emit(f.guard, 'NativeReceived').withArgs(f.admin.address, e('1'))
    await expect(f.guard.connect(f.operator).withdrawNative(f.stranger.address, e('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    await expect(f.guard.connect(f.operator).withdrawNative(f.venue.address, e('2')))
      .revertedWithCustomError(f.guard, 'InvalidAmount')
    await expect(f.guard.connect(f.operator).withdrawNative(f.venue.address, e('1')))
      .changeEtherBalances([f.guard, f.venue], [-e('1'), e('1')])
  })

  it('returns nothing when there is nothing to move', async () => {
    const f = await loadFixture(fixture)
    await expect(f.guard.connect(f.operator).returnAllToMinting(f.collateral.target)).revertedWithCustomError(f.guard, 'InvalidAmount')
    await expect(f.guard.connect(f.operator).withdrawAll(f.collateral.target, f.venue.address)).revertedWithCustomError(f.guard, 'InvalidAmount')
  })
})
