import { ethers, network } from 'hardhat'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

/**
 * Fresh JUSD stack with a JUSDAssetGuard in place of a custody wallet, plus a mock USD collateral
 * the admin can mint on demand. Testnet only: USDTest has no backing.
 *
 * Every deployment and wiring step is checkpointed to the record file, so a run that dies midway
 * resumes instead of redeploying. Re-running a finished deployment is a no-op.
 *
 *   npx hardhat run scripts/jusd/deploy-jusd-stack.ts --network sepolia
 */
const ADMIN = '0x84fE172c15bb030BAA0dD497D30DD436c6b750E9'
const COOLDOWN = 60                 // whitelist cooldown and minting-change delay, in seconds
const ASSET_HEARTBEAT = 86400
const INITIAL_JUSD_PRICE = 100_000_000  // 1.00 at 8 decimals

const recordPath = resolve(process.env.JUSD_RECORD || `deployments/${network.name}/JUSDStack.json`)

/// In-memory chain or a local node: no admin key exists, so the account is impersonated instead.
const isLocal = network.name === 'hardhat' || network.name === 'localhost'

function save(record: any) {
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
}
async function confirmed(tx: any) {
  const receipt = await tx.wait(1)
  if (receipt?.status !== 1) throw new Error(`Transaction failed: ${tx.hash}`)
  return receipt
}

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

/// The admin signs every step, so on a live network the deployer must be that wallet.
async function adminSigner() {
  if (isLocal) return localAdminSigner(ADMIN)
  const [deployer] = await ethers.getSigners()
  if (deployer.address.toLowerCase() !== ADMIN.toLowerCase()) {
    throw new Error(`Deployer must be the configured admin ${ADMIN}, got ${deployer.address}`)
  }
  return deployer
}

async function main() {
  const deployer = await adminSigner()
  const chainId = Number((await ethers.provider.getNetwork()).chainId)

  const record: any = existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : { version: 1, chainId, admin: ADMIN, cooldown: COOLDOWN, contracts: {}, steps: {}, status: 'deploying' }
  if (record.chainId !== chainId) throw new Error(`Record is for chain ${record.chainId}, connected to ${chainId}`)
  const a = record.contracts

  const balance = await ethers.provider.getBalance(deployer.address)
  console.log(`deployer ${deployer.address} — ${ethers.formatEther(balance)} ETH on chain ${chainId}`)

  async function deploy(key: string, contract: string, args: any[]) {
    if (a[key]) {
      if (a[key].pending) {
        const receipt = await ethers.provider.waitForTransaction(a[key].transactionHash, 1, 180000)
        if (receipt?.status !== 1) throw new Error(`Pending deployment did not succeed: ${key}`)
        delete a[key].pending
        save(record)
      }
      if (await ethers.provider.getCode(a[key].address) === '0x') throw new Error(`Missing code: ${key}`)
      return ethers.getContractAt(contract, a[key].address, deployer) as Promise<any>
    }
    const instance: any = await ethers.deployContract(contract, args, deployer)
    a[key] = { address: await instance.getAddress(), contract, args, transactionHash: instance.deploymentTransaction().hash, pending: true }
    save(record)
    console.log(`  submitted ${key}: ${a[key].transactionHash}`)
    await instance.waitForDeployment()
    delete a[key].pending
    save(record)
    console.log(`${key}: ${a[key].address}`)
    return instance
  }

  // Each wiring call runs once; the record remembers which already landed.
  async function step(name: string, run: () => Promise<any>) {
    if (record.steps[name]) return
    const tx = await run()
    if (tx) await confirmed(tx)
    record.steps[name] = new Date().toISOString()
    save(record)
    console.log(`  ${name}`)
  }

  const z = ethers.ZeroAddress

  // ── Contracts ─────────────────────────────────────────────────────────────
  const usdTest = await deploy('usdTest', 'USDTest', [ADMIN])
  const jusd = await deploy('jusd', 'JUSD', [ADMIN])
  const config = await deploy('aegisConfig', 'AegisConfig', [ADMIN, [ADMIN], ADMIN])
  const oracle = await deploy('aegisOracleJUSD', 'AegisOracleJUSD', [[ADMIN], ADMIN])
  const rewards = await deploy('aegisRewards', 'AegisRewards', [jusd.target, config.target, ADMIN])
  const minting = await deploy('aegisMintingJUSD', 'AegisMintingJUSD', [
    jusd.target, config.target, rewards.target, oracle.target, z, ADMIN,
    [usdTest.target], [ASSET_HEARTBEAT], [ADMIN], ADMIN,
  ])
  // Destinations are seeded empty: the guard refuses a destination that equals its own minting
  // address only, but the admin is added afterwards so its 60s cooldown starts from a known block.
  // Roles and the whole Ondo leg are constructor-only now. Sepolia seeds the admin as both role
  // holder and sole destination; the Ondo leg stays closed (zero multisig, zero cap, no assets).
  const guard = await deploy('jusdAssetGuard', 'JUSDAssetGuard', [
    minting.target, ADMIN, COOLDOWN,
    [ADMIN], ['Admin wallet'], [[usdTest.target]],
    COOLDOWN, COOLDOWN,
    [ADMIN], [ADMIN],
    z, 0, [],
  ])

  // ── Wiring ────────────────────────────────────────────────────────────────
  const COLLATERAL_MANAGER_ROLE = ethers.id('COLLATERAL_MANAGER_ROLE')
  const WHITELIST_MANAGER_ROLE = ethers.id('WHITELIST_MANAGER_ROLE')
  const SETTINGS_MANAGER_ROLE = ethers.id('SETTINGS_MANAGER_ROLE')
  const FUNDS_MANAGER_ROLE = ethers.id('FUNDS_MANAGER_ROLE')
  const REWARDS_MANAGER_ROLE = ethers.id('REWARDS_MANAGER_ROLE')

  await step('jusd.setMinter', async () =>
    await jusd.minter() === minting.target ? null : jusd.setMinter(minting.target))
  await step('rewards.setAegisMintingAddress', () => rewards.setAegisMintingAddress(minting.target))
  await step('oracle.updateJUSDPrice', async () =>
    await oracle.jusdUSDPrice() > 0n ? null : oracle.updateJUSDPrice(INITIAL_JUSD_PRICE))

  for (const role of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE'] as const) {
    await step(`minting.grantRole.${role}`, async () =>
      await minting.hasRole(ethers.id(role), ADMIN) ? null : minting.grantRole(ethers.id(role), ADMIN))
  }
  await step('rewards.grantRole.REWARDS_MANAGER_ROLE', async () =>
    await rewards.hasRole(REWARDS_MANAGER_ROLE, ADMIN) ? null : rewards.grantRole(REWARDS_MANAGER_ROLE, ADMIN))

  // The admin mints and redeems through the UI, so it must pass the config whitelist.
  await step('config.whitelistAdmin', async () =>
    await config.isWhitelisted(ADMIN) ? null : config['whitelistAddress(address,bool)'](ADMIN, true))

  // The guard replaces the custody wallet: registered as a custodian, and able to draw collateral.
  await step('minting.addCustodianAddress.guard', () => minting.addCustodianAddress(guard.target))
  await step('minting.grantRole.COLLATERAL_MANAGER_ROLE.guard', async () =>
    await minting.hasRole(COLLATERAL_MANAGER_ROLE, guard.target) ? null : minting.grantRole(COLLATERAL_MANAGER_ROLE, guard.target))



  record.status = 'ready'
  record.deployedAt = record.deployedAt || new Date().toISOString()
  save(record)

  const spent = balance - await ethers.provider.getBalance(deployer.address)
  console.log(`\nDeployment ready — spent ${ethers.formatEther(spent)} ETH`)
  console.log(JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]: any) => [k, v.address])), null, 2))
  console.log(`Saved ${recordPath}`)
}

main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
