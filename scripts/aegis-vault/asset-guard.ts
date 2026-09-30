import { ethers } from 'hardhat'
import { settings as c, loadRecord, saveRecord, checkNetwork, confirmed } from './common'

/**
 * Deploys VaultAssetGuard and installs it in place of the custody wallet of an existing deployment.
 *
 * Optional configuration keys (defaults in brackets):
 *   guardDestinations     [{ address: c.custodian, label: 'Configured custody wallet' }]
 *                         Initial withdrawal whitelist.
 *   guardManager          [c.manager]  Holder of COLLATERAL_MANAGER_ROLE — moves assets.
 *   guardWhitelistManager [c.admin]    Holder of WHITELIST_MANAGER_ROLE — maintains the whitelist.
 *   guardDrawFromMinting  [true]       Grants the guard minting's COLLATERAL_MANAGER_ROLE so it
 *                                      can draw collateral itself via pullFromMinting.
 *   guardRetireWallet     [false]      Removes the previously configured custody wallet from
 *                                      minting's custodian list once the guard is registered.
 *   guardWhitelistCooldown [0]         Seconds a newly whitelisted destination waits before it can
 *                                      receive funds. Fixed at deployment; 0 disables it.
 */
export async function attachAssetGuard(record: any) {
  const [admin] = await ethers.getSigners()
  if (admin.address.toLowerCase() !== c.admin.toLowerCase()) throw new Error('Asset guard setup requires the configured administrator')
  if (record.chainId !== c.chainId) throw new Error('Wrong deployment chain')
  const a = record.contracts
  if (!a.minting) throw new Error('Deploy the core first; the asset guard needs a minting address')

  const wanted: { address: string, label: string }[] = c.guardDestinations ?? [{ address: c.custodian, label: 'Configured custody wallet' }]
  const manager = c.guardManager ?? c.manager
  const whitelistManager = c.guardWhitelistManager ?? c.admin
  const drawFromMinting = c.guardDrawFromMinting ?? true

  let guard: any
  if (a.assetGuard) {
    if (await ethers.provider.getCode(a.assetGuard.address) === '0x') throw new Error('Missing code: assetGuard')
    guard = await ethers.getContractAt('VaultAssetGuard', a.assetGuard.address)
  } else {
    const args = [a.minting.address, c.admin, c.adminDelay, wanted.map(d => d.address), wanted.map(d => d.label), c.guardWhitelistCooldown ?? 0]
    guard = await ethers.deployContract('VaultAssetGuard', args)
    await guard.waitForDeployment()
    a.assetGuard = { address: await guard.getAddress(), contract: 'VaultAssetGuard', args, transactionHash: guard.deploymentTransaction().hash }
    saveRecord(record)
    console.log(`assetGuard: ${a.assetGuard.address}`)
  }

  const minting: any = await ethers.getContractAt('VaultMinting', a.minting.address)
  const collateralManager = ethers.id('COLLATERAL_MANAGER_ROLE'), whitelistRole = ethers.id('WHITELIST_MANAGER_ROLE')

  // Collateral reaches the guard only once minting recognizes it as a custodian address.
  if (!await minting.isSupportedAsset(c.asset)) throw new Error('Configured asset is not supported by minting')
  if (await guard.mintingAddress() !== a.minting.address) await confirmed(await guard.setMintingAddress(a.minting.address))
  await setCustodianRegistration(minting, 'addCustodianAddress', String(guard.target))
  if (drawFromMinting && !await minting.hasRole(collateralManager, guard.target)) {
    await confirmed(await minting.grantRole(collateralManager, guard.target))
  }

  for (const [role, holder] of [[collateralManager, manager], [whitelistRole, whitelistManager]] as const) {
    if (!await guard.hasRole(role, holder)) await confirmed(await guard.grantRole(role, holder))
  }
  for (const destination of wanted) {
    if (!await guard.isDestination(destination.address)) await confirmed(await guard.addDestination(destination.address, destination.label))
  }

  // Retiring the old wallet is a governance decision; it is never implied by installing the guard.
  if (c.guardRetireWallet && c.custodian.toLowerCase() !== String(guard.target).toLowerCase()) {
    if (await setCustodianRegistration(minting, 'removeCustodianAddress', c.custodian)) console.log(`retired custody wallet: ${c.custodian}`)
  }

  record.assetGuardAttachedAt = new Date().toISOString(); saveRecord(record)
  console.log(`asset guard installed; destinations: ${(await guard.destinations()).join(', ') || 'none'}`)
}

/**
 * VaultMinting exposes no custodian getter, so membership is probed with a static call: adding an
 * already-registered address and removing an absent one both revert with InvalidCustodianAddress.
 * Anything else is a real failure. Returns whether a transaction was sent, so repeat runs are quiet.
 */
async function setCustodianRegistration(minting: any, method: 'addCustodianAddress' | 'removeCustodianAddress', address: string) {
  try {
    await minting[method].staticCall(address)
  } catch (e: any) {
    const data = e.data ?? e.error?.data ?? e.info?.error?.data
    const name = typeof data === 'string' ? minting.interface.parseError(data)?.name : undefined
    if (name === 'InvalidCustodianAddress' || /InvalidCustodianAddress/.test(e.shortMessage || e.message || '')) return false
    throw e
  }
  await confirmed(await minting[method](address))
  return true
}

if (require.main === module) checkNetwork().then(() => attachAssetGuard(loadRecord())).catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
