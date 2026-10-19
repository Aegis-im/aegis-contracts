import { expect } from 'chai'
import { artifacts, ethers, network, upgrades } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'
import { createHash } from 'crypto'

// Execute the exact flow module shipped by aegis-app with its ethers-v5 dependency,
// against real local deployments. No wallet keys or external RPC are used.
const appRoot = resolve(process.env.AEGIS_APP_ROOT || '../aegis-app')
const appRequire = createRequire(resolve(appRoot, 'package.json'))
const ts = appRequire('typescript'), v5 = appRequire('ethers')
const flowPath = resolve(appRoot, 'src/pages/BankYield/flow.ts')
const source = readFileSync(flowPath, 'utf8')
const loaded: any = { exports: {} }
new Function('require', 'module', 'exports', ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.CommonJS } }).outputText)(appRequire, loaded, loaded.exports)
const { runFlow } = loaded.exports
const e = ethers.parseEther, u = (n: string) => ethers.parseUnits(n, 6), z = ethers.ZeroAddress
const orderTypes = { Order: [
  { name: 'orderType', type: 'uint8' }, { name: 'userWallet', type: 'address' }, { name: 'collateralAsset', type: 'address' },
  { name: 'collateralAmount', type: 'uint256' }, { name: 'tokenAmount', type: 'uint256' }, { name: 'slippageAdjustedAmount', type: 'uint256' },
  { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'additionalData', type: 'bytes' },
] }

async function fixture() {
  const [admin, user, custody] = await ethers.getSigners()
  const token: any = await ethers.deployContract('VaultToken', ['Amina Deposit USDG', 'adUSDG', admin.address])
  const collateral: any = await ethers.deployContract('TestToken', ['USD Coin', 'USDC', 6])
  const config: any = await ethers.deployContract('VaultConfig', [admin.address, [admin.address], admin.address])
  await config.disableWhitelist()
  const oracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['USDG / USD', 8, [admin.address], admin.address])
  const assetOracle: any = await ethers.deployContract('VaultChainlinkOracleV3', ['USDC / USD', 8, [admin.address], admin.address])
  const prices = async () => { await oracle.updatePrice(100000000); await assetOracle.updatePrice(100000000) }
  await prices()
  // Make the investor the fee recipient: balance deltas would incorrectly sweep these fees.
  const minting: any = await ethers.deployContract('VaultMinting', ['Amina Minting', token.target, config.target, z, oracle.target, z, user.address, [collateral.target], [86400], [custody.address], admin.address, 86400, 86400])
  for (const role of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) await minting.grantRole(ethers.id(role), admin.address)
  await minting.setAssetPriceFeed(collateral.target, assetOracle.target); await token.setMinter(minting.target)
  await minting.setMintFeeBP(200); await minting.setRedeemFeeBP(100)
  const staking: any = await upgrades.deployProxy(await ethers.getContractFactory('VaultStaking'), [token.target, admin.address, 'Amina USDG', 'ausdg', 30 * 86400, 50, user.address], { kind: 'transparent' })
  await collateral.mint(user.address, u('1000'))
  await collateral.mint(minting.target, u('1000')) // Returned bank liquidity for payouts.
  await minting.setCrossChainOperator(admin.address); await minting.mintForCrossChain(user.address, e('7'))
  const provider = new v5.providers.Web3Provider({ request: ({ method, params }: any) => network.provider.send(method, params) })
  provider.pollingInterval = 10
  const signer = provider.getSigner(user.address)
  const contract = async (name: string, address: string) => new v5.Contract(address, (await artifacts.readArtifact(name)).abi, signer)
  let saved: any, nonce = 0, quoteFails = false, stopAt = '', walletChanged = false
  const ctx: any = {
    account: user.address, asset: collateral.target, provider,
    token: await contract('VaultToken', token.target), staking: await contract('VaultStaking', staking.target), minting: await contract('VaultMinting', minting.target),
    check: async () => { if (walletChanged) throw new Error('Wallet changed') },
    progress: () => {},
    save: (flow: any) => {
      saved = JSON.parse(JSON.stringify(flow))
      if (stopAt === `receipt:${flow.phase}` && flow.pending) throw new Error('Simulated tab close after broadcast')
    },
    approve: async (address: string, spender: string, value: any) => {
      await ctx.check()
      if (stopAt === 'stake-approval' && spender === staking.target) throw new Error('Wallet declined approval')
      const c = new v5.Contract(address, ['function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)'], signer)
      if ((await c.allowance(user.address, spender)).lt(value)) await (await c.approve(spender, value)).wait()
    },
    quote: async (kind: string, value: any) => {
      if (quoteFails) throw new Error('Quote service unavailable')
      const mint = kind === 'mint', units = BigInt(value.toString()), id = `flow-${++nonce}`
      const tokenAmount = mint ? await minting.quoteMint(collateral.target, units) : units
      const collateralAmount = mint ? units : await minting.quoteRedeem(collateral.target, units)
      const min = mint ? tokenAmount : await minting.quoteRedeem(collateral.target, tokenAmount - tokenAmount / 100n)
      const order = { orderType: mint ? 0 : 1, userWallet: user.address, collateralAsset: collateral.target, collateralAmount: collateralAmount.toString(), tokenAmount: tokenAmount.toString(), slippageAdjustedAmount: min.toString(), expiry: (await time.latest()) + 3600, nonce, additionalData: ethers.AbiCoder.defaultAbiCoder().encode(['string'], [id]) }
      const signature = await admin.signTypedData({ name: 'Amina Minting', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: minting.target }, orderTypes, order)
      return { order, signature, requestId: id }
    },
  }
  const deposit = () => runFlow({ kind: 'deposit', phase: 'mint', amount: u('100').toString() }, ctx)
  const withdraw = (instant = true) => runFlow({ kind: 'withdraw', phase: 'exit', amount: e('10').toString(), instant }, ctx)
  const resume = () => runFlow(saved, ctx)
  return { ctx, token, collateral, minting, staking, user, prices, provider, deposit, withdraw, resume, saved: () => saved, stop: (stage: string) => { stopAt = stage }, quotesFail: (yes: boolean) => { quoteFails = yes }, changeWallet: (yes: boolean) => { walletChanged = yes } }
}
async function rejects(work: Promise<any>, message: string) {
  let error: any
  try { await work } catch (e) { error = e }
  expect(error?.message).contains(message)
}

describe('Amina UI transaction flow with real local contracts', function () {
  this.timeout(60000)
  before(() => console.log(`  UI module: ${flowPath}\n  SHA256: ${createHash('sha256').update(source).digest('hex')}`))
  it('deposits USDC into shares, skips cooldown with exact net assets, then pays USDC after bank approval', async () => {
    const f = await fixture()
    expect((await f.deposit()).phase).eq('done')
    expect(await f.staking.balanceOf(f.user.address)).eq(e('98'))
    expect(await f.token.balanceOf(f.user.address)).eq(e('9')) // Unrelated 7 + mint fee 2, not staked.
    const withdrawal = await f.withdraw()
    expect(withdrawal.phase).eq('bank'); expect(withdrawal.assets).eq(e('9.95').toString())
    expect(await f.token.balanceOf(f.user.address)).eq(e('9.05')) // Exit fee also left untouched.
    const before = await f.collateral.balanceOf(f.user.address)
    const request = await f.minting.getRedeemRequest(withdrawal.requestId)
    await f.minting.approveRedeemRequest(withdrawal.requestId, request.order.collateralAmount)
    expect(await f.collateral.balanceOf(f.user.address)).eq(before + u('9.8505'))
    expect((await f.resume()).phase).eq('done')
  })
  it('resumes a declined staking approval without another mint or sweeping the wallet', async () => {
    const f = await fixture(); f.stop('stake-approval')
    await rejects(f.deposit(), 'Wallet declined approval')
    expect(f.saved().phase).eq('stake'); expect(await f.collateral.balanceOf(f.user.address)).eq(u('900'))
    f.stop(''); await f.resume()
    expect(await f.collateral.balanceOf(f.user.address)).eq(u('900'))
    expect(await f.staking.balanceOf(f.user.address)).eq(e('98')); expect(await f.token.balanceOf(f.user.address)).eq(e('9'))
  })
  for (const phase of ['mint', 'stake']) it(`recovers a ${phase} receipt after a tab closes immediately after broadcast`, async () => {
    const f = await fixture(); f.stop(`receipt:${phase}`)
    await rejects(f.deposit(), 'Simulated tab close')
    expect(f.saved().pending).match(/^0x[0-9a-f]{64}$/i)
    f.stop(''); expect((await f.resume()).phase).eq('done')
    expect(await f.collateral.balanceOf(f.user.address)).eq(u('900')); expect(await f.staking.balanceOf(f.user.address)).eq(e('98'))
  })
  it('resumes after a quote-service failure following exit without burning more shares', async () => {
    const f = await fixture(); await f.deposit(); f.quotesFail(true)
    await rejects(f.withdraw(), 'Quote service unavailable')
    expect(f.saved().phase).eq('redeem'); expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
    f.quotesFail(false); expect((await f.resume()).phase).eq('bank')
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
  })
  it('stops on wallet change between confirmed mint and stake, then safely continues', async () => {
    const f = await fixture(); const save = f.ctx.save
    f.ctx.save = (flow: any) => { save(flow); if (flow.phase === 'stake') f.changeWallet(true) }
    await rejects(f.deposit(), 'Wallet changed')
    expect(f.saved().phase).eq('stake'); expect(await f.staking.balanceOf(f.user.address)).eq(0)
    f.ctx.save = save; f.changeWallet(false); await f.resume()
    expect(await f.staking.balanceOf(f.user.address)).eq(e('98'))
  })
  it('waits through cooldown, then claims and requests bank payout through one continuation', async () => {
    const f = await fixture(); await f.deposit()
    expect((await f.withdraw(false)).phase).eq('cooldown')
    expect((await f.resume()).phase).eq('cooldown')
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
    await time.increase(30 * 86400); await f.prices()
    const result = await f.resume(); expect(result.phase).eq('bank'); expect(result.assets).eq(e('10').toString())
    expect((await f.staking.cooldowns(f.user.address)).underlyingAmount).eq(0)
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
  })
  for (const phase of ['exit', 'redeem']) it(`recovers a ${phase} receipt without duplicating withdrawal steps`, async () => {
    const f = await fixture(); await f.deposit(); f.stop(`receipt:${phase}`)
    await rejects(f.withdraw(), 'Simulated tab close')
    f.stop(''); expect((await f.resume()).phase).eq('bank')
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
    expect(await f.minting.totalRedeemLockedToken()).eq(e('9.95'))
  })
  it('renews expired and rejected requests using the same withdrawn assets', async () => {
    const f = await fixture(); await f.deposit(); const first = await f.withdraw()
    await time.increase(3601)
    const second = await f.resume(); expect(second.requestId).not.eq(first.requestId)
    expect((await f.minting.getRedeemRequest(first.requestId)).status).eq(3)
    await f.minting.rejectRedeemRequest(second.requestId)
    const third = await f.resume(); expect(third.requestId).not.eq(second.requestId)
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88')); expect(await f.minting.totalRedeemLockedToken()).eq(e('9.95'))
  })
  it('recovers a claimed cooldown receipt without claiming or burning shares again', async () => {
    const f = await fixture(); await f.deposit(); await f.withdraw(false)
    await time.increase(30 * 86400); await f.prices(); f.stop('receipt:claim')
    await rejects(f.resume(), 'Simulated tab close')
    f.stop(''); expect((await f.resume()).phase).eq('bank')
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
    expect(await f.minting.totalRedeemLockedToken()).eq(e('10'))
  })
  it('recovers the expiry unlock receipt before renewing a bank request', async () => {
    const f = await fixture(); await f.deposit(); await f.withdraw()
    await time.increase(3601); f.stop('receipt:unlock')
    await rejects(f.resume(), 'Simulated tab close')
    f.stop(''); expect((await f.resume()).phase).eq('bank')
    expect(await f.staking.balanceOf(f.user.address)).eq(e('88'))
    expect(await f.minting.totalRedeemLockedToken()).eq(e('9.95'))
  })
  it('fails closed when storage loses the hash after broadcast', async () => {
    const f = await fixture(), save = f.ctx.save
    f.ctx.save = (flow: any) => { if (flow.pending) throw new Error('Storage full'); save(flow) }
    await rejects(f.deposit(), 'Storage full')
    expect(f.saved().broadcasting).eq(true); expect(f.saved().pending).eq(undefined)
    f.ctx.save = save
    await rejects(f.resume(), 'wallet did not return a transaction hash')
    expect(await f.collateral.balanceOf(f.user.address)).eq(u('900'))
    expect(await f.staking.balanceOf(f.user.address)).eq(0)
  })
  it('allows a declined wallet confirmation to be retried safely', async () => {
    const f = await fixture(), minting = f.ctx.minting
    f.ctx.minting = { address: minting.address, interface: minting.interface, mint: async () => { throw Object.assign(new Error('User declined'), { code: 4001 }) } }
    await rejects(f.deposit(), 'User declined')
    expect(f.saved().broadcasting).eq(false); expect(f.saved().pending).eq(undefined)
    expect(await f.collateral.balanceOf(f.user.address)).eq(u('1000'))
    f.ctx.minting = minting; expect((await f.resume()).phase).eq('done')
    expect(await f.collateral.balanceOf(f.user.address)).eq(u('900'))
  })

})
