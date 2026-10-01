import { expect } from 'chai'
import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'

const usdc = (value: string) => ethers.parseUnits(value, 6)
const shares = (value: string) => ethers.parseUnits(value, 18)

// All steps execute against real deployed contracts on the local EVM. No mocked vault calls,
// storage overrides, or impersonation; only time advancement accelerates the 30-day cooldown.
describe('AegisCreditVault end-to-end investor lifecycle', () => {
  it('deposits, funds counterparty, transfers shares, reports yield, reprices, requests and claims redemption', async () => {
    const [admin, manager, counterparty, alice, bob, outsider] = await ethers.getSigners()
    const token = await ethers.deployContract('TestToken', ['USD Coin', 'USDC', 6])
    const config = await ethers.deployContract('AegisConfig', [admin.address, [admin.address], admin.address])
    expect(await config.isWhitelisted(alice.address)).to.equal(false)
    expect(await config.isWhitelisted(bob.address)).to.equal(false)
    const vault = await ethers.deployContract('AegisCreditVault', [
      token.target, config.target, counterparty.address, admin.address, manager.address,
    ])
    await token.mint(alice.address, usdc('1000'))
    let tokensCreated = usdc('1000')

    // Exact cash conservation (including the counterparty), NAV, supply, and escrow ownership.
    const checkpoint = async (cash: bigint, external: bigint, supply: bigint, escrow: bigint, reserves: bigint) => {
      expect(await token.balanceOf(vault.target)).to.equal(cash + reserves)
      expect(await vault.liquidAssets()).to.equal(cash)
      expect(await vault.reportedExternalAssets()).to.equal(external)
      expect(await vault.totalAssets()).to.equal(cash + external)
      expect(await vault.claimReserves()).to.equal(reserves)
      expect(await vault.totalSupply()).to.equal(supply)
      expect(await vault.balanceOf(vault.target)).to.equal(escrow)
      expect(await vault.balanceOf(alice.address) + await vault.balanceOf(bob.address) + escrow).to.equal(supply)
      const balances = await Promise.all([alice.address, bob.address, counterparty.address, vault.target]
        .map(address => token.balanceOf(address)))
      expect(balances.reduce((sum, balance) => sum + balance, 0n)).to.equal(tokensCreated)
    }

    // 1. Alice approves and deposits 1,000 USDC; she receives 1,000 shares immediately.
    await token.connect(alice).approve(vault.target, usdc('1000'))
    await expect(vault.connect(alice)['deposit(uint256,address)'](usdc('1000'), alice.address))
      .to.emit(vault, 'Deposit').withArgs(alice.address, alice.address, usdc('1000'), shares('1000'))
    expect(await token.balanceOf(alice.address)).to.equal(0)
    expect(await vault.balanceOf(alice.address)).to.equal(shares('1000'))
    expect(await vault.convertToAssets(shares('400'))).to.equal(usdc('400'))
    await checkpoint(usdc('1000'), 0n, shares('1000'), 0n, 0n)

    // 2. The manager sends the underlying to the counterparty. NAV does not fall with cash.
    await expect(vault.connect(outsider).fundCounterparty(usdc('1000')))
      .to.be.revertedWithCustomError(vault, 'AccessControlUnauthorizedAccount')
    await expect(vault.connect(manager).fundCounterparty(usdc('1000')))
      .to.emit(vault, 'CounterpartyFunded').withArgs(usdc('1000'))
    expect(await token.balanceOf(counterparty.address)).to.equal(usdc('1000'))
    expect(await vault.convertToAssets(shares('400'))).to.equal(usdc('400'))
    await checkpoint(0n, usdc('1000'), shares('1000'), 0n, 0n)

    // 3. Alice transfers 400 shares to Bob while all underlying is deployed externally.
    await vault.addBlackList(outsider.address)
    await expect(vault.connect(alice).transfer(outsider.address, shares('400')))
      .to.be.revertedWithCustomError(vault, 'Blacklisted').withArgs(outsider.address)
    await vault.removeBlackList(outsider.address)
    await expect(vault.connect(alice).transfer(bob.address, shares('400')))
      .to.emit(vault, 'Transfer').withArgs(alice.address, bob.address, shares('400'))
    expect(await vault.balanceOf(alice.address)).to.equal(shares('600'))
    expect(await vault.balanceOf(bob.address)).to.equal(shares('400'))
    expect(await token.balanceOf(bob.address)).to.equal(0)
    await checkpoint(0n, usdc('1000'), shares('1000'), 0n, 0n)

    // 4. Simulate 100 USDC of externally earned yield and report external value of 1,100.
    await token.mint(counterparty.address, usdc('100'))
    tokensCreated += usdc('100')
    await expect(vault.connect(bob).reportExternalAssets(usdc('1100')))
      .to.be.revertedWithCustomError(vault, 'AccessControlUnauthorizedAccount')
    await expect(vault.connect(manager).reportExternalAssets(usdc('1100')))
      .to.emit(vault, 'ExternalAssetsReported').withArgs(usdc('1000'), usdc('1100'))
    expect(await vault.lastReportAt()).to.equal(await time.latest())
    // Independent economic expectation: approximately 1.10 USDC/share. The virtual
    // asset/share offset and floor rounding leave one micro-USDC below 440 here.
    const payout = usdc('439.999999')
    expect(await vault.convertToAssets(shares('1'))).to.equal(usdc('1.099999'))
    expect(await vault.convertToAssets(shares('400'))).to.equal(payout)
    expect(await vault.convertToShares(usdc('400'))).to.be.lt(shares('400'))
    await checkpoint(0n, usdc('1100'), shares('1000'), 0n, 0n)

    // 5. Bob requests redemption of the transferred shares. They leave his custody,
    // but remain in supply and NAV until fulfillment. No USDC is paid yet.
    expect(await vault.connect(bob).requestRedeem.staticCall(shares('400'), bob.address, bob.address)).to.equal(0)
    const tx = await vault.connect(bob).requestRedeem(shares('400'), bob.address, bob.address)
    await expect(tx).to.emit(vault, 'RedeemRequest').withArgs(bob.address, bob.address, 0, bob.address, shares('400'))
    const receipt = await tx.wait()
    const block = await ethers.provider.getBlock(receipt!.blockNumber)
    const readyAt = BigInt(block!.timestamp + 30 * 86400)
    expect((await vault.redemptions(bob.address)).readyAt).to.equal(readyAt)
    expect(await vault.pendingRedeemRequest(0, bob.address)).to.equal(shares('400'))
    expect(await vault.pendingRedeemRequest(0, alice.address)).to.equal(0)
    expect(await vault.maxRedeem(bob.address)).to.equal(0)
    expect(await vault.maxWithdraw(bob.address)).to.equal(0)
    expect(await vault.balanceOf(bob.address)).to.equal(0)
    await expect(vault.connect(bob).transfer(alice.address, 1)).to.be.reverted
    await expect(vault.connect(bob).redeem(shares('400'), bob.address, bob.address))
      .to.be.revertedWithCustomError(vault, 'InvalidAmount')
    await checkpoint(0n, usdc('1100'), shares('1000'), shares('400'), 0n)

    // 6. Cooldown and cash availability are independent gates. Failed fulfillment
    // at either boundary must leave the request, escrow, and NAV untouched.
    await time.setNextBlockTimestamp(readyAt - 1n)
    await expect(vault.fulfillRedeem(bob.address)).to.be.revertedWithCustomError(vault, 'TooEarly')
    await time.setNextBlockTimestamp(readyAt)
    await expect(vault.fulfillRedeem(bob.address)).to.be.revertedWithCustomError(vault, 'InsufficientLiquidity')
    expect(await vault.pendingRedeemRequest(0, bob.address)).to.equal(shares('400'))
    await checkpoint(0n, usdc('1100'), shares('1000'), shares('400'), 0n)

    // 7. Principal plus yield return as real USDC. This changes cash composition, not NAV.
    await token.connect(counterparty).approve(vault.target, usdc('1100'))
    await expect(vault.connect(counterparty).returnLiquidity(usdc('1100')))
      .to.emit(vault, 'LiquidityReturned').withArgs(usdc('1100'))
    expect(await token.balanceOf(counterparty.address)).to.equal(0)
    expect(await vault.convertToAssets(shares('400'))).to.equal(payout)
    await checkpoint(usdc('1100'), 0n, shares('1000'), shares('400'), 0n)

    // 8. Anyone can fulfill; only Bob or his operator can claim. Burned shares and
    // reserved USDC leave active supply and NAV together, protecting Alice's position.
    await expect(vault.connect(outsider).fulfillRedeem(bob.address))
      .to.emit(vault, 'RedeemFulfilled').withArgs(bob.address, shares('400'), payout)
    const remainingCash = usdc('1100') - payout
    expect(await vault.pendingRedeemRequest(0, bob.address)).to.equal(0)
    expect(await vault.claimableRedeemRequest(0, bob.address)).to.equal(shares('400'))
    expect(await vault.maxWithdraw(bob.address)).to.equal(payout)
    expect(await token.balanceOf(bob.address)).to.equal(0)
    await checkpoint(remainingCash, 0n, shares('600'), 0n, payout)
    await expect(vault.connect(manager).fundCounterparty(remainingCash + 1n))
      .to.be.revertedWithCustomError(vault, 'InsufficientLiquidity')
    await expect(vault.connect(alice).redeem(shares('400'), alice.address, bob.address))
      .to.be.revertedWithCustomError(vault, 'Unauthorized')

    // 9. Exercise both standard claim entry points: a partial asset withdrawal and
    // redemption of all remaining claim shares. Bob receives precisely the reserved sum.
    await expect(vault.connect(bob).withdraw(usdc('100'), bob.address, bob.address)).to.emit(vault, 'Withdraw')
    expect(await token.balanceOf(bob.address)).to.equal(usdc('100'))
    expect(await vault.maxWithdraw(bob.address)).to.equal(payout - usdc('100'))
    await checkpoint(remainingCash, 0n, shares('600'), 0n, payout - usdc('100'))
    const remainingClaimShares = await vault.maxRedeem(bob.address)
    await expect(vault.connect(bob).redeem(remainingClaimShares, bob.address, bob.address))
      .to.emit(vault, 'Withdraw').withArgs(bob.address, bob.address, bob.address, payout - usdc('100'), remainingClaimShares)
    expect(await token.balanceOf(bob.address)).to.equal(payout)
    expect(await vault.maxWithdraw(bob.address)).to.equal(0)
    expect(await vault.maxRedeem(bob.address)).to.equal(0)
    expect(await vault.balanceOf(alice.address)).to.equal(shares('600'))
    await expect(vault.connect(bob).redeem(1, bob.address, bob.address)).to.be.revertedWithCustomError(vault, 'InvalidAmount')
    await expect(vault.fulfillRedeem(bob.address)).to.be.revertedWithCustomError(vault, 'InvalidAmount')
    await checkpoint(remainingCash, 0n, shares('600'), 0n, 0n)
  })
})
