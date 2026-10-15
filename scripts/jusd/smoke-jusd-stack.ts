import { ethers, network } from 'hardhat'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

/**
 * Exercises a deployment made by deploy-jusd-stack.ts: mint mock collateral, mint JUSD against a
 * signed order, move collateral into the guard, push it to the whitelisted admin wallet once the
 * 60s cooldown clears, return it as redemption liquidity and redeem.
 *
 * Reads the same record the deploy script writes, so it works locally and against a live network.
 * On the in-memory network it advances time; elsewhere it waits for the cooldown in real time.
 *
 *   npx hardhat run scripts/jusd/smoke-jusd-stack.ts --network sepolia
 */
const recordPath = resolve(process.env.JUSD_RECORD || `deployments/${network.name}/JUSDStack.json`)
const isLocal = network.name === 'hardhat' || network.name === 'localhost'

const orderTypes = { Order: [
  { name: 'orderType', type: 'uint8' }, { name: 'userWallet', type: 'address' },
  { name: 'collateralAsset', type: 'address' }, { name: 'collateralAmount', type: 'uint256' },
  { name: 'yusdAmount', type: 'uint256' }, { name: 'slippageAdjustedAmount', type: 'uint256' },
  { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'additionalData', type: 'bytes' },
] }
const encodeString = (s: string) => ethers.AbiCoder.defaultAbiCoder().encode(['string'], [s])

/**
 * On a local chain the admin has no node-managed key. A real wallet built from PRIVATE_KEY is
 * preferred when it matches the admin, because impersonated accounts can send transactions but
 * cannot produce the EIP-712 signatures the order flow needs. Impersonation is the fallback.
 */
async function localAdminSigner(admin: string) {
  await network.provider.send('hardhat_setBalance', [admin, '0x56BC75E2D63100000'])
  const key = process.env.PRIVATE_KEY
  if (key) {
    const wallet = new ethers.Wallet(key.startsWith('0x') ? key : `0x${key}`, ethers.provider)
    if (wallet.address.toLowerCase() === admin.toLowerCase()) return wallet
  }
  return ethers.getImpersonatedSigner(admin)
}

async function confirmed(tx: any) {
  const receipt = await tx.wait(1)
  if (receipt?.status !== 1) throw new Error(`Transaction failed: ${tx.hash}`)
  return receipt
}

async function waitPast(activeAt: bigint) {
  const now = BigInt((await ethers.provider.getBlock('latest'))!.timestamp)
  if (now > activeAt) return
  const seconds = Number(activeAt - now) + 2
  if (isLocal) {
    await network.provider.send('evm_increaseTime', [seconds])
    await network.provider.send('evm_mine', [])
    return
  }
  console.log(`  waiting ${seconds}s for the whitelist cooldown...`)
  await new Promise(r => setTimeout(r, seconds * 1000))
}

async function main() {
  if (!existsSync(recordPath)) throw new Error(`Missing deployment record: ${recordPath}`)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const a = record.contracts
  const signer = isLocal ? await localAdminSigner(record.admin) : (await ethers.getSigners())[0]
  if (signer.address.toLowerCase() !== record.admin.toLowerCase()) {
    throw new Error(`Smoke test must run as the admin ${record.admin}`)
  }

  const at = (key: string, name = a[key].contract) => ethers.getContractAt(name, a[key].address, signer) as Promise<any>
  const usdTest: any = await at('usdTest')
  const jusd: any = await at('jusd')
  const minting: any = await at('aegisMintingJUSD')
  const guard: any = await at('jusdAssetGuard')

  const u = (v: string) => ethers.parseUnits(v, 6)
  const e = ethers.parseEther
  const requestId = `smoke-${Date.now()}`

  console.log('1. mint 1,000 USDTest to the admin')
  await confirmed(await usdTest.mint(signer.address, u('1000')))
  console.log(`   USDTest balance: ${ethers.formatUnits(await usdTest.balanceOf(signer.address), 6)}`)

  console.log('2. mint 500 JUSD against a signed order')
  if (await usdTest.allowance(signer.address, minting.target) < u('500')) {
    await confirmed(await usdTest.approve(minting.target, ethers.MaxUint256))
  }
  const order = {
    orderType: 0, userWallet: signer.address, collateralAsset: usdTest.target,
    collateralAmount: u('500'), yusdAmount: e('500'), slippageAdjustedAmount: e('499'),
    expiry: BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + 3600n,
    nonce: BigInt(Date.now()), additionalData: encodeString(''),
  }
  const domain = { name: 'AegisMintingJUSD', version: '1', chainId: record.chainId, verifyingContract: a.aegisMintingJUSD.address }
  await confirmed(await minting.mint(order, await signer.signTypedData(domain, orderTypes, order)))
  console.log(`   JUSD balance: ${ethers.formatEther(await jusd.balanceOf(signer.address))}`)

  console.log('3. draw 300 USDTest from minting into the guard')
  await confirmed(await guard.pullFromMinting(usdTest.target, u('300')))
  console.log(`   guard holds: ${ethers.formatUnits(await guard.assetBalance(usdTest.target), 6)} USDTest`)

  console.log('4. push 100 USDTest from the guard to the whitelisted admin wallet')
  await waitPast(await guard.destinationActiveAt(signer.address))
  await confirmed(await guard.withdraw(usdTest.target, signer.address, u('100')))
  console.log(`   admin USDTest: ${ethers.formatUnits(await usdTest.balanceOf(signer.address), 6)}`)

  console.log('5. return 200 USDTest to minting as redemption liquidity')
  await confirmed(await guard.returnToMinting(usdTest.target, u('200')))
  console.log(`   redemption liquidity: ${ethers.formatUnits(await minting.untrackedAvailableAssetBalance(usdTest.target), 6)} USDTest`)

  console.log('6. request and approve a 100 JUSD redemption')
  if (await jusd.allowance(signer.address, minting.target) < e('100')) {
    await confirmed(await jusd.approve(minting.target, ethers.MaxUint256))
  }
  const redeem = {
    orderType: 1, userWallet: signer.address, collateralAsset: usdTest.target,
    collateralAmount: u('100'), yusdAmount: e('100'), slippageAdjustedAmount: u('99'),
    expiry: BigInt((await ethers.provider.getBlock('latest'))!.timestamp) + 3600n,
    nonce: BigInt(Date.now()) + 1n, additionalData: encodeString(requestId),
  }
  await confirmed(await minting.requestRedeem(redeem, await signer.signTypedData(domain, orderTypes, redeem)))
  await confirmed(await minting.approveRedeemRequest(requestId, u('100')))
  const request = await minting.getRedeemRequest(requestId)
  console.log(`   request ${requestId} status: ${request.status} (1 = approved)`)

  console.log('\nSmoke test passed:')
  console.log(`  USDTest admin   ${ethers.formatUnits(await usdTest.balanceOf(signer.address), 6)}`)
  console.log(`  USDTest guard   ${ethers.formatUnits(await guard.assetBalance(usdTest.target), 6)}`)
  console.log(`  JUSD admin      ${ethers.formatEther(await jusd.balanceOf(signer.address))}`)
  console.log(`  JUSD supply     ${ethers.formatEther(await jusd.totalSupply())}`)
}

main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
