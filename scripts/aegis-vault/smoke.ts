import assert from 'assert/strict'
import { ethers } from 'hardhat'
import { writeFileSync } from 'fs'
import { loadRecord, checkNetwork, confirmed, recordPath } from './common'
import { createQuote } from './quotes'

async function main() {
  await checkNetwork()
  const record = loadRecord()
  if (record.chainId !== 11155111 || record.status !== 'ready') throw new Error('Ready Sepolia deployment required')
  const [user] = await ethers.getSigners(), a = record.contracts, c = record.settings
  const minting: any = await ethers.getContractAt('VaultMinting', a.minting.address), token: any = await ethers.getContractAt('VaultToken', a.token.address)
  const staking: any = await ethers.getContractAt('VaultStaking', a.staking.address), collateral = await ethers.getContractAt('IERC20', c.asset)
  const transactions: { action: string; hash: string; block: number }[] = []
  async function tx(action: string, promise: Promise<any>) { const receipt = await confirmed(await promise); transactions.push({ action, hash: receipt.hash, block: receipt.blockNumber }); console.log(`${action}: ${receipt.hash}`) }
  const initialSupply = await token.totalSupply()
  const q = await createQuote(record, 0, user.address, '1')
  await tx('approve collateral', collateral.approve(minting.target, 1_000_000))
  await tx('mint intermediary', minting.mint(q.order, q.signature))
  assert.equal(await token.totalSupply(), initialSupply + BigInt(q.order.tokenAmount))
  const minted = BigInt(q.order.tokenAmount), preview = await staking.previewDeposit(minted), beforeShares = await staking.balanceOf(user.address)
  await tx('approve staking', token.approve(staking.target, minted))
  await tx('stake into vault', staking.deposit(minted, user.address))
  assert.equal(await staking.balanceOf(user.address), beforeShares + preview)
  await tx('transfer deposited USDC to custody', minting.transferToCustody(c.custodian, c.asset, 1_000_000))
  const sharesToRedeem = preview / 10n, expected = await staking.previewRedeem(sharesToRedeem), gross = await staking.convertToAssets(sharesToRedeem), beforeTokens = await token.balanceOf(user.address)
  await tx('immediate ERC4626 exit', staking.redeem(sharesToRedeem, user.address, user.address))
  assert.equal(await token.balanceOf(user.address), beforeTokens + expected + (c.insuranceFund.toLowerCase() === user.address.toLowerCase() ? gross - expected : 0n))
  const redemption = await createQuote(record, 1, user.address, ethers.formatEther(expected))
  const cash = BigInt(redemption.order.collateralAmount)
  await tx('return redemption liquidity', collateral.transfer(minting.target, cash))
  await tx('approve token redemption', token.approve(minting.target, expected))
  await tx('request bank redemption', minting.requestRedeem(redemption.order, redemption.signature))
  assert.equal((await minting.getRedeemRequest(redemption.requestId)).status, 0n)
  const cashBefore = await collateral.balanceOf(user.address)
  await tx('approve and pay bank redemption', minting.approveRedeemRequest(redemption.requestId, cash))
  assert.equal((await minting.getRedeemRequest(redemption.requestId)).status, 1n)
  assert.equal(await collateral.balanceOf(user.address), cashBefore + cash)
  const rateBefore = await staking.convertToAssets(ethers.parseEther('1'))
  const income = await createQuote(record, 0, user.address, '0.01')
  await tx('approve income collateral', collateral.approve(minting.target, 10_000))
  await tx('mint collateralized income', minting.mint(income.order, income.signature))
  await tx('fund staking yield without rewards contracts', token.transfer(staking.target, income.order.tokenAmount))
  assert(await staking.convertToAssets(ethers.parseEther('1')) > rateBefore)
  assert.equal(await minting.aegisRewards(), ethers.ZeroAddress)
  const result = { checkedAt: new Date().toISOString(), chainId: record.chainId, wallet: user.address, requestId: redemption.requestId, transactions, assertions: ['minted collateral-backed intermediary tokens', 'received previewed staking shares', 'moved USDC into configured custody', 'received previewed immediate exit amount', 'paid an approved bank redemption', 'increased staking share value with funded income while rewards remain absent'], remainingShares: (await staking.balanceOf(user.address)).toString(), totalStaked: (await staking.totalAssets()).toString() }
  writeFileSync(recordPath.replace('.json', '.smoke.json'), JSON.stringify(result, null, 2) + '\n')
  console.log('Live lifecycle assertions passed')
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
