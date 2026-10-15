import { ethers, network, run } from 'hardhat'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

/**
 * Deploys JUSDAssetGuard on Sepolia and configures it idempotently: grants the guard's two manager
 * roles, installs the initial whitelist, optionally wires the guard into AegisMintingJUSD (custodian
 * registration + draw role), and verifies on Etherscan. The Ondo leg is left closed — open it later
 * from the Manage JUSD tab (setPriceFeed -> setOndoAsset -> setOndoMultisig -> setMaxOndoOutstanding).
 *
 * Config:  config/JUSDGuard/sepolia.json   (override with JUSD_GUARD_CONFIG)
 * Record:  deployments/<network>/JUSDAssetGuard.<id>.json  (override with JUSD_GUARD_RECORD)
 *
 * Run:  npx hardhat run scripts/jusd/deploy-jusd-asset-guard.ts --network sepolia
 */

const configPath = resolve(process.env.JUSD_GUARD_CONFIG || 'config/JUSDGuard/sepolia.json')
const c = JSON.parse(readFileSync(configPath, 'utf8'))
const recordPath = resolve(process.env.JUSD_GUARD_RECORD || `deployments/${network.name}/JUSDAssetGuard.${c.id}.json`)

// Fully-qualified name disambiguates verification; the short name is enough for ethers.
const VERIFY_CONTRACT = 'contracts/JUSDAssetGuard.sol:JUSDAssetGuard'
const COLLATERAL_MANAGER_ROLE = ethers.id('COLLATERAL_MANAGER_ROLE')
const WHITELIST_MANAGER_ROLE = ethers.id('WHITELIST_MANAGER_ROLE')

// Minimal AegisMintingJUSD surface needed to wire the guard in.
const MINTING_ABI = [
  'function addCustodianAddress(address)',
  'function grantRole(bytes32,address)',
  'function hasRole(bytes32,address) view returns (bool)',
]

function loadRecord(): any {
  return existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : { version: 1, chainId: c.chainId, config: c, contracts: {}, status: 'deploying' }
}
function saveRecord(r: any) {
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(r, null, 2) + '\n')
}
async function confirmed(tx: any) {
  const receipt = await tx.wait(1)
  if (receipt?.status !== 1) throw new Error('Transaction failed')
  return receipt
}

async function main() {
  const chain = Number((await ethers.provider.getNetwork()).chainId)
  if (chain !== c.chainId) throw new Error(`Expected chain ${c.chainId}, got ${chain}`)

  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error('Missing deployer — set PRIVATE_KEY in .env')
  // The deployer ends up as DEFAULT_ADMIN_ROLE holder, so it must be the configured admin.
  if (deployer.address.toLowerCase() !== c.admin.toLowerCase()) {
    throw new Error(`Deployer ${deployer.address} must equal configured admin ${c.admin}`)
  }

  // The sink must be a deployed contract; the constructor enforces it too, this just fails earlier.
  if (await ethers.provider.getCode(c.mintingAddress) === '0x') {
    throw new Error(`mintingAddress ${c.mintingAddress} has no code on chain ${chain}`)
  }
  if (c.destinations.length !== c.labels.length || c.destinations.length !== c.assets.length) {
    throw new Error('destinations / labels / assets must have equal length')
  }

  const record: any = loadRecord()
  if (JSON.stringify(record.config) !== JSON.stringify(c)) {
    throw new Error('Config differs from the saved deployment record — revert the config or start a fresh record')
  }

  // ---- Deploy (idempotent) ----
  const args = [
    c.mintingAddress,
    c.admin,
    c.initialDelay,
    c.destinations,
    c.labels,
    c.assets,
    c.whitelistCooldown,
    c.mintingChangeDelay,
  ]

  let guard: any
  if (record.contracts.guard && await ethers.provider.getCode(record.contracts.guard.address) !== '0x') {
    guard = await ethers.getContractAt('JUSDAssetGuard', record.contracts.guard.address)
    console.log(`reusing guard: ${record.contracts.guard.address}`)
  } else {
    guard = await ethers.deployContract('JUSDAssetGuard', args)
    console.log(`submitted guard: ${guard.deploymentTransaction()?.hash}`)
    await guard.waitForDeployment()
    record.contracts.guard = {
      address: await guard.getAddress(),
      contract: 'JUSDAssetGuard',
      args,
      transactionHash: guard.deploymentTransaction()?.hash,
    }
    saveRecord(record)
    console.log(`guard: ${record.contracts.guard.address}`)
  }

  // ---- Roles on the guard (admin already holds DEFAULT_ADMIN_ROLE from the constructor) ----
  for (const [role, holder, name] of [
    [COLLATERAL_MANAGER_ROLE, c.collateralManager, 'COLLATERAL_MANAGER_ROLE'],
    [WHITELIST_MANAGER_ROLE, c.whitelistManager, 'WHITELIST_MANAGER_ROLE'],
  ] as const) {
    if (!await guard.hasRole(role, holder)) {
      await confirmed(await guard.grantRole(role, holder))
      console.log(`granted ${name} -> ${holder}`)
    }
  }

  // ---- Initial whitelist (empty by default) ----
  for (let i = 0; i < c.destinations.length; i++) {
    if (!await guard.isDestination(c.destinations[i])) {
      await confirmed(await guard.addDestination(c.destinations[i], c.labels[i], c.assets[i]))
      console.log(`whitelisted ${c.labels[i] || c.destinations[i]}`)
    }
  }

  // ---- Wire into AegisMintingJUSD (needs admin/role on minting; probed, never fatal) ----
  if (c.registerCustodian || c.grantDrawRole) {
    const minting = new ethers.Contract(c.mintingAddress, MINTING_ABI, deployer)
    if (c.registerCustodian) {
      try {
        // Re-adding an existing custodian reverts; a static probe keeps repeat runs quiet.
        await minting.addCustodianAddress.staticCall(guard.target)
        await confirmed(await minting.addCustodianAddress(guard.target))
        console.log('registered guard as custodian in minting')
      } catch (e: any) {
        console.warn(`skip addCustodianAddress (already set or no permission): ${e.shortMessage || e.message}`)
      }
    }
    if (c.grantDrawRole) {
      try {
        if (!await minting.hasRole(COLLATERAL_MANAGER_ROLE, guard.target)) {
          await confirmed(await minting.grantRole(COLLATERAL_MANAGER_ROLE, guard.target))
          console.log('granted COLLATERAL_MANAGER_ROLE to guard on minting')
        }
      } catch (e: any) {
        console.warn(`skip grantRole on minting (no permission?): ${e.shortMessage || e.message}`)
      }
    }
  }

  // ---- Verify on Etherscan ----
  try {
    await run('verify:verify', {
      address: record.contracts.guard.address,
      contract: VERIFY_CONTRACT,
      constructorArguments: args,
    })
    record.contracts.guard.verified = true
    console.log('etherscan: verified')
  } catch (e: any) {
    if (/already verified/i.test(e.message)) {
      record.contracts.guard.verified = true
      console.log('etherscan: already verified')
    } else {
      console.error(`etherscan verification failed: ${e.message}`)
    }
  }

  record.status = 'ready'
  record.deployedAt = new Date().toISOString()
  saveRecord(record)
  console.log(`saved ${recordPath}`)
}

main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
