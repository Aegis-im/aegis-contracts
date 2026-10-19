import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'

const z = ethers.ZeroAddress, u = (v: string) => ethers.parseUnits(v, 6)
const ETHEREUM = 0
const b32 = (a: string) => ethers.zeroPadValue(a, 32)
const COLLATERAL_MANAGER = ethers.id('COLLATERAL_MANAGER_ROLE'), WHITELIST_MANAGER = ethers.id('WHITELIST_MANAGER_ROLE')
const PERPS = 0, SPOT = 2 ** 32 - 1
const COOLDOWN = 86400

async function fixture() {
  const [admin, operator, gatekeeper, account, nextAccount, ethGuard, stranger] = await ethers.getSigners()
  const usdc: any = await ethers.deployContract('TestToken', ['USD Coin', 'USDC', 6])
  const wallet: any = await ethers.deployContract('MockCoreDepositWallet', [usdc.target])
  const messenger: any = await ethers.deployContract('MockTokenMessenger', [[ETHEREUM]])

  const args = (overrides: { wallet?: string, recipient?: string } = {}) => [
    admin.address, 86400, [], [], [], COOLDOWN, [operator.address], [gatekeeper.address], messenger.target,
    [{ domain: ETHEREUM, mintRecipient: b32(ethGuard.address), label: 'Ethereum guard', assets: [usdc.target] }],
    overrides.wallet ?? wallet.target, overrides.recipient ?? account.address,
  ]
  const depositor: any = await ethers.deployContract('VaultCoreDepositor', args())

  // USDC arrives the way it does in production: minted over CCTP from the Ethereum guard.
  await usdc.mint(depositor.target, u('1000'))
  return { admin, operator, gatekeeper, account, nextAccount, ethGuard, stranger, usdc, wallet, messenger, depositor, args }
}

describe('VaultCoreDepositor HyperCore deposits', () => {
  it('credits the predefined HyperCore account and leaves no allowance behind', async () => {
    const f = await loadFixture(fixture)
    expect(await f.depositor.coreToken()).eq(f.usdc.target)
    expect(await f.depositor.coreRecipient()).eq(f.account.address)

    const tx = f.depositor.connect(f.operator).depositToHyperCore(u('600'), PERPS)
    await expect(tx).emit(f.depositor, 'HyperCoreDeposit').withArgs(f.account.address, u('600'), PERPS)
    await expect(tx).changeTokenBalances(f.usdc, [f.depositor, f.wallet], [-u('600'), u('600')])

    const d = await f.wallet.deposits(0)
    expect([d.caller, d.recipient, d.amount, d.destinationDex]).deep.eq([f.depositor.target, f.account.address, u('600'), BigInt(PERPS)])
    expect(await f.usdc.allowance(f.depositor.target, f.wallet.target)).eq(0)

    // Spot is the same account, a different balance.
    await f.depositor.connect(f.operator).depositToHyperCore(u('400'), SPOT)
    expect((await f.wallet.deposits(1)).destinationDex).eq(BigInt(SPOT))
    expect(await f.usdc.balanceOf(f.depositor.target)).eq(0)
  })

  it('gives the operator no say over the recipient', async () => {
    const f = await loadFixture(fixture)
    const fn = f.depositor.interface.getFunction('depositToHyperCore')!
    expect(fn.inputs.map((i: any) => i.name)).deep.eq(['amount', 'destinationDex'])

    await expect(f.depositor.connect(f.operator).setCoreRecipient(f.stranger.address))
      .revertedWithCustomError(f.depositor, 'AccessControlUnauthorizedAccount').withArgs(f.operator.address, WHITELIST_MANAGER)
    await expect(f.depositor.connect(f.admin).setCoreRecipient(f.stranger.address))
      .revertedWithCustomError(f.depositor, 'AccessControlUnauthorizedAccount')
  })

  it('credits only the Core perps or spot balance', async () => {
    const f = await loadFixture(fixture)
    // The real CoreDepositWallet accepts any uint32, so the depositor is the only check.
    for (const dex of [1, 2, 7, 1000, SPOT - 1])
      await expect(f.depositor.connect(f.operator).depositToHyperCore(u('1'), dex))
        .revertedWithCustomError(f.depositor, 'UnsupportedDex').withArgs(dex)
    expect(await f.wallet.depositCount()).eq(0)
    expect(await f.depositor.CORE_PERPS_DEX()).eq(PERPS)
    expect(await f.depositor.CORE_SPOT_DEX()).eq(SPOT)
  })

  it('only lets the collateral manager deposit', async () => {
    const f = await loadFixture(fixture)
    for (const who of [f.gatekeeper, f.admin, f.stranger, f.account])
      await expect(f.depositor.connect(who).depositToHyperCore(u('1'), PERPS))
        .revertedWithCustomError(f.depositor, 'AccessControlUnauthorizedAccount').withArgs(who.address, COLLATERAL_MANAGER)
  })

  it('makes a replacement recipient wait out the whitelist cooldown, and stops the old one at once', async () => {
    const f = await loadFixture(fixture)
    const tx = await f.depositor.connect(f.gatekeeper).setCoreRecipient(f.nextAccount.address)
    const activeFrom = BigInt((await ethers.provider.getBlock(tx.blockNumber!))!.timestamp + COOLDOWN)
    await expect(tx).emit(f.depositor, 'CoreRecipientChanged').withArgs(f.nextAccount.address, activeFrom)

    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('1'), PERPS))
      .revertedWithCustomError(f.depositor, 'CoreRecipientInCooldown').withArgs(f.nextAccount.address, activeFrom)

    await time.increaseTo(activeFrom)
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('1'), PERPS))
      .emit(f.depositor, 'HyperCoreDeposit').withArgs(f.nextAccount.address, u('1'), PERPS)
  })

  it('rejects recipients that could never use the credit', async () => {
    const f = await loadFixture(fixture)
    await expect(f.depositor.connect(f.gatekeeper).setCoreRecipient(z)).revertedWithCustomError(f.depositor, 'ZeroAddress')
    await expect(f.depositor.connect(f.gatekeeper).setCoreRecipient(f.depositor.target)).revertedWithCustomError(f.depositor, 'InvalidAddress')
    await expect(f.depositor.connect(f.gatekeeper).setCoreRecipient(f.wallet.target)).revertedWithCustomError(f.depositor, 'InvalidAddress')
  })

  it('validates the wallet and recipient at deployment', async () => {
    const f = await loadFixture(fixture)
    const Factory = await ethers.getContractFactory('VaultCoreDepositor')
    await expect(Factory.deploy(...f.args({ wallet: z }))).revertedWithCustomError(Factory, 'ZeroAddress')
    await expect(Factory.deploy(...f.args({ wallet: f.stranger.address }))).revertedWithCustomError(Factory, 'InvalidAddress')
    await expect(Factory.deploy(...f.args({ recipient: z }))).revertedWithCustomError(Factory, 'ZeroAddress')
    await expect(Factory.deploy(...f.args({ recipient: f.wallet.target }))).revertedWithCustomError(Factory, 'InvalidAddress')

    const self = ethers.getCreateAddress({ from: f.admin.address, nonce: await ethers.provider.getTransactionCount(f.admin.address) })
    await expect(Factory.deploy(...f.args({ recipient: self }))).revertedWithCustomError(Factory, 'InvalidAddress')
  })

  it('stops deposits while paused, and while Circle has the wallet paused', async () => {
    const f = await loadFixture(fixture)
    await f.depositor.connect(f.gatekeeper).setPaused(true)
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('1'), PERPS)).revertedWithCustomError(f.depositor, 'Paused')
    await f.depositor.connect(f.gatekeeper).setPaused(false)

    await f.wallet.setPaused(true)
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('1'), PERPS)).revertedWith('Pausable: paused')
    expect(await f.usdc.allowance(f.depositor.target, f.wallet.target)).eq(0)
  })

  it('reverts unless exactly the requested amount reaches the wallet', async () => {
    const f = await loadFixture(fixture)
    await f.wallet.setMode(1) // takes nothing
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('10'), PERPS))
      .revertedWithCustomError(f.depositor, 'DepositAmountMismatch').withArgs(u('10'), 0)
    await f.wallet.setMode(2) // tries to take twice — the exact allowance stops it
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('10'), PERPS)).reverted
    await f.wallet.setMode(3) // takes and refunds half
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('10'), PERPS))
      .revertedWithCustomError(f.depositor, 'DepositAmountMismatch').withArgs(u('10'), u('5'))

    await f.wallet.setMode(0)
    await expect(f.depositor.connect(f.operator).depositToHyperCore(0, PERPS)).revertedWithCustomError(f.depositor, 'InvalidAmount')
    await expect(f.depositor.connect(f.operator).depositToHyperCore(u('1001'), PERPS)).reverted
  })

  it('has the minting sink disabled for good', async () => {
    const f = await loadFixture(fixture)
    expect(await f.depositor.mintingAddress()).eq(z)
    expect(await f.depositor.mintingChangeDelay()).eq(0)
    const sink: any = await ethers.deployContract('TestToken', ['Fake minting', 'FAKE', 6])

    await expect(f.depositor.connect(f.gatekeeper).setMintingAddress(sink.target)).revertedWithCustomError(f.depositor, 'MintingDisabled')
    await expect(f.depositor.connect(f.gatekeeper).beginMintingAddressChange(sink.target)).revertedWithCustomError(f.depositor, 'MintingNotConfigured')
    for (const call of [
      () => f.depositor.connect(f.operator).returnToMinting(f.usdc.target, u('1')),
      () => f.depositor.connect(f.operator).returnAllToMinting(f.usdc.target),
      () => f.depositor.connect(f.operator).pullFromMinting(f.usdc.target, u('1')),
      () => f.depositor.connect(f.operator).pullAllFromMinting(f.usdc.target),
    ]) await expect(call()).revertedWithCustomError(f.depositor, 'MintingNotConfigured')

    // The finding-2 path: even an operator appointed by the whitelist manager has no sink to drain into.
    await f.depositor.connect(f.gatekeeper).grantCollateralManager(f.stranger.address)
    await expect(f.depositor.connect(f.stranger).returnAllToMinting(f.usdc.target)).revertedWithCustomError(f.depositor, 'MintingNotConfigured')
    expect(await f.usdc.balanceOf(f.depositor.target)).eq(u('1000'))
  })

  it('keeps the guard behaviour: bridges back to Ethereum, and has no minting sink to return to', async () => {
    const f = await loadFixture(fixture)
    await expect(f.depositor.connect(f.operator).bridgeCctp(f.usdc.target, ETHEREUM, b32(f.ethGuard.address), u('250')))
      .emit(f.depositor, 'CctpBridged')
    expect((await f.messenger.burns(0)).mintRecipient).eq(b32(f.ethGuard.address))

    await expect(f.depositor.connect(f.operator).returnToMinting(f.usdc.target, u('1')))
      .revertedWithCustomError(f.depositor, 'MintingNotConfigured')
    await expect(f.depositor.connect(f.operator).bridgeCctp(f.usdc.target, ETHEREUM, b32(f.stranger.address), u('1')))
      .revertedWithCustomError(f.depositor, 'NotWhitelistedRoute')
  })
})
