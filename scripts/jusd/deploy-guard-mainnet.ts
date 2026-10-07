import { ethers, network, run } from 'hardhat'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

/**
 * Deploys JUSDAssetGuard to Ethereum mainnet. One transaction leaves it fully configured: roles,
 * whitelist, cooldowns, Ondo multisig, cap, assets and feeds all come from the constructor, so
 * there is no window in which the contract exists half-set-up and no follow-up transaction to
 * forget. Roles and both cooldowns can never be changed afterwards.
 *
 * It deliberately does NOT touch AegisMintingJUSD. The guard is inert until someone calls
 * `addCustodianAddress(guard)` there — and optionally grants the guard COLLATERAL_MANAGER_ROLE so
 * it can draw collateral itself. Both are emitted as a Safe bundle at the end for you to fire when
 * you are ready, so deploying here commits nothing on the live protocol.
 *
 *   npx hardhat run scripts/jusd/deploy-guard-mainnet.ts --network mainnet
 *
 * Rehearse first against a mainnet fork:
 *   npx hardhat node --fork $MAINNET_RPC_URL     # terminal 1
 *   npx hardhat run scripts/jusd/deploy-guard-mainnet.ts --network localhost
 */

// ============================================================================
// CONFIGURATION — every value is checked before a single transaction is sent
// ============================================================================
const CONFIG = {
  // --- Constructor -----------------------------------------------------------
  mintingAddress: '0xBB0F32D176590faEdC7bc552b7EAD7A86809b520', // AegisMintingJUSD (mainnet)
  admin: '0x84fE172c15bb030BAA0dD497D30DD436c6b750E9',          // DEFAULT_ADMIN_ROLE; also the deployer
  initialDelay: 3 * 24 * 60 * 60,                               // 259200 — admin handover delay

  /**
   * IMMUTABLE. Seconds a newly whitelisted destination must wait before it can receive funds.
   * Cannot be changed after deployment — a wrong value means redeploying the guard.
   *
   * Three days: long enough that a compromised whitelist manager cannot add a destination and
   * drain to it before anyone reads the DestinationAdded event.
   */
  whitelistCooldown: (3 * 24 * 60 * 60) as number | null, // 259200

  /**
   * IMMUTABLE. Seconds between proposing and applying a new redemption sink. Same warning.
   *
   * Also three days, matching the whitelist cooldown and the admin handover delay, so every
   * privileged change on this contract gives the same window to react.
   */
  mintingChangeDelay: (3 * 24 * 60 * 60) as number | null, // 259200

  // Initial whitelist. Each destination receives ONLY the assets listed beside it.
  destinations: [
    {
      address: '0xf20de4ab8b2c45fceafc01c2baa134ef694ebacc',
      label: 'binance',
      assets: [
        '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
        '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      ],
    },
  ],

  /**
   * --- Roles on the guard ---------------------------------------------------
   * IMMUTABLE. Fixed in the constructor; grantRole and revokeRole always revert, and holders
   * cannot renounce. Rotation happens inside each Safe, never here. A wrong address means
   * redeploying the guard.
   */
  collateralManagers: ['0x4d19433297498E097e701ABc64a886942895CfCd'], // Safe 2/4 — moves assets
  whitelistManagers: ['0x4Fe78eF65BD8EDDED480efaB030BA680646503c8'], // Safe 3/5

  // --- Ondo leg --------------------------------------------------------------
  ondo: {
    /**
     * Safe 3/5 — mints USDY at Ondo. Note this is also the WHITELIST_MANAGER_ROLE holder, so the
     * account that sets maxOndoOutstanding is the same one holding the outstanding value. Chosen
     * deliberately; the cap is self-set rather than set by an independent party.
     */
    multisig: '0x4Fe78eF65BD8EDDED480efaB030BA680646503c8',
    maxOutstandingUsd: '1000000', // whole USD; scaled to 18 dp below

    /**
     * Ondo's USDY oracle is not Chainlink-shaped — it exposes getPrice()/getPriceData() with no
     * rounds and no decimals getter. OndoPriceFeedAdapter wraps it into AggregatorV3Interface so
     * the guard keeps one validated price path. Set `deployAdapter` false and supply `feed`
     * directly if a real Chainlink USDY feed exists by deploy time.
     */
    usdy: {
      token: '0x96F6eF951840721AdBF46Ac996b59E0235CB985C',
      oracle: '0xA0219AA5B31e65Bc920B5b6DFb8EdF0988121De0',
      deployAdapter: true,
      feed: null as string | null,
      // Ondo republishes monthly, so 30 days would revert on any late update and shut the leg.
      // 35 days leaves five days of grace while still catching an abandoned oracle. Unlike the
      // two cooldowns this is NOT immutable — the whitelist manager can retune it via setPriceFeed.
      heartbeat: 35 * 24 * 60 * 60 as number | null, // 3,024,000
    },

    /**
     * Assets that may be SENT to the Ondo multisig. Each needs a feed before it can be registered.
     * Chainlink mainnet: USDC/USD 0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6 (8 dp),
     *                    USDT/USD 0x3E7d1eAB13ad0104d2750B8863b489D65364e32D (8 dp).
     * Note USDC/USD updates slowly — it was 21h old at authoring, so a 24h heartbeat is tight.
     */
    assets: [
      {
        symbol: 'USDC',
        token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        feed: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6', // Chainlink USDC/USD, 8 dp
        // Chainlink's own heartbeat is 86400 and the feed was 21h old at authoring, which leaves
        // about three hours of margin. 25h avoids reverting on a feed that is merely late.
        heartbeat: 90000,
      },
    ] as { symbol: string, token: string, feed: string, heartbeat: number }[],
  },

  // --- Mechanics -------------------------------------------------------------
  maxGasPriceGwei: 1.75 as number | null, // refuse to deploy above this
  verify: true,

  /**
   * DEFAULT_ADMIN_ROLE now holds no power over the guard: it cannot move assets, pause, set a
   * limit, change the sink, or touch a role. It exists only because AccessControlDefaultAdminRules
   * demands an admin.
   *
   * Handing it to the Safe is therefore cosmetic. The meaningful option is to retire it: schedule
   * a transfer to the zero address, wait `initialDelay`, then renounce — leaving a guard nobody
   * administers. Set to the zero address to start that, an address to hand over, or null for
   * neither.
   */
  adminHandoverTo: ethers.ZeroAddress as string | null,
}
// ============================================================================

const recordPath = resolve(process.env.GUARD_RECORD || `deployments/${network.name}/JUSDAssetGuard.json`)

/** Constructor args carry BigInts (the Ondo cap) and addresses as objects, so serialize both. */
const jsonSafe = (_key: string, value: any) =>
  typeof value === 'bigint' ? value.toString() : value

function save(record: any) {
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record, jsonSafe, 2) + '\n')
}
async function confirmed(tx: any) {
  const receipt = await tx.wait(1)
  if (receipt?.status !== 1) throw new Error(`Transaction failed: ${tx.hash}`)
  return receipt
}
const isLocal = network.name === 'hardhat' || network.name === 'localhost'

/** Every check that can fail runs before the first transaction, so a bad value costs no gas. */
async function preflight(deployer: any) {
  const c = CONFIG
  const problems: string[] = []

  for (const [name, value] of [
    ['whitelistCooldown', c.whitelistCooldown],
    ['mintingChangeDelay', c.mintingChangeDelay],
    ['maxGasPriceGwei', c.maxGasPriceGwei],
  ] as const) {
    if (value === null) problems.push(`CONFIG.${name} is not set (it has no safe default)`)
  }
  if (c.ondo.multisig && c.ondo.assets.length === 0) {
    problems.push('CONFIG.ondo.assets is empty — nothing could be sent to the multisig')
  }
  if (c.ondo.usdy.heartbeat === null) problems.push('CONFIG.ondo.usdy.heartbeat is not set')
  if (c.collateralManagers.length === 0) problems.push('CONFIG.collateralManagers is empty — the guard could never move an asset, and the role cannot be granted later')
  if (c.whitelistManagers.length === 0) problems.push('CONFIG.whitelistManagers is empty — the guard could never be paused, and the role cannot be granted later')
  for (const m of c.collateralManagers) {
    if (m.toLowerCase() === c.ondo.multisig.toLowerCase()) {
      problems.push(`collateral manager ${m} is also the Ondo multisig — it would authorise sends to itself`)
    }
  }
  if (!c.ondo.usdy.deployAdapter && !c.ondo.usdy.feed) {
    problems.push('CONFIG.ondo.usdy.feed must be set when deployAdapter is false')
  }

  for (const d of c.destinations) {
    if (d.assets.length === 0) problems.push(`destination ${d.label} has no assets and could receive nothing`)
    if (d.address.toLowerCase() === c.mintingAddress.toLowerCase()) problems.push(`destination ${d.label} is the minting address`)
    if (c.ondo.multisig && d.address.toLowerCase() === c.ondo.multisig.toLowerCase()) {
      problems.push(`destination ${d.label} is the Ondo multisig — the two sets must stay disjoint`)
    }
  }

  const code = await ethers.provider.getCode(c.mintingAddress)
  if (code === '0x') problems.push(`mintingAddress ${c.mintingAddress} has no code`)

  if (!isLocal && deployer.address.toLowerCase() !== c.admin.toLowerCase()) {
    problems.push(`deployer ${deployer.address} is not the configured admin ${c.admin}`)
  }

  /*
   * What matters for cost is the price we SEND at, not what the network is charging. Hardhat pins
   * `gasPrice` for this network, so that pinned value is the real spend; the cap is checked
   * against it. A network above that price does not overspend — it just means the transactions sit
   * in the mempool until the base fee comes down, which is a deliberate way to deploy cheaply.
   */
  const fee = await ethers.provider.getFeeData()
  const networkGwei = Number(fee.gasPrice ?? 0n) / 1e9
  const configured = (network.config as any).gasPrice
  const sendGwei = typeof configured === 'number' && configured > 0 ? configured / 1e9 : networkGwei

  if (!isLocal && c.maxGasPriceGwei !== null && sendGwei > c.maxGasPriceGwei) {
    problems.push(`would send at ${sendGwei.toFixed(3)} gwei, above the ${c.maxGasPriceGwei} gwei cap`)
  }

  // ~3.22M gas measured on a mainnet fork; budget 4M so a mid-deploy shortfall is caught up front.
  const GAS_BUDGET = 4_000_000n
  const needed = GAS_BUDGET * BigInt(Math.ceil(sendGwei * 1e9))
  const balance = await ethers.provider.getBalance(deployer.address)
  if (!isLocal && balance < needed) {
    problems.push(`balance ${ethers.formatEther(balance)} ETH is under the ${ethers.formatEther(needed)} ETH budget at ${sendGwei.toFixed(3)} gwei`)
  }

  if (!isLocal && networkGwei > sendGwei) {
    console.log(`note: network is at ${networkGwei.toFixed(2)} gwei but sending at ${sendGwei.toFixed(3)} gwei — transactions will pend until the base fee falls`)
  }

  // A feed that cannot answer now would brick the Ondo leg the moment it is used.
  for (const a of c.ondo.assets) {
    try {
      // Fully qualified: three AggregatorV3Interface artifacts exist in this project.
      const feed = await ethers.getContractAt('contracts/AegisVault/interfaces/AggregatorV3Interface.sol:AggregatorV3Interface', a.feed)
      const [, answer, , updatedAt] = await feed.latestRoundData()
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt)
      if (answer <= 0n) problems.push(`${a.symbol} feed returned a non-positive answer`)
      if (age > a.heartbeat) problems.push(`${a.symbol} feed is ${age}s old, past its ${a.heartbeat}s heartbeat`)
    } catch (e: any) {
      problems.push(`${a.symbol} feed ${a.feed} did not answer: ${e.shortMessage || e.message}`)
    }
  }

  if (problems.length) {
    throw new Error(`Preflight failed:\n  - ${problems.join('\n  - ')}`)
  }
  console.log(`preflight ok — sending at ${sendGwei.toFixed(3)} gwei (network ${networkGwei.toFixed(2)}), balance ${ethers.formatEther(balance)} ETH, deployer ${deployer.address}`)
}

async function main() {
  const c = CONFIG
  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  const deployer = isLocal
    ? await ethers.getImpersonatedSigner(c.admin).then(async s => {
        await network.provider.send('hardhat_setBalance', [c.admin, '0x3635C9ADC5DEA00000'])
        return s
      })
    : (await ethers.getSigners())[0]

  await preflight(deployer)

  const record: any = existsSync(recordPath)
    ? JSON.parse(readFileSync(recordPath, 'utf8'))
    : { version: 1, chainId, config: c, contracts: {}, steps: {}, status: 'deploying' }
  const a = record.contracts
  const balanceBefore = await ethers.provider.getBalance(deployer.address)

  async function deploy(key: string, contract: string, args: any[]) {
    if (a[key]) {
      if (a[key].pending) {
        const receipt = await ethers.provider.waitForTransaction(a[key].transactionHash, 1, 300000)
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

  async function step(name: string, run: () => Promise<any>) {
    if (record.steps[name]) return
    const tx = await run()
    if (tx) await confirmed(tx)
    record.steps[name] = new Date().toISOString()
    save(record)
    console.log(`  ${name}`)
  }

  // ── 1. USDY price feed ────────────────────────────────────────────────────
  let usdyFeed = c.ondo.usdy.feed
  if (c.ondo.usdy.deployAdapter) {
    const adapter = await deploy('ondoPriceFeedAdapter', 'OndoPriceFeedAdapter', [c.ondo.usdy.oracle, 'USDY / USD (Ondo)'])
    usdyFeed = await adapter.getAddress()
    const [, answer] = await adapter.latestRoundData()
    console.log(`  adapter reports USDY at $${(Number(answer) / 1e18).toFixed(6)}`)
  }

  // ── 2. The guard ──────────────────────────────────────────────────────────
  const ondoAssetConfigs = [
    { token: c.ondo.usdy.token, feed: usdyFeed!, heartbeat: c.ondo.usdy.heartbeat! },
    ...c.ondo.assets.map(a => ({ token: a.token, feed: a.feed, heartbeat: a.heartbeat })),
  ]
  const guardArgs = [
    c.mintingAddress,
    c.admin,
    c.initialDelay,
    c.destinations.map(d => d.address),
    c.destinations.map(d => d.label),
    c.destinations.map(d => d.assets),
    c.whitelistCooldown,
    c.mintingChangeDelay,
    c.collateralManagers,
    c.whitelistManagers,
    c.ondo.multisig,
    ethers.parseEther(c.ondo.maxOutstandingUsd),
    ondoAssetConfigs,
  ]
  const guard = await deploy('jusdAssetGuard', 'JUSDAssetGuard', guardArgs)

  // ── 3. Roles — set by the constructor, so only verify ─────────────────────
  const COLLATERAL_MANAGER_ROLE = ethers.id('COLLATERAL_MANAGER_ROLE')
  const WHITELIST_MANAGER_ROLE = ethers.id('WHITELIST_MANAGER_ROLE')

  for (const [name, role, holders] of [
    ['COLLATERAL_MANAGER_ROLE', COLLATERAL_MANAGER_ROLE, c.collateralManagers],
    ['WHITELIST_MANAGER_ROLE', WHITELIST_MANAGER_ROLE, c.whitelistManagers],
  ] as const) {
    for (const holder of holders) {
      if (!await guard.hasRole(role, holder)) throw new Error(`${name} missing on ${holder} — roles are immutable, redeploy`)
      console.log(`  ${name} ${holder}`)
    }
  }

  // ── 4. Ondo leg — set by the constructor, so only verify ──────────────────
  for (const asset of ondoAssetConfigs) {
    if (!await guard.isOndoAsset(asset.token)) throw new Error(`Ondo asset missing: ${asset.token}`)
    if (await guard.priceFeed(asset.token) !== asset.feed) throw new Error(`Ondo feed wrong: ${asset.token}`)
  }
  if (await guard.ondoMultisig() !== c.ondo.multisig) throw new Error('Ondo multisig not set')
  if (await guard.maxOndoOutstanding() !== ethers.parseEther(c.ondo.maxOutstandingUsd)) throw new Error('Ondo cap not set')
  console.log(`  ondo leg open: multisig ${c.ondo.multisig}, cap $${c.ondo.maxOutstandingUsd}, ${ondoAssetConfigs.length} assets`)

  // ── 5. Retire or hand over the (powerless) admin ──────────────────────────
  if (c.adminHandoverTo !== null) {
    const target = c.adminHandoverTo
    await step(`beginDefaultAdminTransfer.${target}`, async () => {
      // The schedule, not the address, says whether a transfer is pending: retiring the admin
      // targets the zero address, which is also the value pendingDefaultAdmin starts at. Checking
      // the address alone would read "already done" and silently skip the call.
      const [pending, schedule] = await guard.pendingDefaultAdmin()
      const alreadyScheduled = schedule !== 0n && pending.toLowerCase() === target.toLowerCase()
      return alreadyScheduled ? null : guard.beginDefaultAdminTransfer(target)
    })
    const [pending, schedule] = await guard.pendingDefaultAdmin()
    const when = new Date(Number(schedule) * 1000).toISOString()
    console.log(target === ethers.ZeroAddress
      ? `  admin retirement scheduled — after ${when}, call renounceRole(DEFAULT_ADMIN_ROLE, deployer)`
      : `  admin handover to ${pending} acceptable from ${when}`)
  }

  record.status = 'ready'
  record.deployedAt = record.deployedAt || new Date().toISOString()
  save(record)

  // ── 6. The wiring we deliberately did NOT do ──────────────────────────────
  const minting = await ethers.getContractAt('AegisMintingJUSD', c.mintingAddress)
  const bundle = {
    version: '1.0',
    chainId,
    meta: { name: 'Register JUSDAssetGuard with AegisMintingJUSD', createdFromSafeAddress: await minting.defaultAdmin() },
    transactions: [
      {
        to: c.mintingAddress,
        value: '0',
        data: minting.interface.encodeFunctionData('addCustodianAddress', [await guard.getAddress()]),
        description: 'Register the guard as a custodian so collateral can be transferred to it',
      },
      {
        to: c.mintingAddress,
        value: '0',
        data: minting.interface.encodeFunctionData('grantRole', [COLLATERAL_MANAGER_ROLE, await guard.getAddress()]),
        description: 'OPTIONAL — lets the guard draw collateral itself via pullFromMinting',
      },
    ],
  }
  const bundlePath = resolve(`scripts/jusd/multisig-register-jusd-asset-guard.json`)
  writeFileSync(bundlePath, JSON.stringify(bundle, jsonSafe, 2) + '\n')

  const spent = balanceBefore - await ethers.provider.getBalance(deployer.address)
  console.log(`\nDeployed — spent ${ethers.formatEther(spent)} ETH`)
  console.log(`  guard  : ${await guard.getAddress()}`)
  if (c.ondo.usdy.deployAdapter) console.log(`  adapter: ${usdyFeed}`)
  console.log(`\nNOT wired into AegisMintingJUSD — the guard is inert until this bundle runs:`)
  console.log(`  ${bundlePath}  (execute from ${await (await ethers.getContractAt('AegisMintingJUSD', c.mintingAddress)).defaultAdmin()})`)
  console.log(`Record: ${recordPath}`)

  if (c.verify && !isLocal) {
    for (const [key, entry] of Object.entries(a) as [string, any][]) {
      try {
        await run('verify:verify', { address: entry.address, constructorArguments: entry.args })
        console.log(`verified ${key}`)
      } catch (e: any) {
        const m = (e.shortMessage || e.message || '').replace(/\s+/g, ' ')
        console.log(/already verified/i.test(m) ? `already verified ${key}` : `verify inconclusive ${key} — ${m.slice(0, 120)}`)
      }
    }
  }
}

main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
