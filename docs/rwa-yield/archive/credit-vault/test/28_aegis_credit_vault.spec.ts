import { expect } from 'chai'
import { ethers } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
const u = (n: string | number) => ethers.parseUnits(String(n), 6)
const s = (n: string | number) => ethers.parseUnits(String(n), 18)
const MONTH = 30 * 86400
async function fixture() {
  const [admin, manager, counterparty, alice, bob, outsider] = await ethers.getSigners()
  const token = await ethers.deployContract('TestToken', ['USD Coin', 'USDC', 6])
  const config = await ethers.deployContract('AegisConfig', [admin.address, [admin.address], admin.address])
  await config['whitelistAddress(address[],bool[])']([alice.address, bob.address], [true, true])
  const vault = await ethers.deployContract('AegisCreditVault', [token.target, config.target, counterparty.address, admin.address, manager.address])
  for (const who of [alice, bob, manager, counterparty, outsider]) {
    await token.mint(who.address, u(100000))
    await token.connect(who).approve(vault.target, ethers.MaxUint256)
  }
  return { admin, manager, counterparty, alice, bob, outsider, token, config, vault }
}
async function active() {
  const f = await fixture()
  await f.vault.connect(f.alice)['deposit(uint256,address)'](u(1000), f.alice.address)
  return f
}
async function request(f: Awaited<ReturnType<typeof fixture>>, amount = s(100)) {
  await f.vault.connect(f.alice).requestRedeem(amount, f.alice.address, f.alice.address)
  return (await f.vault.redemptions(f.alice.address)).readyAt
}
async function conserved(f: Awaited<ReturnType<typeof fixture>>) {
  expect(await f.token.balanceOf(f.vault.target)).to.be.gte(await f.vault.liquidAssets() + await f.vault.claimReserves())
  expect(await f.vault.totalAssets()).to.equal(await f.vault.liquidAssets() + await f.vault.reportedExternalAssets())
}
describe('AegisCreditVault: synchronous ERC4626 / asynchronous ERC7540 redemption', () => {
  it('deposits and mints synchronously with standard previews and transferable blacklist-protected shares', async () => {
    const f = await loadFixture(fixture); const { vault, alice, bob, outsider } = f
    expect(await vault.previewDeposit(u(100))).to.equal(s(100))
    await expect(vault.connect(alice)['deposit(uint256,address)'](u(100), alice.address)).to.emit(vault, 'Deposit').withArgs(alice.address, alice.address, u(100), s(100))
    expect(await vault.balanceOf(alice.address)).to.equal(s(100))
    expect(await vault.previewMint(s(50))).to.equal(u(50))
    await vault.connect(bob)['mint(uint256,address)'](s(50), bob.address)
    await vault.connect(alice).transfer(bob.address, s(10))
    await vault.connect(bob).approve(alice.address, s(1))
    await vault.connect(alice).transferFrom(bob.address, alice.address, s(1))
    await vault.addBlackList(outsider.address)
    await expect(vault.connect(alice).transfer(outsider.address, 1)).to.be.revertedWithCustomError(vault, 'Blacklisted').withArgs(outsider.address)
    await expect(vault.connect(alice).transfer(vault.target, 1)).to.be.revertedWithCustomError(vault, 'Ineligible')
    await conserved(f)
  })
  it('exposes standard interface discovery and always reverting async previews', async () => {
    const { vault } = await loadFixture(fixture)
    expect(await vault.share()).to.equal(vault.target)
    for (const id of ['0x01ffc9a7','0xe3bc4e65','0x2f0a18c5','0x620ee8e4']) expect(await vault.supportsInterface(id)).to.equal(true)
    for (const id of ['0xffffffff','0xce3bbe50']) expect(await vault.supportsInterface(id)).to.equal(false)
    for (const n of [0n,1n,ethers.MaxUint256]) {
      await expect(vault.previewRedeem(n)).to.be.revertedWithCustomError(vault,'AsyncPreview')
      await expect(vault.previewWithdraw(n)).to.be.revertedWithCustomError(vault,'AsyncPreview')
    }
  })
  it('enforces request -> 30 days -> fulfillment -> standard pull claim at exact boundaries', async () => {
    const f = await loadFixture(active); const { vault, alice, bob } = f
    const ready = await request(f)
    expect(await vault.pendingRedeemRequest(0, alice.address)).to.equal(s(100))
    expect(await vault.pendingRedeemRequest(1, alice.address)).to.equal(0)
    expect(await vault.totalSupply()).to.equal(s(1000))
    expect(await vault.balanceOf(alice.address)).to.equal(s(900))
    expect(await vault.maxRedeem(alice.address)).to.equal(0)
    await expect(vault.connect(alice).redeem(s(1), alice.address, alice.address)).to.be.reverted
    await time.setNextBlockTimestamp(ready - 1n)
    await expect(vault.fulfillRedeem(alice.address)).to.be.revertedWithCustomError(vault, 'TooEarly')
    await time.setNextBlockTimestamp(ready)
    await expect(vault.connect(bob).fulfillRedeem(alice.address)).to.emit(vault,'RedeemFulfilled').withArgs(alice.address,s(100),u(100))
    expect(await vault.pendingRedeemRequest(0,alice.address)).to.equal(0)
    expect(await vault.claimableRedeemRequest(0,alice.address)).to.equal(s(100))
    expect(await vault.claimableRedeemRequest(1,alice.address)).to.equal(0)
    expect(await vault.maxWithdraw(alice.address)).to.equal(u(100))
    await vault.connect(alice).withdraw(u(25),alice.address,alice.address)
    await vault.connect(alice).redeem(s(75),alice.address,alice.address)
    expect(await vault.claimReserves()).to.equal(0)
    await expect(vault.connect(alice).redeem(1,alice.address,alice.address)).to.be.reverted
    await conserved(f)
  })
  it('uses independent cooldowns, disallows pending topups, and prevents unsolicited controller griefing', async () => {
    const f = await loadFixture(active); const { vault,alice,bob } = f
    await vault.connect(alice).transfer(bob.address,s(100))
    const ready = await request(f)
    await expect(vault.connect(alice).requestRedeem(1,alice.address,alice.address)).to.be.revertedWithCustomError(vault,'PendingRequestExists')
    await time.increase(3600)
    await vault.connect(bob).requestRedeem(s(10),bob.address,bob.address)
    expect((await vault.redemptions(bob.address)).readyAt).to.be.gt(ready)
    await expect(vault.connect(alice).requestRedeem(1,bob.address,alice.address)).to.be.revertedWithCustomError(vault,'Unauthorized')
    await time.increaseTo(ready)
    await vault.fulfillRedeem(alice.address)
    await expect(vault.fulfillRedeem(bob.address)).to.be.revertedWithCustomError(vault,'TooEarly')
  })
  it('moves liquidity without changing NAV and realizes reported yield exactly once', async () => {
    const f = await loadFixture(active); const {vault,manager,counterparty,alice,bob} = f
    await vault.connect(manager).fundCounterparty(u(1000))
    expect(await vault.totalAssets()).to.equal(u(1000))
    await request(f)
    await vault.connect(manager).reportNAV(u(1100))
    const expected = await vault.convertToAssets(s(100))
    const depositShares = await vault.previewDeposit(u(110))
    await vault.connect(bob)['deposit(uint256,address)'](u(110),bob.address)
    expect(await vault.balanceOf(bob.address)).to.equal(depositShares)
    await vault.connect(counterparty).returnLiquidity(u(1100))
    expect(await vault.totalAssets()).to.equal(u(1210))
    expect(await vault.reportedExternalAssets()).to.equal(0)
    await time.increase(MONTH)
    await vault.fulfillRedeem(alice.address)
    expect(await vault.maxWithdraw(alice.address)).to.be.closeTo(expected,1n)
    await conserved(f)
  })
  it('does not make illiquid requests claimable; reserves are protected from funding and reports', async () => {
    const f = await loadFixture(active); const {vault,manager,counterparty,alice} = f
    await vault.connect(manager).fundCounterparty(u(1000))
    await request(f)
    await time.increase(MONTH)
    await expect(vault.fulfillRedeem(alice.address)).to.be.revertedWithCustomError(vault,'InsufficientLiquidity')
    expect(await vault.pendingRedeemRequest(0,alice.address)).to.equal(s(100))
    await vault.connect(counterparty).returnLiquidity(u(100))
    await vault.fulfillRedeem(alice.address)
    await expect(vault.connect(manager).fundCounterparty(1)).to.be.revertedWithCustomError(vault,'InsufficientLiquidity')
    await vault.connect(manager).reportNAV(0)
    expect(await vault.maxWithdraw(alice.address)).to.equal(u(100))
    await vault.connect(alice).redeem(s(100),alice.address,alice.address)
    await conserved(f)
  })
  it('supports allowances and operators without allowing allowance-only claims', async () => {
    const f = await loadFixture(active); const {vault,alice,bob,outsider} = f
    await expect(vault.connect(bob).requestRedeem(s(10),alice.address,alice.address)).to.be.reverted
    await vault.connect(alice).approve(bob.address,s(10))
    await vault.connect(bob).requestRedeem(s(10),alice.address,alice.address)
    expect(await vault.allowance(alice.address,bob.address)).to.equal(0)
    await time.increase(MONTH); await vault.fulfillRedeem(alice.address)
    await vault.connect(alice).approve(bob.address,ethers.MaxUint256)
    await expect(vault.connect(bob).redeem(s(10),bob.address,alice.address)).to.be.revertedWithCustomError(vault,'Unauthorized')
    await vault.connect(alice).setOperator(bob.address,true)
    await vault.connect(bob).redeem(s(10),bob.address,alice.address)
    await vault.connect(bob).requestRedeem(s(10),alice.address,alice.address)
    expect(await vault.allowance(alice.address,bob.address)).to.equal(ethers.MaxUint256)
    await vault.connect(alice).setOperator(bob.address,false)
    await expect(vault.connect(outsider)['deposit(uint256,address,address)'](u(1),alice.address,alice.address)).to.be.revertedWithCustomError(vault,'Unauthorized')
  })
  it('supports synchronous operator deposit/mint overloads pulling assets from controller', async () => {
    const {vault,alice,bob,token} = await loadFixture(fixture)
    await vault.connect(alice).setOperator(bob.address,true)
    const before = await token.balanceOf(alice.address)
    await vault.connect(bob)['deposit(uint256,address,address)'](u(10),alice.address,alice.address)
    await vault.connect(bob)['mint(uint256,address,address)'](s(5),alice.address,alice.address)
    expect(await token.balanceOf(alice.address)).to.equal(before-u(15))
    expect(await vault.balanceOf(alice.address)).to.equal(s(15))
  })
  it('permits funded recovery after pause and de-whitelisting while blocking new risk', async () => {
    const f = await loadFixture(active); const {vault,admin,alice,bob,config} = f
    await request(f); await time.increase(MONTH); await vault.fulfillRedeem(alice.address)
    await vault.connect(admin).pause()
    await config['whitelistAddress(address,bool)'](alice.address,false)
    expect(await vault.maxDeposit(alice.address)).to.equal(0)
    await expect(vault.connect(alice).transfer(bob.address,1)).to.be.reverted
    await expect(vault.connect(alice).requestRedeem(1,alice.address,alice.address)).to.be.reverted
    await vault.connect(alice).redeem(s(100),alice.address,alice.address)
    await conserved(f)
  })
  it('accounts for total losses without injecting new deposits into worthless shares', async () => {
    const f = await loadFixture(active); const {vault,manager,alice} = f
    await vault.connect(manager).fundCounterparty(u(1000))
    await request(f,s(1000))
    await vault.connect(manager).reportNAV(0)
    expect(await vault.maxDeposit(alice.address)).to.equal(0)
    await expect(vault.connect(alice)['deposit(uint256,address)'](u(1),alice.address)).to.be.reverted
    await time.increase(MONTH); await vault.fulfillRedeem(alice.address)
    expect(await vault.maxRedeem(alice.address)).to.equal(s(1000))
    expect(await vault.maxWithdraw(alice.address)).to.equal(0)
    await vault.connect(alice).redeem(s(1000),alice.address,alice.address)
    expect(await vault.claimReserves()).to.equal(0)
    await vault.connect(alice)['deposit(uint256,address)'](u(10),alice.address)
  })
  it('aggregates multiple funded requests and conserves rounding across partial claims', async () => {
    const f = await loadFixture(active); const {vault,manager,counterparty,alice} = f
    await request(f,s('3.123456789'))
    await time.increase(MONTH); await vault.fulfillRedeem(alice.address)
    await request(f,s('7.7654321'))
    await vault.connect(manager).fundCounterparty(u(100))
    await vault.connect(manager).reportNAV(await vault.totalAssets()+u('1.234567'))
    await vault.connect(counterparty).returnLiquidity(u(100))
    await time.increase(MONTH); await vault.fulfillRedeem(alice.address)
    const cash = await vault.maxWithdraw(alice.address)
    const before = await f.token.balanceOf(alice.address)
    await vault.connect(alice).withdraw(1,alice.address,alice.address)
    await vault.connect(alice).redeem(s(1),alice.address,alice.address)
    await vault.connect(alice).redeem(await vault.maxRedeem(alice.address),alice.address,alice.address)
    expect(await f.token.balanceOf(alice.address)-before).to.equal(cash)
    expect(await vault.claimReserves()).to.equal(0)
    await conserved(f)
  })
  it('rejects unauthorized valuations, impossible cash write-downs, excess returns and direct donation price changes', async () => {
    const f=await loadFixture(active); const {vault,manager,alice,counterparty,token}=f
    await expect(vault.connect(alice).reportNAV(u(2000))).to.be.reverted
    await expect(vault.connect(manager).reportNAV(u(999))).to.be.revertedWithCustomError(vault,'InvalidAmount')
    await expect(vault.connect(counterparty).returnLiquidity(1)).to.be.reverted
    await expect(vault.connect(alice).fundCounterparty(1)).to.be.reverted
    await token.connect(alice).transfer(vault.target,u(50))
    expect(await vault.totalAssets()).to.equal(u(1000))
    await conserved(f)
  })
  it('admits non-whitelisted users and ignores shared whitelist switches while enforcing blacklist', async () => {
    const f=await loadFixture(active); const {vault,config,alice,bob,outsider}=f
    expect(await config.isWhitelisted(outsider.address)).to.equal(false)
    expect(await vault.isEligible(outsider.address)).to.equal(true)
    expect(await vault.maxDeposit(outsider.address)).to.equal(ethers.MaxUint256)
    await vault.connect(outsider)['deposit(uint256,address)'](u(10),outsider.address)
    await vault.connect(alice).transfer(outsider.address,s(10))
    await vault.connect(outsider).requestRedeem(s(10),outsider.address,outsider.address)
    await config.disableWhitelist()
    await vault.connect(outsider)['mint(uint256,address)'](s(1),outsider.address)
    await vault.addBlackList(bob.address)
    await expect(vault.connect(alice).transfer(bob.address,1)).to.be.revertedWithCustomError(vault,'Blacklisted')
    await config.enableWhitelist()
    expect(await vault.maxDeposit(outsider.address)).to.equal(ethers.MaxUint256)
    await time.increase(MONTH)
    await vault.fulfillRedeem(outsider.address)
    await vault.connect(outsider).redeem(s(10),outsider.address,outsider.address)
    await vault.addBlackList(outsider.address)
    expect(await vault.maxDeposit(outsider.address)).to.equal(0)
    await expect(vault.connect(outsider)['deposit(uint256,address)'](u(1),outsider.address)).to.be.reverted
    await conserved(f)
  })
  it('locks requested shares without preventing available shares from transferring during cooldown', async () => {
    const f=await loadFixture(active); const {vault,alice,bob}=f
    await request(f,s(900))
    await expect(vault.connect(alice).transfer(bob.address,s(101))).to.be.reverted
    await vault.connect(alice).transfer(bob.address,s(100))
    const remaining=await vault.pendingRedeemRequest(0,alice.address)
    expect(remaining).to.equal(s(900))
    expect(await vault.pendingRedeemRequest(0,bob.address)).to.equal(0)
    await vault.connect(bob).requestRedeem(s(100),bob.address,bob.address)
    expect(await vault.balanceOf(vault.target)).to.equal(s(1000))
    expect(await vault.totalSupply()).to.equal(s(1000))
  })
  it('keeps returns and NAV reporting available during pause but prevents fulfillment and new funding', async () => {
    const f=await loadFixture(active); const {vault,admin,manager,counterparty,alice}=f
    await vault.connect(manager).fundCounterparty(u(1000)); await request(f)
    await vault.connect(admin).pause()
    await vault.connect(manager).reportNAV(u(1010))
    await vault.connect(counterparty).returnLiquidity(u(1010))
    expect(await vault.totalAssets()).to.equal(u(1010))
    await expect(vault.connect(manager).fundCounterparty(1)).to.be.revertedWithCustomError(vault,'EnforcedPause')
    await time.increase(MONTH)
    await expect(vault.fulfillRedeem(alice.address)).to.be.revertedWithCustomError(vault,'EnforcedPause')
    await vault.connect(admin).unpause()
    await vault.fulfillRedeem(alice.address)
    await conserved(f)
  })
  it('rejects invalid configuration and unauthorized administration', async () => {
    const {vault,token,config,admin,manager,counterparty,alice}=await loadFixture(fixture)
    const wrong=await ethers.deployContract('TestToken',['Wrong','WRONG',18])
    await expect(ethers.deployContract('AegisCreditVault',[wrong.target,config.target,counterparty.address,admin.address,manager.address])).to.be.revertedWithCustomError(vault,'UnsupportedAsset')
    await expect(ethers.deployContract('AegisCreditVault',[token.target,config.target,ethers.ZeroAddress,admin.address,manager.address])).to.be.revertedWithCustomError(vault,'InvalidConfiguration')
    await expect(vault.connect(alice).pause()).to.be.reverted
    await expect(vault.connect(alice).unpause()).to.be.reverted
    await expect(vault.connect(alice).returnLiquidity(1)).to.be.revertedWithCustomError(vault,'Unauthorized')
  })

  it('reports external value independently of deposits and claim cash movements', async () => {
    const f = await loadFixture(active); const { vault, manager, alice, bob } = f
    await vault.connect(manager).fundCounterparty(u(600))
    // This valuation can be prepared before the following deposit without subtracting stale cash.
    await vault.connect(bob)['deposit(uint256,address)'](u(200), bob.address)
    await expect(vault.connect(manager).reportExternalAssets(u(650)))
      .to.emit(vault, 'ExternalAssetsReported').withArgs(u(600), u(650))
    expect(await vault.totalAssets()).to.equal(u(1250))
    expect(await vault.lastReportAt()).to.equal(await time.latest())
    await request(f)
    await time.increase(MONTH)
    await vault.fulfillRedeem(alice.address)
    const liquid = await vault.liquidAssets()
    const reserves = await vault.claimReserves()
    await vault.connect(manager).reportExternalAssets(u(625))
    expect(await vault.liquidAssets()).to.equal(liquid)
    expect(await vault.claimReserves()).to.equal(reserves)
    expect(await vault.totalAssets()).to.equal(liquid + u(625))
    await vault.connect(alice).redeem(await vault.maxRedeem(alice.address),alice.address,alice.address)
    expect(await vault.totalAssets()).to.equal(liquid + u(625))
    await conserved(f)
  })
  it('allows external write-down to zero with cash present and restricts reports to the manager', async () => {
    const f = await loadFixture(active); const { vault, manager, alice, admin } = f
    await vault.connect(manager).fundCounterparty(u(600))
    await expect(vault.connect(alice).reportExternalAssets(0)).to.be.revertedWithCustomError(vault,'AccessControlUnauthorizedAccount')
    await vault.connect(admin).pause()
    await vault.connect(manager).reportExternalAssets(0)
    expect(await vault.totalAssets()).to.equal(u(400))
    expect(await vault.reportedExternalAssets()).to.equal(0)
    await expect(vault.connect(manager).reportExternalAssets(ethers.MaxUint256-u(400))).to.be.revertedWithCustomError(vault,'InvalidAmount')
    await conserved(f)
  })
  it('does not count reported external yield twice when liquidity is returned', async () => {
    const f = await loadFixture(active); const { vault, manager, counterparty } = f
    await vault.connect(manager).fundCounterparty(u(600))
    await vault.connect(manager).reportExternalAssets(u(660))
    expect(await vault.totalAssets()).to.equal(u(1060))
    await vault.connect(counterparty).returnLiquidity(u(660))
    expect(await vault.totalAssets()).to.equal(u(1060))
    expect(await vault.reportedExternalAssets()).to.equal(0)
    await conserved(f)
  })

  it('restricts setConfig to admin and validates replacement without re-enabling whitelist admission', async () => {
    const {vault,config,admin,alice,bob,token}=await loadFixture(active)
    const next=await ethers.deployContract('AegisConfig',[admin.address,[admin.address],admin.address])
    await next['whitelistAddress(address,bool)'](bob.address,true)
    await expect(vault.connect(alice).setConfig(next.target)).to.be.revertedWithCustomError(vault,'AccessControlUnauthorizedAccount')
    for (const invalid of [ethers.ZeroAddress,alice.address,token.target]) {
      await expect(vault.setConfig(invalid)).to.be.reverted
      expect(await vault.aegisConfig()).to.equal(config.target)
    }
    await expect(vault.setConfig(next.target)).to.emit(vault,'SetConfig').withArgs(next.target,config.target)
    expect(await vault.aegisConfig()).to.equal(next.target)
    expect(await next.isWhitelisted(alice.address)).to.equal(false)
    expect(await vault.maxDeposit(alice.address)).to.equal(ethers.MaxUint256)
    expect(await vault.maxDeposit(bob.address)).to.equal(ethers.MaxUint256)
    await vault.connect(alice).requestRedeem(1,alice.address,alice.address)
    // Config rotation does not gate admission, transfers, or accounting.
    await vault.connect(alice).transfer(bob.address,s(1))
    expect(await vault.totalAssets()).to.equal(u(1000))
  })
  it('mirrors YUSD blacklist sender/receiver checks on transfer and transferFrom with reversible admin control', async () => {
    const {vault,alice,bob,outsider}=await loadFixture(active)
    await expect(vault.connect(alice).addBlackList(bob.address)).to.be.reverted
    await expect(vault.connect(alice).removeBlackList(bob.address)).to.be.reverted
    await expect(vault.addBlackList(alice.address)).to.emit(vault,'AddedBlackList').withArgs(alice.address)
    expect(await vault.getBlackListStatus(alice.address)).to.equal(true)
    expect(await vault.isBlackListed(alice.address)).to.equal(true)
    await vault.connect(alice).approve(outsider.address,s(10))
    await expect(vault.connect(alice).transfer(bob.address,1)).to.be.revertedWithCustomError(vault,'Blacklisted').withArgs(alice.address)
    await expect(vault.connect(outsider).transferFrom(alice.address,bob.address,1)).to.be.revertedWithCustomError(vault,'Blacklisted').withArgs(alice.address)
    await expect(vault.removeBlackList(alice.address)).to.emit(vault,'RemovedBlackList').withArgs(alice.address)
    await vault.addBlackList(bob.address)
    await expect(vault.connect(alice).transfer(bob.address,1)).to.be.revertedWithCustomError(vault,'Blacklisted').withArgs(bob.address)
    await expect(vault.connect(outsider).transferFrom(alice.address,bob.address,1)).to.be.revertedWithCustomError(vault,'Blacklisted').withArgs(bob.address)
    await vault.removeBlackList(bob.address)
    await vault.connect(outsider).transferFrom(alice.address,bob.address,s(10))
    expect(await vault.balanceOf(bob.address)).to.equal(s(10))
  })
  it('prevents blacklist bypass through minting, escrow, fulfillment, operators or cash claims', async () => {
    const f=await loadFixture(active);const {vault,alice,bob}=f
    await vault.addBlackList(alice.address)
    expect(await vault.maxDeposit(alice.address)).to.equal(0)
    await expect(vault.connect(bob)['mint(uint256,address)'](1,alice.address)).to.be.reverted
    await expect(vault.connect(alice)['deposit(uint256,address)'](u(1),bob.address)).to.be.revertedWithCustomError(vault,'Blacklisted')
    await expect(vault.connect(alice).requestRedeem(1,alice.address,alice.address)).to.be.revertedWithCustomError(vault,'Blacklisted')
    await vault.removeBlackList(alice.address)
    await request(f)
    await vault.addBlackList(alice.address)
    await time.increase(MONTH)
    await expect(vault.fulfillRedeem(alice.address)).to.be.revertedWithCustomError(vault,'Blacklisted')
    expect(await vault.pendingRedeemRequest(0,alice.address)).to.equal(s(100))
    await vault.removeBlackList(alice.address)
    await vault.fulfillRedeem(alice.address)
    await vault.connect(alice).setOperator(bob.address,true)
    await vault.addBlackList(alice.address)
    await expect(vault.connect(bob).redeem(s(100),bob.address,alice.address)).to.be.revertedWithCustomError(vault,'Blacklisted')
    await expect(vault.connect(alice).withdraw(u(10),alice.address,alice.address)).to.be.revertedWithCustomError(vault,'Blacklisted')
    await vault.removeBlackList(alice.address)
    await vault.addBlackList(bob.address)
    await expect(vault.connect(alice).redeem(s(100),bob.address,alice.address)).to.be.revertedWithCustomError(vault,'Blacklisted')
    await vault.connect(alice).redeem(s(100),alice.address,alice.address)
    await conserved(f)
  })

})
