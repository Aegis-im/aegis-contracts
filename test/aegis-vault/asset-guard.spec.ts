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
// CCTP domains are Circle's own numbering, not chain ids.
const ARBITRUM = 3, BASE = 6, SOLANA = 5, HYPEREVM = 19
const b32 = (a: string) => ethers.zeroPadValue(a, 32)
const data = (s: string) => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [s])
const COLLATERAL_MANAGER = ethers.id('COLLATERAL_MANAGER_ROLE'), WHITELIST_MANAGER = ethers.id('WHITELIST_MANAGER_ROLE')

async function fixture() {
  const [admin, investor, operator, gatekeeper, venue, stranger, insurance, hyperliquid] = await ethers.getSigners()
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
  const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
  const messenger: any = await ethers.deployContract('MockTokenMessenger', [[ARBITRUM, BASE]])
  const guard: any = await ethers.deployContract('VaultAssetGuard', [minting.target, admin.address, 86400, [venue.address], ['Trading venue'], [[collateral.target, NATIVE]], 0, 0, [operator.address], [gatekeeper.address], messenger.target, [{ domain: ARBITRUM, mintRecipient: b32(hyperliquid.address), label: 'Hyperliquid deposit', assets: [collateral.target] }]])
  await minting.addCustodianAddress(guard.target)
  await minting.grantRole(COLLATERAL_MANAGER, guard.target)

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
  return { admin, investor, operator, gatekeeper, venue, stranger, insurance, hyperliquid, collateral, token, minting, guard, messenger, order, mint, fund, NATIVE }
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
    await expect(f.guard.connect(f.operator).addDestination(f.stranger.address, 'Unapproved', [f.collateral.target]))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.operator.address, WHITELIST_MANAGER)
    await expect(f.guard.connect(f.operator).setPaused(true))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
    await expect(f.guard.connect(f.stranger).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
    // The redemption sink belongs to the whitelist manager — not to the mover, and not to admin.
    for (const who of [f.operator, f.admin, f.stranger]) {
      await expect(f.guard.connect(who).beginMintingAddressChange(f.minting.target))
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(who.address, WHITELIST_MANAGER)
      await expect(f.guard.connect(who).applyMintingAddressChange())
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(who.address, WHITELIST_MANAGER)
      await expect(f.guard.connect(who).cancelMintingAddressChange())
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(who.address, WHITELIST_MANAGER)
    }
  })

  it('fixes both roles at construction so no one can ever change them', async () => {
    const f = await loadFixture(fixture)
    expect(await f.guard.hasRole(COLLATERAL_MANAGER, f.operator.address)).eq(true)
    expect(await f.guard.hasRole(WHITELIST_MANAGER, f.gatekeeper.address)).eq(true)

    // Nobody grants or revokes — not the admin, not a role holder, not a stranger.
    for (const who of [f.admin, f.gatekeeper, f.operator, f.stranger]) {
      await expect(f.guard.connect(who).grantRole(COLLATERAL_MANAGER, f.stranger.address))
        .revertedWithCustomError(f.guard, 'RolesAreImmutable')
      await expect(f.guard.connect(who).revokeRole(WHITELIST_MANAGER, f.gatekeeper.address))
        .revertedWithCustomError(f.guard, 'RolesAreImmutable')
    }
    // Nor can a holder drop its own role and strand the capability.
    await expect(f.guard.connect(f.operator).renounceRole(COLLATERAL_MANAGER, f.operator.address))
      .revertedWithCustomError(f.guard, 'RolesAreImmutable')
    await expect(f.guard.connect(f.gatekeeper).renounceRole(WHITELIST_MANAGER, f.gatekeeper.address))
      .revertedWithCustomError(f.guard, 'RolesAreImmutable')

    // Admin is left with no power over the guard at all.
    await expect(f.guard.connect(f.admin).setPaused(true))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')
    await expect(f.guard.connect(f.admin).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount')

    // And a guard that could never move or never pause cannot be deployed in the first place.
    const args = (cm: string[], wm: string[]) =>
      [f.minting.target, f.admin.address, 86400, [], [], [], 0, 0, cm, wm, z, []]
    await expect(ethers.deployContract('VaultAssetGuard', args([], [f.gatekeeper.address])))
      .revertedWithCustomError(f.guard, 'NoRoleHolders').withArgs(COLLATERAL_MANAGER)
    await expect(ethers.deployContract('VaultAssetGuard', args([f.operator.address], [])))
      .revertedWithCustomError(f.guard, 'NoRoleHolders').withArgs(WHITELIST_MANAGER)
    await expect(ethers.deployContract('VaultAssetGuard', args([z], [f.gatekeeper.address])))
      .revertedWithCustomError(f.guard, 'ZeroAddress')
  })

  it('maintains the whitelist with labels and enumeration', async () => {
    const f = await loadFixture(fixture)
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [f.collateral.target]))
      .emit(f.guard, 'DestinationAdded').withArgs(f.stranger.address, 'Bank A')
      .and.emit(f.guard, 'DestinationAssetChanged').withArgs(f.stranger.address, f.collateral.target, true)
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A again', []))
      .revertedWithCustomError(f.guard, 'AlreadyWhitelisted').withArgs(f.stranger.address)
    await expect(f.guard.connect(f.gatekeeper).addDestination(z, 'Zero', [])).revertedWithCustomError(f.guard, 'ZeroAddress')
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.guard.target, 'Self', [])).revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.connect(f.gatekeeper).addDestinations([f.insurance.address], [], [[]])).revertedWithCustomError(f.guard, 'InvalidArrayLength')
    // The two exit routes never overlap, in either direction.
    await expect(f.guard.connect(f.gatekeeper).addDestination(f.minting.target, 'Minting', [])).revertedWithCustomError(f.guard, 'InvalidAddress')
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 6])
    await f.guard.connect(f.gatekeeper).addDestination(other.target, 'Elsewhere', [])
    await expect(f.guard.connect(f.gatekeeper).beginMintingAddressChange(other.target)).revertedWithCustomError(f.guard, 'InvalidAddress')
    await f.guard.connect(f.gatekeeper).removeDestination(other.target)

    expect(await f.guard.destinationCount()).eq(2)
    expect(await f.guard.destinations()).deep.eq([f.venue.address, f.stranger.address])
    expect(await f.guard.destinationAt(0)).deep.eq([f.venue.address, 'Trading venue'])
    expect(await f.guard.isDestination(f.insurance.address)).eq(false)

    await f.guard.connect(f.gatekeeper).addDestinations([f.insurance.address, f.admin.address], ['Insurance', 'Treasury'], [[], []])
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
    await f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [f.collateral.target])
    await f.guard.connect(f.gatekeeper).setDestinationAssets(f.venue.address, [other.target], true)
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
    await f.guard.connect(f.gatekeeper).beginMintingAddressChange(other.target)
    await f.guard.connect(f.gatekeeper).applyMintingAddressChange()
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
    await expect(f.guard.connect(f.gatekeeper).beginMintingAddressChange(z)).revertedWithCustomError(f.guard, 'ZeroAddress')
    await expect(f.guard.connect(f.gatekeeper).beginMintingAddressChange(f.stranger.address)).revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.connect(f.gatekeeper).beginMintingAddressChange(f.guard.target)).revertedWithCustomError(f.guard, 'InvalidAddress')
    const replacement: any = await ethers.deployContract('TestToken', ['Next Minting', 'NXT', 6])
    await f.guard.connect(f.gatekeeper).beginMintingAddressChange(replacement.target)
    await expect(f.guard.connect(f.gatekeeper).applyMintingAddressChange())
      .emit(f.guard, 'MintingAddressChanged').withArgs(replacement.target)
    expect(await f.guard.mintingAddress()).eq(replacement.target)
    // The immediate setter is reserved for a sink that was never named.
    await expect(f.guard.connect(f.gatekeeper).setMintingAddress(replacement.target))
      .revertedWithCustomError(f.guard, 'MintingAlreadySet').withArgs(replacement.target)

    // A deployment that has not been pointed at minting yet cannot move funds there.
    const unbound: any = await ethers.deployContract('VaultAssetGuard', [z, f.admin.address, 86400, [], [], [], 0, 0, [f.operator.address], [f.gatekeeper.address], z, []])
    expect(await unbound.mintingAddress()).eq(z)
    await expect(unbound.connect(f.gatekeeper).beginMintingAddressChange(replacement.target)).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).returnToMinting(f.collateral.target, u('1'))).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).returnAllToMinting(f.collateral.target)).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).pullFromMinting(f.collateral.target, u('1'))).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(unbound.connect(f.operator).pullAllFromMinting(f.collateral.target)).revertedWithCustomError(unbound, 'MintingNotConfigured')
    await expect(ethers.deployContract('VaultAssetGuard', [z, f.admin.address, 86400, [f.venue.address], [], [[]], 0, 0, [f.operator.address], [f.gatekeeper.address], z, []])).reverted
  })

  it('makes the constructor whitelist usable from deployment, unlike later additions', async () => {
    const f = await loadFixture(fixture)
    const DAY = 86400
    // Same cooldown, two destinations: one seeded at construction, one added afterwards.
    const guard: any = await ethers.deployContract('VaultAssetGuard', [
      f.minting.target, f.admin.address, 86400,
      [f.venue.address], ['Trading venue'], [[f.collateral.target]],
      DAY, 0, [f.operator.address], [f.gatekeeper.address], z, [],
    ])
    await f.collateral.mint(guard.target, u('100'))

    // Seeded at construction: live right now, no waiting.
    const deployedAt = BigInt((await ethers.provider.getBlock(guard.deploymentTransaction()!.blockNumber!))!.timestamp)
    expect(await guard.destinationActiveAt(f.venue.address)).eq(deployedAt)
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1')))
      .emit(guard, 'Withdrawal').withArgs(f.collateral.target, f.venue.address, u('1'))

    // Added afterwards: the cooldown applies, because now it is an address appearing on a live contract.
    await guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [f.collateral.target])
    const addedAt = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
    expect(await guard.destinationActiveAt(f.stranger.address)).eq(addedAt + BigInt(DAY))
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .revertedWithCustomError(guard, 'DestinationInCooldown').withArgs(f.stranger.address, addedAt + BigInt(DAY))
    await time.increase(DAY + 1)
    await guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1'))

    // Re-adding a constructor destination does NOT keep the exemption — it is a later addition now.
    await guard.connect(f.gatekeeper).removeDestination(f.venue.address)
    expect(await guard.destinationActiveAt(f.venue.address)).eq(0)
    await guard.connect(f.gatekeeper).addDestination(f.venue.address, 'Trading venue', [f.collateral.target])
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(guard, 'DestinationInCooldown')
  })

  it('holds a newly whitelisted destination in cooldown, but removes it immediately', async () => {
    const f = await loadFixture(fixture)
    const DAY = 86400
    const guard: any = await ethers.deployContract('VaultAssetGuard', [f.minting.target, f.admin.address, 86400, [f.venue.address], ['Trading venue'], [[f.collateral.target, f.NATIVE]], DAY, 0, [f.operator.address], [f.gatekeeper.address], z, []])
    expect(await guard.whitelistCooldown()).eq(DAY)
    await f.collateral.mint(guard.target, u('100'))
    await f.admin.sendTransaction({ to: guard.target, value: e('1') })

    // A destination added after deployment carries the cooldown, on every push path.
    await guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [f.collateral.target, f.NATIVE])
    const addedAt = (await ethers.provider.getBlock('latest'))!.timestamp
    const activeAt = await guard.destinationActiveAt(f.stranger.address)
    expect(await guard.destinationAddedAt(f.stranger.address)).eq(addedAt)
    expect(activeAt).eq(BigInt(addedAt) + BigInt(DAY))
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .revertedWithCustomError(guard, 'DestinationInCooldown').withArgs(f.stranger.address, activeAt)
    await expect(guard.connect(f.operator).withdrawAll(f.collateral.target, f.stranger.address))
      .revertedWithCustomError(guard, 'DestinationInCooldown')
    await expect(guard.connect(f.operator).withdrawBatch([f.collateral.target], [f.stranger.address], [u('1')]))
      .revertedWithCustomError(guard, 'DestinationInCooldown')
    await expect(guard.connect(f.operator).withdrawNative(f.stranger.address, 1))
      .revertedWithCustomError(guard, 'DestinationInCooldown')

    // Locked one second before; open exactly at activeAt.
    await time.setNextBlockTimestamp(activeAt - 1n)
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .revertedWithCustomError(guard, 'DestinationInCooldown')
    await time.setNextBlockTimestamp(activeAt)
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .emit(guard, 'Withdrawal').withArgs(f.collateral.target, f.stranger.address, u('1'))
    await guard.connect(f.operator).withdrawNative(f.stranger.address, 1)

    // The constructor destination was never delayed and still is not.
    await guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1'))

    // Removal is immediate, and re-adding restarts the cooldown from scratch.
    await guard.connect(f.gatekeeper).removeDestination(f.venue.address)
    expect(await guard.destinationAddedAt(f.venue.address)).eq(0)
    expect(await guard.destinationActiveAt(f.venue.address)).eq(0)
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(guard, 'NotWhitelistedDestination')
    await guard.connect(f.gatekeeper).addDestination(f.venue.address, 'Trading venue', [f.collateral.target])
    await expect(guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(guard, 'DestinationInCooldown')
    await time.increase(DAY + 1)
    await guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1'))

    // The cooldown gates pushes to destinations only; returns to minting are never delayed.
    await expect(guard.connect(f.operator).returnToMinting(f.collateral.target, u('1')))
      .emit(guard, 'ReturnedToMinting')
  })

  it('lets a new destination receive funds at once when the cooldown is zero', async () => {
    const f = await loadFixture(fixture); await f.fund()
    expect(await f.guard.whitelistCooldown()).eq(0)
    await f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [f.collateral.target])
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .emit(f.guard, 'Withdrawal').withArgs(f.collateral.target, f.stranger.address, u('1'))
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

  it('gates every withdrawal on the destination own asset list', async () => {
    const f = await loadFixture(fixture); await f.fund('200')
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 18])
    await other.mint(f.guard.target, e('10'))
    await f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [other.target])

    // Whitelisting an address is not permission to send it anything: the pair has to be allowed.
    expect(await f.guard.isDestinationAsset(f.stranger.address, other.target)).eq(true)
    expect(await f.guard.isDestinationAsset(f.stranger.address, f.collateral.target)).eq(false)
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.stranger.address, u('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination').withArgs(f.stranger.address, f.collateral.target)
    await expect(f.guard.connect(f.operator).withdraw(other.target, f.venue.address, e('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination').withArgs(f.venue.address, other.target)
    await f.guard.connect(f.operator).withdraw(other.target, f.stranger.address, e('1'))
    expect(await other.balanceOf(f.stranger.address)).eq(e('1'))

    // withdrawAll and withdrawBatch go through the same gate.
    await expect(f.guard.connect(f.operator).withdrawAll(f.collateral.target, f.stranger.address))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination')
    await expect(f.guard.connect(f.operator).withdrawBatch([f.collateral.target], [f.stranger.address], [u('1')]))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination')

    // Amending a live destination opens and closes single pairs.
    await expect(f.guard.connect(f.gatekeeper).setDestinationAssets(f.venue.address, [other.target], true))
      .emit(f.guard, 'DestinationAssetChanged').withArgs(f.venue.address, other.target, true)
    await f.guard.connect(f.operator).withdraw(other.target, f.venue.address, e('1'))
    await f.guard.connect(f.gatekeeper).setDestinationAssets(f.venue.address, [f.collateral.target], false)
    await expect(f.guard.connect(f.operator).withdraw(f.collateral.target, f.venue.address, u('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination').withArgs(f.venue.address, f.collateral.target)
    // Swap-and-pop reorders the set, so compare membership rather than position.
    expect([...await f.guard.destinationAssets(f.venue.address)]).to.have.members([f.NATIVE, other.target])

    await expect(f.guard.connect(f.gatekeeper).setDestinationAssets(f.insurance.address, [other.target], true))
      .revertedWithCustomError(f.guard, 'NotWhitelistedDestination')
    await expect(f.guard.connect(f.gatekeeper).setDestinationAssets(f.venue.address, [], true))
      .revertedWithCustomError(f.guard, 'InvalidArrayLength')
    await expect(f.guard.connect(f.operator).setDestinationAssets(f.venue.address, [other.target], false))
      .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(f.operator.address, WHITELIST_MANAGER)

    // Removing a destination clears its pairs, so re-adding it never resurrects old permissions.
    await f.guard.connect(f.gatekeeper).removeDestination(f.stranger.address)
    expect(await f.guard.destinationAssets(f.stranger.address)).deep.eq([])
    await f.guard.connect(f.gatekeeper).addDestination(f.stranger.address, 'Bank A', [])
    await expect(f.guard.connect(f.operator).withdraw(other.target, f.stranger.address, e('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination').withArgs(f.stranger.address, other.target)

    // Native currency needs its own entry, under the sentinel.
    await f.admin.sendTransaction({ to: f.guard.target, value: e('1') })
    await expect(f.guard.connect(f.operator).withdrawNative(f.stranger.address, e('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForDestination').withArgs(f.stranger.address, f.NATIVE)
    await f.guard.connect(f.gatekeeper).setDestinationAssets(f.stranger.address, [f.NATIVE], true)
    await expect(f.guard.connect(f.operator).withdrawNative(f.stranger.address, e('1')))
      .changeEtherBalances([f.guard, f.stranger], [-e('1'), e('1')])
  })

  it('holds a change of the redemption sink for its cooldown', async () => {
    const f = await loadFixture(fixture)
    const DAY = 86400
    const guard: any = await ethers.deployContract('VaultAssetGuard', [f.minting.target, f.admin.address, 86400, [], [], [], 0, DAY, [f.operator.address], [f.gatekeeper.address], z, []])
    expect(await guard.mintingChangeDelay()).eq(DAY)
    const next: any = await ethers.deployContract('TestToken', ['Next Minting', 'NXT', 6])

    await expect(guard.connect(f.gatekeeper).applyMintingAddressChange()).revertedWithCustomError(guard, 'NoPendingMintingChange')
    await expect(guard.connect(f.gatekeeper).cancelMintingAddressChange()).revertedWithCustomError(guard, 'NoPendingMintingChange')

    const started = await guard.connect(f.gatekeeper).beginMintingAddressChange(next.target)
    const activeAt = BigInt((await ethers.provider.getBlock(started.blockNumber!))!.timestamp) + BigInt(DAY)
    await expect(started).emit(guard, 'MintingAddressChangeStarted').withArgs(next.target, activeAt)
    expect(await guard.pendingMintingAddress()).eq(next.target)
    expect(await guard.mintingChangeActiveAt()).eq(activeAt)
    // The sink does not move while the cooldown runs.
    expect(await guard.mintingAddress()).eq(f.minting.target)
    await expect(guard.connect(f.gatekeeper).applyMintingAddressChange())
      .revertedWithCustomError(guard, 'MintingChangeInCooldown').withArgs(next.target, activeAt)

    // A pending sink cannot be whitelisted, so the scheduled change cannot be blocked from under it.
    await expect(guard.connect(f.gatekeeper).addDestination(next.target, 'Pending sink', []))
      .revertedWithCustomError(guard, 'InvalidAddress')

    await time.setNextBlockTimestamp(activeAt)
    await expect(guard.connect(f.gatekeeper).applyMintingAddressChange()).emit(guard, 'MintingAddressChanged').withArgs(next.target)
    expect(await guard.mintingAddress()).eq(next.target)
    expect(await guard.pendingMintingAddress()).eq(z)
    expect(await guard.mintingChangeActiveAt()).eq(0)

    // And a proposal can be abandoned before it matures.
    await guard.connect(f.gatekeeper).beginMintingAddressChange(f.minting.target)
    await expect(guard.connect(f.gatekeeper).cancelMintingAddressChange()).emit(guard, 'MintingAddressChangeCancelled').withArgs(f.minting.target)
    expect(await guard.pendingMintingAddress()).eq(z)
    await time.increase(DAY + 1)
    await expect(guard.connect(f.gatekeeper).applyMintingAddressChange()).revertedWithCustomError(guard, 'NoPendingMintingChange')
    expect(await guard.mintingAddress()).eq(next.target)
  })

  it('returns nothing when there is nothing to move', async () => {
    const f = await loadFixture(fixture)
    await expect(f.guard.connect(f.operator).returnAllToMinting(f.collateral.target)).revertedWithCustomError(f.guard, 'InvalidAmount')
    await expect(f.guard.connect(f.operator).withdrawAll(f.collateral.target, f.venue.address)).revertedWithCustomError(f.guard, 'InvalidAmount')
  })
})

describe('VaultAssetGuard CCTP bridge', () => {
  const ROUTE = (domain: number, recipient: string) =>
    ethers.AbiCoder.defaultAbiCoder().encode(['uint32', 'bytes32'], [domain, b32(recipient)])
  const routeId = (domain: number, recipient: string) => ethers.keccak256(ROUTE(domain, recipient))

  it('bridges to a seeded route and leaves no standing allowance behind', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    const to = b32(f.hyperliquid.address)

    // Seeded in the constructor, so usable from deployment — same rule as the whitelist.
    const deployedAt = BigInt((await ethers.provider.getBlock(f.guard.deploymentTransaction()!.blockNumber!))!.timestamp)
    expect(await f.guard.isCctpRoute(ARBITRUM, to)).eq(true)
    expect(await f.guard.cctpRouteActiveAt(ARBITRUM, to)).eq(deployedAt)
    expect(await f.guard.cctpRouteCount()).eq(1)
    expect(await f.guard.cctpRouteId(ARBITRUM, to)).eq(routeId(ARBITRUM, f.hyperliquid.address))
    expect(await f.guard.addressToBytes32(f.hyperliquid.address)).eq(to)

    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('40')))
      .emit(f.guard, 'CctpBridged').withArgs(f.collateral.target, routeId(ARBITRUM, f.hyperliquid.address), ARBITRUM, to, u('40'))

    // The USDC left, the messenger took exactly it, and nothing is left approved afterwards.
    expect(await f.guard.assetBalance(f.collateral.target)).eq(u('60'))
    expect(await f.collateral.balanceOf(f.messenger.target)).eq(u('40'))
    expect(await f.collateral.allowance(f.guard.target, f.messenger.target)).eq(0)

    const burn = await f.messenger.burns(0)
    expect(burn.amount).eq(u('40'))
    expect(burn.domain).eq(ARBITRUM)
    expect(burn.mintRecipient).eq(to)
    expect(burn.burnToken).eq(f.collateral.target)
    expect(burn.caller).eq(f.guard.target)
    // Always a standard CCTP v2 transfer: no fee, finalized source block, anyone may relay.
    expect(burn.destinationCaller).eq(ethers.ZeroHash)
    expect(burn.maxFee).eq(0)
    expect(burn.minFinalityThreshold).eq(2000)
  })

  it('bridges straight to a Safe on HyperEVM once its route clears the cooldown', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    // Domain 19 is served by CCTP v2 only; a guard seeing it as unsupported refuses the route.
    const messenger: any = await ethers.deployContract('MockTokenMessenger', [[HYPEREVM]])
    const guard: any = await ethers.deployContract('VaultAssetGuard', [f.minting.target, f.admin.address, 86400, [], [], [], 86400, 0, [f.operator.address], [f.gatekeeper.address], messenger.target, []])
    await f.collateral.mint(guard.target, u('100'))
    await expect(guard.connect(f.gatekeeper).addCctpRoute(ARBITRUM, b32(f.stranger.address), 'Arbitrum', [f.collateral.target]))
      .revertedWithCustomError(guard, 'UnsupportedCctpDomain').withArgs(ARBITRUM)

    // The recipient is the Safe's address on HyperEVM; USDC mints there, not on HyperCore.
    const safe = b32(f.stranger.address)
    await guard.connect(f.gatekeeper).addCctpRoute(HYPEREVM, safe, 'HyperEVM Safe', [f.collateral.target])
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, HYPEREVM, safe, u('25')))
      .revertedWithCustomError(guard, 'CctpRouteInCooldown')
    await time.increase(86401)
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, HYPEREVM, safe, u('25')))
      .emit(guard, 'CctpBridged').withArgs(f.collateral.target, routeId(HYPEREVM, f.stranger.address), HYPEREVM, safe, u('25'))

    const burn = await messenger.burns(0)
    expect(burn.domain).eq(HYPEREVM)
    expect(burn.mintRecipient).eq(safe)
    expect(burn.maxFee).eq(0)
    expect(burn.minFinalityThreshold).eq(2000)
    expect(await f.collateral.allowance(guard.target, messenger.target)).eq(0)
  })

  it('refuses every destination the whitelist manager has not named', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    const to = b32(f.hyperliquid.address)

    // Right domain, wrong recipient: the route is the pair, so this is simply not a route.
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, b32(f.stranger.address), u('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedRoute').withArgs(ARBITRUM, b32(f.stranger.address))
    // Right recipient, wrong domain — approving Arbitrum does not approve Base.
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, BASE, to, u('1')))
      .revertedWithCustomError(f.guard, 'NotWhitelistedRoute').withArgs(BASE, to)
    // Approved route, asset never allowed on it.
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 6])
    await other.mint(f.guard.target, u('100'))
    await expect(f.guard.connect(f.operator).bridgeCctp(other.target, ARBITRUM, to, u('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForRoute')
      .withArgs(routeId(ARBITRUM, f.hyperliquid.address), other.target)
    // Nothing at all.
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, 0))
      .revertedWithCustomError(f.guard, 'InvalidAmount')
  })

  it('reserves bridging to the collateral manager and routes to the whitelist manager', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    const to = b32(f.hyperliquid.address)
    const newTo = b32(f.stranger.address)

    // The mover cannot name a destination...
    for (const caller of [f.operator, f.admin, f.stranger]) {
      await expect(f.guard.connect(caller).addCctpRoute(BASE, newTo, 'Elsewhere', [f.collateral.target]))
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(caller.address, WHITELIST_MANAGER)
      await expect(f.guard.connect(caller).removeCctpRoute(ARBITRUM, to))
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(caller.address, WHITELIST_MANAGER)
      await expect(f.guard.connect(caller).setCctpRouteAssets(ARBITRUM, to, [f.collateral.target], false))
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(caller.address, WHITELIST_MANAGER)
    }

    // ...and the one who names destinations cannot move funds to them.
    for (const caller of [f.gatekeeper, f.admin, f.stranger]) {
      await expect(f.guard.connect(caller).bridgeCctp(f.collateral.target, ARBITRUM, to, u('1')))
        .revertedWithCustomError(f.guard, 'AccessControlUnauthorizedAccount').withArgs(caller.address, COLLATERAL_MANAGER)
    }
  })

  it('holds a route added to a live contract in the whitelist cooldown', async () => {
    const f = await loadFixture(fixture)
    const DAY = 86400
    const messenger: any = await ethers.deployContract('MockTokenMessenger', [[ARBITRUM, BASE]])
    const guard: any = await ethers.deployContract('VaultAssetGuard', [
      f.minting.target, f.admin.address, 86400,
      [], [], [], DAY, 0, [f.operator.address], [f.gatekeeper.address],
      messenger.target, [{ domain: ARBITRUM, mintRecipient: b32(f.hyperliquid.address), label: 'Day one', assets: [f.collateral.target] }],
    ])
    await f.collateral.mint(guard.target, u('100'))
    const seeded = b32(f.hyperliquid.address), added = b32(f.stranger.address)

    // One cooldown governs both lists — the guard has a single `whitelistCooldown`.
    expect(await guard.whitelistCooldown()).eq(DAY)
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, seeded, u('1'))).not.reverted

    await expect(guard.connect(f.gatekeeper).addCctpRoute(BASE, added, 'Added later', [f.collateral.target]))
      .emit(guard, 'CctpRouteAdded')
    const activeAt = BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + BigInt(DAY)
    expect(await guard.cctpRouteActiveAt(BASE, added)).eq(activeAt)

    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, BASE, added, u('1')))
      .revertedWithCustomError(guard, 'CctpRouteInCooldown').withArgs(routeId(BASE, f.stranger.address), activeAt)
    await time.increaseTo(activeAt - 2n)
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, BASE, added, u('1')))
      .revertedWithCustomError(guard, 'CctpRouteInCooldown')
    await time.increaseTo(activeAt)
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, BASE, added, u('1'))).not.reverted

    // Removal is immediate, and re-adding starts the wait over.
    await expect(guard.connect(f.gatekeeper).removeCctpRoute(BASE, added))
      .emit(guard, 'CctpRouteRemoved').withArgs(routeId(BASE, f.stranger.address))
    expect(await guard.isCctpRoute(BASE, added)).eq(false)
    expect(await guard.isCctpRouteAsset(BASE, added, f.collateral.target)).eq(false)
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, BASE, added, u('1')))
      .revertedWithCustomError(guard, 'NotWhitelistedRoute')
    await guard.connect(f.gatekeeper).addCctpRoute(BASE, added, 'Added later', [f.collateral.target])
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, BASE, added, u('1')))
      .revertedWithCustomError(guard, 'CctpRouteInCooldown')
  })

  it('maintains per-route asset lists, so a route is not blanket permission', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    const to = b32(f.hyperliquid.address)
    const id = routeId(ARBITRUM, f.hyperliquid.address)
    const other: any = await ethers.deployContract('TestToken', ['Other', 'OTH', 6])
    await other.mint(f.guard.target, u('100'))

    const info = await f.guard.cctpRouteInfo(id)
    expect(info.domain).eq(ARBITRUM)
    expect(info.mintRecipient).eq(to)
    expect(info.label).eq('Hyperliquid deposit')
    expect(info.assets).deep.eq([f.collateral.target])
    expect(await f.guard.cctpRouteIds()).deep.eq([id])

    await expect(f.guard.connect(f.gatekeeper).setCctpRouteAssets(ARBITRUM, to, [other.target], true))
      .emit(f.guard, 'CctpRouteAssetChanged').withArgs(id, other.target, true)
    expect(await f.guard.cctpRouteAssets(id)).deep.eq([f.collateral.target, other.target])
    await expect(f.guard.connect(f.operator).bridgeCctp(other.target, ARBITRUM, to, u('1'))).not.reverted

    // Closing one pair leaves the other open. Adding assets carries no cooldown of its own —
    // the route already waited; this is the same shape as setDestinationAssets.
    await expect(f.guard.connect(f.gatekeeper).setCctpRouteAssets(ARBITRUM, to, [f.collateral.target], false))
      .emit(f.guard, 'CctpRouteAssetChanged').withArgs(id, f.collateral.target, false)
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('1')))
      .revertedWithCustomError(f.guard, 'AssetNotAllowedForRoute').withArgs(id, f.collateral.target)
    await expect(f.guard.connect(f.operator).bridgeCctp(other.target, ARBITRUM, to, u('1'))).not.reverted

    // The native sentinel is never a bridge asset: CCTP burns ERC-20s only.
    await expect(f.guard.connect(f.gatekeeper).setCctpRouteAssets(ARBITRUM, to, [f.NATIVE], true))
      .revertedWithCustomError(f.guard, 'InvalidAddress')
    await expect(f.guard.connect(f.gatekeeper).setCctpRouteAssets(ARBITRUM, to, [z], true))
      .revertedWithCustomError(f.guard, 'ZeroAddress')
    await expect(f.guard.connect(f.gatekeeper).setCctpRouteAssets(ARBITRUM, to, [], true))
      .revertedWithCustomError(f.guard, 'InvalidArrayLength')
    await expect(f.guard.connect(f.gatekeeper).setCctpRouteAssets(BASE, to, [other.target], true))
      .revertedWithCustomError(f.guard, 'NotWhitelistedRoute').withArgs(BASE, to)
  })

  it('rejects a route Circle does not serve, including one looping back to this chain', async () => {
    const f = await loadFixture(fixture)
    const to = b32(f.hyperliquid.address)

    // The mock registers Arbitrum and Base only — SOLANA has no remote messenger, exactly as
    // domain 0 has none on Ethereum mainnet. A route home is therefore impossible by construction.
    await expect(f.guard.connect(f.gatekeeper).addCctpRoute(SOLANA, to, 'Nowhere', [f.collateral.target]))
      .revertedWithCustomError(f.guard, 'UnsupportedCctpDomain').withArgs(SOLANA)
    await expect(f.guard.connect(f.gatekeeper).addCctpRoute(ARBITRUM, ethers.ZeroHash, 'Void', [f.collateral.target]))
      .revertedWithCustomError(f.guard, 'ZeroAddress')
    await expect(f.guard.connect(f.gatekeeper).addCctpRoute(ARBITRUM, to, 'Duplicate', [f.collateral.target]))
      .revertedWithCustomError(f.guard, 'CctpRouteAlreadyExists').withArgs(routeId(ARBITRUM, f.hyperliquid.address))
    await expect(f.guard.connect(f.gatekeeper).removeCctpRoute(BASE, to))
      .revertedWithCustomError(f.guard, 'NotWhitelistedRoute').withArgs(BASE, to)
  })

  it('reverts rather than trust a messenger that moves an amount other than the one it was given', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    const to = b32(f.hyperliquid.address)

    // Took the allowance and burned nothing: the event would claim value left that is still here.
    await f.messenger.setMode(1)
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('10')))
      .revertedWithCustomError(f.guard, 'BridgeAmountMismatch').withArgs(u('10'), 0)

    // Pulled twice. Only possible against a standing allowance larger than the amount, which is
    // why the approval is exact — here the second pull fails and takes the whole call with it.
    await f.messenger.setMode(2)
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('10'))).reverted

    // Took it and handed half back — a partial burn, which the delta check catches too.
    await f.messenger.setMode(3)
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('10')))
      .revertedWithCustomError(f.guard, 'BridgeAmountMismatch').withArgs(u('10'), u('5'))

    // Nothing was committed by any of them, and no allowance survived.
    expect(await f.guard.assetBalance(f.collateral.target)).eq(u('100'))
    expect(await f.collateral.allowance(f.guard.target, f.messenger.target)).eq(0)
    await f.messenger.setMode(0)
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('10'))).not.reverted
  })

  it('stops bridging when paused, and surfaces the per-message burn cap', async () => {
    const f = await loadFixture(fixture)
    await f.fund('100')
    const to = b32(f.hyperliquid.address)

    await f.guard.connect(f.gatekeeper).setPaused(true)
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('1')))
      .revertedWithCustomError(f.guard, 'Paused')
    // Returning to minting is still open, as it is for every other outbound path.
    await expect(f.guard.connect(f.operator).returnToMinting(f.collateral.target, u('1'))).not.reverted
    await f.guard.connect(f.gatekeeper).setPaused(false)

    // Circle caps a single burn. The guard reports it rather than looping.
    expect(await f.guard.cctpBurnLimit(f.collateral.target)).eq(ethers.MaxUint256)
    await f.messenger.setBurnLimit(u('25'))
    expect(await f.guard.cctpBurnLimit(f.collateral.target)).eq(u('25'))
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('30')))
      .revertedWith('Burn amount exceeds per tx limit')
    await expect(f.guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('25'))).not.reverted
  })

  it('leaves bridging permanently unavailable when no messenger was named at deployment', async () => {
    const f = await loadFixture(fixture)
    const to = b32(f.hyperliquid.address)
    const guard: any = await ethers.deployContract('VaultAssetGuard', [
      f.minting.target, f.admin.address, 86400, [], [], [], 0, 0,
      [f.operator.address], [f.gatekeeper.address], z, [],
    ])
    expect(await guard.cctpTokenMessenger()).eq(z)
    expect(await guard.cctpBurnLimit(f.collateral.target)).eq(0)
    await expect(guard.connect(f.operator).bridgeCctp(f.collateral.target, ARBITRUM, to, u('1')))
      .revertedWithCustomError(guard, 'CctpNotConfigured')
    // There is no setter, so a route can never be added either.
    await expect(guard.connect(f.gatekeeper).addCctpRoute(ARBITRUM, to, 'Nope', [f.collateral.target]))
      .revertedWithCustomError(guard, 'CctpNotConfigured')

    // And the two halves cannot be deployed inconsistently.
    await expect(ethers.deployContract('VaultAssetGuard', [
      f.minting.target, f.admin.address, 86400, [], [], [], 0, 0,
      [f.operator.address], [f.gatekeeper.address], z,
      [{ domain: ARBITRUM, mintRecipient: to, label: 'Orphan', assets: [f.collateral.target] }],
    ])).revertedWithCustomError(guard, 'CctpNotConfigured')
    await expect(ethers.deployContract('VaultAssetGuard', [
      f.minting.target, f.admin.address, 86400, [], [], [], 0, 0,
      [f.operator.address], [f.gatekeeper.address], f.stranger.address, [],
    ])).revertedWithCustomError(guard, 'InvalidAddress')
  })
})
