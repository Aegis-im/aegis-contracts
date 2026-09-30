import { expect } from 'chai'
import { ethers, upgrades } from 'hardhat'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'

const z = ethers.ZeroAddress, e = ethers.parseEther, u = (v: string) => ethers.parseUnits(v, 6)
export const orderTypes = { Order: [
  { name: 'orderType', type: 'uint8' }, { name: 'userWallet', type: 'address' },
  { name: 'collateralAsset', type: 'address' }, { name: 'collateralAmount', type: 'uint256' },
  { name: 'tokenAmount', type: 'uint256' }, { name: 'slippageAdjustedAmount', type: 'uint256' },
  { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'additionalData', type: 'bytes' },
] }
const data = (s: string) => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [s])

async function fixture() {
  const [admin, investor, custody, stranger, insurance] = await ethers.getSigners()
  const collateral: any = await ethers.deployContract('TestToken', ['Collateral', 'COL', 6])
  const token: any = await ethers.deployContract('VaultToken', ['Bank Dollar', 'BANK', admin.address])
  const config: any = await ethers.deployContract('VaultConfig', [admin.address, [admin.address], admin.address])
  await config.disableWhitelist()
  const oracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['BANK / USD', 8, [admin.address], admin.address])
  const assetOracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['COL / USD', 6, [admin.address], admin.address])
  await oracle.updatePrice(100000000); await assetOracle.updatePrice(1000000)
  const minting: any = await ethers.deployContract('VaultMinting', ['Bank Minting', token.target, config.target, z, oracle.target, z, insurance.address, [collateral.target], [86400], [custody.address], admin.address, 86400, 86400])
  for (const r of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) await minting.grantRole(ethers.id(r), admin.address)
  await minting.setAssetPriceFeed(collateral.target, assetOracle.target)
  await token.setMinter(minting.target)
  await minting.setIncomeFeeBP(0)
  const staking: any = await upgrades.deployProxy(await ethers.getContractFactory('VaultStaking'), [token.target, admin.address, 'Staked Bank Dollar', 'sBANK', 30 * 86400, 50, insurance.address], { kind: 'transparent' })
  await collateral.mint(investor.address, u('10000'))
  await collateral.connect(investor).approve(minting.target, ethers.MaxUint256)
  let nonce = 0
  async function order(type = 0, wallet = investor.address, units = '100', id = 'request', extra: any = {}) {
    const o = { orderType: type, userWallet: wallet, collateralAsset: collateral.target, collateralAmount: u(units), tokenAmount: e(units), slippageAdjustedAmount: type === 1 ? u(units) : e(units), expiry: (await time.latest()) + 3600, nonce: ++nonce, additionalData: data(id), ...extra }
    const sig = await admin.signTypedData({ name: 'Bank Minting', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: minting.target }, orderTypes, o)
    return [o, sig] as const
  }
  async function mint(units = '100') { const o = await order(0, investor.address, units); await minting.connect(investor).mint(...o) }
  async function stake(units = '100') { await mint(units); await token.connect(investor).approve(staking.target, ethers.MaxUint256); await staking.connect(investor).deposit(e(units), investor.address) }
  return { admin, investor, custody, stranger, insurance, collateral, token, config, oracle, assetOracle, minting, staking, order, mint, stake }
}

describe('AegisVault reusable infrastructure', () => {
  it('deploys configurable identities and proxy initialization, with rewards absent', async () => {
    const f = await loadFixture(fixture)
    expect(await f.token.name()).eq('Bank Dollar'); expect(await f.staking.symbol()).eq('sBANK')
    expect(await f.oracle.description()).eq('BANK / USD'); expect(await f.assetOracle.decimals()).eq(6)
    expect(await f.minting.aegisRewards()).eq(z)
    await expect(f.staking.initialize(f.token.target, f.admin.address, 'x', 'x', 0, 0, f.admin.address)).reverted
    const impl = await upgrades.erc1967.getImplementationAddress(f.staking.target)
    await expect((await ethers.getContractAt('VaultStaking', impl)).initialize(f.token.target, f.admin.address, 'x', 'x', 0, 0, f.admin.address)).reverted
  })
  it('mints using different feed precisions, moves collateral to custody, and fulfills a funded redeem', async () => {
    const f = await loadFixture(fixture); await f.mint()
    expect(await f.token.balanceOf(f.investor.address)).eq(e('100'))
    await f.minting.transferToCustody(f.custody.address, f.collateral.target, u('100'))
    expect(await f.collateral.balanceOf(f.custody.address)).eq(u('100'))
    await f.token.connect(f.investor).approve(f.minting.target, e('25'))
    await f.minting.connect(f.investor).requestRedeem(...await f.order(1, f.investor.address, '25'))
    await expect(f.minting.approveRedeemRequest('request', u('25'))).revertedWithCustomError(f.minting, 'NotEnoughFunds')
    await f.collateral.connect(f.custody).transfer(f.minting.target, u('25'))
    await f.minting.approveRedeemRequest('request', u('25'))
    expect(await f.token.totalSupply()).eq(e('75')); expect((await f.minting.getRedeemRequest('request')).status).eq(1)
  })
  it('rejects replay, wrong sender/domain, missing feed, whitelist, pause and blacklist violations', async () => {
    const f = await loadFixture(fixture); const signed = await f.order()
    await expect(f.minting.connect(f.stranger).mint(...signed)).reverted
    await f.config.enableWhitelist(); await expect(f.minting.connect(f.investor).mint(...signed)).revertedWithCustomError(f.minting, 'NotWhitelisted')
    await f.config.disableWhitelist(); await f.minting.setMintPaused(true)
    await expect(f.minting.connect(f.investor).mint(...signed)).revertedWithCustomError(f.minting, 'MintPaused')
    await f.minting.setMintPaused(false); await f.token.addBlackList(f.investor.address)
    await expect(f.minting.connect(f.investor).mint(...signed)).revertedWithCustomError(f.token, 'Blacklisted')
    await f.token.removeBlackList(f.investor.address); await f.minting.connect(f.investor).mint(...signed)
    await expect(f.minting.connect(f.investor).mint(...signed)).revertedWithCustomError(f.minting, 'InvalidNonce')
    const bad = await f.admin.signTypedData({ name: 'Other Bank', version: '1', chainId: 1337, verifyingContract: f.minting.target }, orderTypes, signed[0])
    await expect(f.minting.connect(f.investor).mint(signed[0], bad)).reverted
    await f.minting.setAssetPriceFeed(f.collateral.target, z)
    await expect(f.minting.quoteMint(f.collateral.target, 1)).revertedWithCustomError(f.minting, 'InvalidPrice')
  })
  it('uses the token oracle on both quotes and fails closed on stale or invalid prices', async () => {
    const f = await loadFixture(fixture)
    await f.oracle.updatePrice(200000000)
    expect(await f.minting.quoteMint(f.collateral.target, u('10'))).eq(e('5'))
    expect(await f.minting.quoteRedeem(f.collateral.target, e('5'))).eq(u('10'))
    await expect(f.oracle.updatePrice(0)).revertedWith('Invalid price')
    await expect(f.oracle.connect(f.stranger).updatePrice(100)).reverted
    await time.increase(86401)
    await expect(f.minting.quoteMint(f.collateral.target, 1)).revertedWithCustomError(f.minting, 'InvalidPrice')
  })
  it('keeps frozen/custody balances separate from redeem liquidity', async () => {
    const f = await loadFixture(fixture); await f.mint()
    await f.minting.freezeFunds(f.collateral.target, u('20'))
    expect(await f.minting.custodyAvailableAssetBalance(f.collateral.target)).eq(u('80'))
    await expect(f.minting.transferToCustody(f.custody.address, f.collateral.target, u('81'))).reverted
    await expect(f.minting.connect(f.stranger).transferToCustody(f.custody.address, f.collateral.target, 1)).reverted
  })
  for (const fee of [0, 50, 9999]) it(`matches ERC-4626 preview/actual amounts and maximum withdrawals with ${fee} bp fee`, async () => {
    const f = await loadFixture(fixture); await f.stake('200')
    await f.staking.setInstantUnstakingFee(fee)
    const net = e('0.001'), shares = await f.staking.previewWithdraw(net)
    const before = await f.token.balanceOf(f.investor.address)
    await expect(f.staking.connect(f.investor).withdraw(net, f.investor.address, f.investor.address)).emit(f.staking, 'Withdraw').withArgs(f.investor.address, f.investor.address, f.investor.address, net, shares)
    expect(await f.token.balanceOf(f.investor.address)).eq(before + net)
    const redeemShares = e('1'), preview = await f.staking.previewRedeem(redeemShares)
    await expect(f.staking.connect(f.investor).redeem(redeemShares, f.investor.address, f.investor.address)).changeTokenBalance(f.token, f.investor, preview)
    const max = await f.staking.maxWithdraw(f.investor.address)
    await expect(f.staking.connect(f.investor).withdraw(max, f.investor.address, f.investor.address)).changeTokenBalance(f.token, f.investor, max)
  })
  it('supports delegated ERC-4626 exits and fee-free cooldown escrow without double counting', async () => {
    const f = await loadFixture(fixture); await f.stake()
    await f.staking.connect(f.investor).approve(f.stranger.address, e('1'))
    await f.staking.connect(f.stranger).redeem(e('1'), f.investor.address, f.investor.address)
    await f.staking.connect(f.investor).cooldownShares(e('10'), f.investor.address)
    expect(await f.staking.totalAssets()).eq(e('89'))
    expect((await f.staking.cooldowns(f.investor.address)).underlyingAmount).eq(e('10'))
    await expect(f.staking.connect(f.investor).unstake(f.investor.address)).revertedWithCustomError(f.staking, 'CooldownNotEnded')
    await time.increase(30 * 86400)
    await expect(f.staking.connect(f.investor).unstake(f.investor.address)).changeTokenBalance(f.token, f.investor, e('10'))
    await expect(f.staking.connect(f.investor).unstake(f.investor.address)).reverted
    await f.staking.setCooldownDuration(0)
    expect(await f.staking.previewRedeem(e('1'))).eq(e('1'))
  })
  it('attaches rewards/router after minting and staking, then routes income and increases share value', async () => {
    const f = await loadFixture(fixture); await f.stake()
    const empty = await f.order(2, f.admin.address, '10', 'income')
    await expect(f.minting.depositIncome(...empty)).revertedWithCustomError(f.minting, 'RewardsNotConfigured')
    const rewards: any = await ethers.deployContract('VaultRewards', ['Bank Rewards', 86400, f.token.target, f.config.target, f.admin.address])
    const router: any = await ethers.deployContract('VaultIncomeRouter', ['Bank Income', f.token.target, f.minting.target, rewards.target, f.admin.address, 86400, z, z, z, z, z, f.collateral.target, 0])
    await rewards.setVaultMintingAddress(f.minting.target); await rewards.setVaultIncomeRouterAddress(router.target)
    await rewards.setStakingContract(f.staking.target)
    await rewards.grantRole(ethers.id('REWARDS_MANAGER_ROLE'), f.admin.address)
    await router.grantRole(ethers.id('INCOME_ROUTER_ROLE'), f.admin.address)
    await f.minting.grantRole(ethers.id('FUNDS_MANAGER_ROLE'), router.target)
    await f.minting.setVaultRewardsAddress(rewards.target)
    await f.collateral.mint(router.target, u('10'))
    const signed = await f.order(2, router.target, '10', 'income')
    await router.routeIncome(0, ...signed, '0x')
    expect(await f.token.balanceOf(rewards.target)).eq(e('10'))
    await rewards.sendToStaking(ethers.encodeBytes32String('income'), e('10'))
    expect(await f.staking.convertToAssets(e('100'))).closeTo(e('110'), 1)
    expect((await rewards.rewardById('income')).amount).eq(0)
    await expect(rewards.sendToStaking(ethers.encodeBytes32String('income'), 1)).reverted
    await f.minting.setVaultRewardsAddress(z)
    await expect(f.minting.depositIncome(...await f.order(2, f.admin.address, '1'))).revertedWithCustomError(f.minting, 'RewardsNotConfigured')
    await f.mint('1')
  })
  it('restricts cross-chain mint/burn and pause to the configured operator', async () => {
    const f = await loadFixture(fixture)
    await expect(f.minting.connect(f.stranger).mintForCrossChain(f.investor.address, 1)).reverted
    await f.minting.setCrossChainOperator(f.stranger.address)
    await f.minting.connect(f.stranger).mintForCrossChain(f.investor.address, e('1'))
    await f.token.connect(f.investor).approve(f.minting.target, e('1'))
    await f.minting.connect(f.stranger).burnForCrossChain(f.investor.address, e('1'))
    expect(await f.token.totalSupply()).eq(0)
    await f.minting.setCrossChainPaused(true)
    await expect(f.minting.connect(f.stranger).mintForCrossChain(f.investor.address, 1)).revertedWithCustomError(f.minting, 'CrossChainPaused')
  })
})

describe('AegisVault income and redemption boundaries', () => {
  it('pays signed reward snapshots and cannot divert finalized rewards into staking', async () => {
    const f = await loadFixture(fixture); await f.stake()
    const rewards: any = await ethers.deployContract('VaultRewards', ['Bank Rewards', 0, f.token.target, f.config.target, f.admin.address])
    await rewards.setVaultMintingAddress(f.minting.target); await rewards.setStakingContract(f.staking.target)
    await rewards.grantRole(ethers.id('REWARDS_MANAGER_ROLE'), f.admin.address)
    await f.minting.setVaultRewardsAddress(rewards.target)
    await f.collateral.mint(f.minting.target, u('10'))
    await f.minting.depositIncome(...await f.order(2, f.admin.address, '10', 'snapshot'))
    const id = ethers.encodeBytes32String('snapshot')
    await rewards.finalizeRewards(id, 3600)
    await expect(rewards.sendToStaking(id, e('1'))).reverted
    const claim = { claimer: f.investor.address, ids: [id], amounts: [e('10')] }
    const sig = await f.admin.signTypedData({ name: 'Bank Rewards', version: '1', chainId: 1337, verifyingContract: rewards.target }, { ClaimRequest: [{ name: 'claimer', type: 'address' }, { name: 'ids', type: 'bytes32[]' }, { name: 'amounts', type: 'uint256[]' }] }, claim)
    await expect(rewards.connect(f.investor).claimRewards(claim, sig)).changeTokenBalance(f.token, f.investor, e('10'))
    await expect(rewards.connect(f.investor).claimRewards(claim, sig)).reverted
    await expect(f.minting.setVaultRewardsAddress(f.stranger.address)).reverted
  })
  it('supports expired/rejected redemptions and rejects expired/replayed requests', async () => {
    const f = await loadFixture(fixture); await f.mint()
    await f.token.connect(f.investor).approve(f.minting.target, e('100'))
    const signed = await f.order(1, f.investor.address, '10', 'expiry')
    await f.minting.connect(f.investor).requestRedeem(...signed)
    await expect(f.minting.withdrawRedeemRequest('expiry')).reverted
    await time.increase(3601)
    await expect(f.minting.withdrawRedeemRequest('expiry')).changeTokenBalance(f.token, f.investor, e('10'))
    await expect(f.minting.connect(f.investor).requestRedeem(...signed)).reverted
    await f.minting.connect(f.investor).requestRedeem(...await f.order(1, f.investor.address, '10', 'rejected'))
    await expect(f.minting.rejectRedeemRequest('rejected')).changeTokenBalance(f.token, f.investor, e('10'))
    expect(await f.minting.totalRedeemLockedToken()).eq(0)
  })
  it('enforces per-period limits, net mint fees and token-domain permits', async () => {
    const f = await loadFixture(fixture)
    await f.minting.setMintLimits(86400, e('10')); await f.minting.setMintFeeBP(100)
    await f.mint('10'); expect(await f.token.balanceOf(f.investor.address)).eq(e('9.9'))
    await expect(f.mint('1')).revertedWithCustomError(f.minting, 'LimitReached')
    const deadline = (await time.latest()) + 3600
    const permit = { owner: f.investor.address, spender: f.stranger.address, value: e('1'), nonce: 0, deadline }
    const sig = ethers.Signature.from(await f.investor.signTypedData({ name: 'Bank Dollar', version: '1', chainId: 1337, verifyingContract: f.token.target }, { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] }, permit))
    await f.token.permit(f.investor.address, f.stranger.address, e('1'), deadline, sig.v, sig.r, sig.s)
    expect(await f.token.allowance(f.investor.address, f.stranger.address)).eq(e('1'))
  })
})
