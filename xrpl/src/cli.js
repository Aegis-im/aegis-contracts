import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { Wallet, isValidClassicAddress } from 'xrpl'
import { Store } from './store.js'
import {
  Ledger,
  RLUSD,
  YUSD_CURRENCY,
  MOCK_CURRENCY,
  TESTNET_URL,
  issuerTransaction,
  trustTransaction,
  submitJournaled,
  resultCode,
  assertDelivered,
} from './ledger.js'
import { runOnce, retryMint, mintedUnits } from './minter.js'
import { units, decimal, positive } from './amounts.js'
import { holderSnapshot } from './holders.js'

const HELP = `Aegis YUSD — XRPL Testnet only
  npm run setup                       Provision issuer and collateral receiver
  node src/cli.js onboard              Fund demo user, create trust lines, allow minting
  node src/cli.js allow ADDRESS        Allow an external classic address to mint
  node src/cli.js disallow ADDRESS     Stop new mints for an address
  node src/cli.js faucet               Request official Testnet RLUSD for demo user
  node src/cli.js deposit AMOUNT --id ID  Send demo user's RLUSD; ID makes reruns safe
  npm run worker -- --once             Replay deposits and reconcile/mint once
  npm run worker                      Poll validated account history every 5 seconds
  node src/cli.js pause|resume          Control new issuance
  node src/cli.js retry DEPOSIT_HASH    Retry a definitively failed/expired mint
  npm run status                      Public addresses, balances and deposit states
  npm run holders                     Current YUSD holders and balances (read-only)
  npm run holders -- --issuer ADDRESS  Query a public YUSD issuer without local keys/state
  npm run demo                        Setup, onboard, mint 1 RLUSD, assert replay safety
  npm run demo -- --mock               Isolated live demo backed by a local MRLUSD test token

State: xrpl/.local/testnet (or testnet-mock with --mock; override with XRPL_STATE_DIR).
Pass --mock to every command for that isolated deployment. Never delete a live journal.
Mint: 1 RLUSD = 1 YUSD, zero fee, destination tag 1, six decimals, cap 1,000,000 YUSD.
Redemption, custody/strategy execution, credentials and production signing are deferred.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    once: { type: 'boolean' },
    mock: { type: 'boolean' },
    id: { type: 'string' },
    issuer: { type: 'string' },
    help: { type: 'boolean' },
  },
})
const [command, ...args] = positionals
const mode = values.mock ? 'mock' : 'rlusd'
const directory =
  process.env.XRPL_STATE_DIR ||
  fileURLToPath(new URL(values.mock ? '../.local/testnet-mock' : '../.local/testnet', import.meta.url))

function address(seed) {
  return Wallet.fromSeed(seed).classicAddress
}
function requireState(store) {
  const state = store.state
  if (!state || !store.keys) throw new Error('Run npm run setup first')
  if ((state.collateralMode || 'rlusd') !== mode)
    throw new Error('State/key identity mismatch: wrong collateral mode; refusing to sign')
  const collateral = mode === 'mock' ? { currency: MOCK_CURRENCY, issuer: address(store.keys.mockCollateral) } : RLUSD
  if (
    (state.collateralMode || 'rlusd') !== mode ||
    state.version !== 1 ||
    state.network !== 'testnet' ||
    state.url !== TESTNET_URL ||
    state.collateral.currency !== collateral.currency ||
    state.collateral.issuer !== collateral.issuer ||
    state.yusd.currency !== YUSD_CURRENCY ||
    state.yusd.issuer !== state.issuer ||
    state.issuer !== address(store.keys.issuer) ||
    state.market !== address(store.keys.market)
  )
    throw new Error('State/key identity mismatch; refusing to sign')
  if (
    !Number.isSafeInteger(state.cursor) ||
    !Number.isSafeInteger(state.mintTag) ||
    state.mintTag !== 1 ||
    positive(state.supplyCap) !== '1000000'
  )
    throw new Error('Unexpected state policy or cursor')
}

async function operation(store, ledger, name, tx, seed) {
  // Setup transactions are repeatable; only replace a signature with a proven terminal failure.
  let number = 0
  while (true) {
    const key = `setup:${name}:${number}`
    const prior = store.state.operations[key]
    if (!prior || prior.status === 'signed' || resultCode(prior.result) === 'tesSUCCESS') {
      const result = await submitJournaled(store, ledger, key, tx, seed)
      if (result.status !== 'validated' || resultCode(result.result) !== 'tesSUCCESS')
        throw new Error(`${name} failed: ${resultCode(result.result) || result.status}; rerun to retry`)
      return result
    }
    number += 1
  }
}

async function setup(store, ledger) {
  if (!store.state) {
    if (store.keys)
      throw new Error('Keys exist without their journal. Restore state.json; do not reinitialize these accounts')
    store.keys = { issuer: Wallet.generate().seed, market: Wallet.generate().seed, user: Wallet.generate().seed }
    if (mode === 'mock') store.keys.mockCollateral = Wallet.generate().seed
    // Persist keys before funding any account. Never log a seed.
    store.saveKeys()
    const issuer = address(store.keys.issuer)
    store.state = {
      version: 1,
      network: 'testnet',
      url: TESTNET_URL,
      issuer,
      market: address(store.keys.market),
      yusd: { currency: YUSD_CURRENCY, issuer },
      collateralMode: mode,
      collateral:
        mode === 'mock' ? { currency: MOCK_CURRENCY, issuer: address(store.keys.mockCollateral) } : { ...RLUSD },
      mintTag: 1,
      supplyCap: '1000000',
      cursor: await ledger.index(),
      ready: false,
      paused: false,
      allowlist: [],
      operations: {},
      deposits: {},
      requests: {},
    }
    store.save()
  }
  requireState(store)
  await ledger.fund(store.keys.issuer)
  await ledger.fund(store.keys.market)
  if (mode === 'mock') {
    await ledger.fund(store.keys.mockCollateral)
    await operation(
      store,
      ledger,
      'mock-default-ripple',
      issuerTransaction(store.state.collateral.issuer),
      store.keys.mockCollateral,
    )
  }
  await operation(store, ledger, 'issuer-default-ripple', issuerTransaction(store.state.issuer), store.keys.issuer)
  await operation(
    store,
    ledger,
    'market-collateral-line',
    trustTransaction(store.state.market, store.state.collateral),
    store.keys.market,
  )
  store.state.ready = true
  store.save()
  console.log(
    JSON.stringify({
      network: 'testnet',
      collateralMode: mode,
      issuer: store.state.issuer,
      market: store.state.market,
      currency: YUSD_CURRENCY,
      collateral: store.state.collateral,
      mintDestinationTag: 1,
    }),
  )
}

async function onboard(store, ledger) {
  const user = address(store.keys.user)
  await ledger.fund(store.keys.user)
  await operation(
    store,
    ledger,
    'user-collateral-line',
    trustTransaction(user, store.state.collateral),
    store.keys.user,
  )
  await operation(store, ledger, 'user-yusd-line', trustTransaction(user, store.state.yusd), store.keys.user)
  if (!store.state.allowlist.includes(user)) store.state.allowlist.push(user)
  store.save()
  console.log(JSON.stringify({ demoUser: user, trustLinesReady: true, allowlisted: true }))
}

async function faucet(store, ledger) {
  const user = address(store.keys.user)
  if (mode === 'mock') {
    const number = store.state.mockFaucetCount || 0
    const tx = {
      TransactionType: 'Payment',
      Account: store.state.collateral.issuer,
      Destination: user,
      Amount: { ...store.state.collateral, value: '100' },
    }
    const result = await operation(store, ledger, `mock-user-funding:${number}`, tx, store.keys.mockCollateral)
    assertDelivered(result.result, store.state.collateral, '100')
    store.state.mockFaucetCount = number + 1
    store.save()
    console.log(JSON.stringify({ collateralMode: 'mock', amount: '100', faucetTransaction: result.hash }))
    return
  }
  if (!(await ledger.line(user, RLUSD))) throw new Error('Run onboard before requesting RLUSD')
  // Public endpoint used by the official faucet linked in Ripple's documentation.
  const response = await fetch('https://tryrlusd.com/api/mint-xrpl', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: user }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = await response.json()
  if (!response.ok)
    throw new Error(
      `RLUSD faucet returned ${response.status}: ${body.error || 'request rejected'}. Fund ${user} at https://tryrlusd.com/ then rerun.`,
    )
  if (!/^[A-Fa-f0-9]{64}$/.test(body.txHash || ''))
    throw new Error('Faucet did not return a transaction hash; check status before requesting again')
  const until = Date.now() + 60_000
  while (Date.now() < until) {
    const tx = await ledger.lookup(body.txHash)
    if (tx?.validated) {
      if (resultCode(tx) !== 'tesSUCCESS') throw new Error(`RLUSD faucet payment failed: ${resultCode(tx)}`)
      console.log(JSON.stringify({ faucetTransaction: body.txHash, user }))
      return
    }
    await delay(2000)
  }
  throw new Error(`Faucet payment ${body.txHash} is not validated yet; use status before requesting again`)
}

async function deposit(store, ledger, amount, id) {
  amount = positive(amount)
  if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id))
    throw new Error('A stable --id of 1–80 letters, digits, _ or - is required')
  const user = address(store.keys.user)
  const prior = store.state.requests[id]
  if (prior && (prior.amount !== amount || prior.user !== user))
    throw new Error('Deposit ID is already bound to another payment')
  if (!prior && (store.state.paused || !store.state.allowlist.includes(user)))
    throw new Error('Minting is paused or demo user is not allowlisted')
  const key = `deposit:${id}`
  store.state.requests[id] = { amount, user, operation: key }
  const tx = {
    TransactionType: 'Payment',
    Account: user,
    Destination: store.state.market,
    DestinationTag: store.state.mintTag,
    Amount: { ...store.state.collateral, value: amount },
  }
  const result = await submitJournaled(store, ledger, key, tx, store.keys.user)
  if (result.status !== 'validated')
    throw new Error(`Deposit ${id} expired without delivery. Use a new ID to make a new payment`)
  assertDelivered(result.result, store.state.collateral, amount)
  console.log(JSON.stringify({ depositId: id, amount, hash: result.hash }))
  return result.hash
}

async function status(store, ledger) {
  const state = store.state
  const user = address(store.keys.user)
  const snapshot = await ledger.index()
  const reserve = await ledger.line(state.market, state.collateral, snapshot)
  let holder
  try {
    holder = await ledger.line(user, state.yusd, snapshot)
  } catch (error) {
    if (error.data?.error !== 'actNotFound') throw error
  }
  console.log(
    JSON.stringify(
      {
        network: state.network,
        ledger: snapshot,
        cursor: state.cursor,
        paused: state.paused,
        issuer: state.issuer,
        currency: state.yusd.currency,
        market: state.market,
        mintDestinationTag: state.mintTag,
        demoUser: user,
        collateralMode: mode,
        collateral: state.collateral,
        liquidCollateral: reserve?.balance || '0',
        demoYusd: holder?.balance || '0',
        journalMinted: decimal(mintedUnits(state)),
        supplyCap: state.supplyCap,
        deposits: Object.values(state.deposits).map(({ delivered, attempts, ...record }) => record),
      },
      null,
      2,
    ),
  )
}

async function demo(store, ledger) {
  await setup(store, ledger)
  await onboard(store, ledger)
  const user = address(store.keys.user)
  const before = (await ledger.line(user, store.state.yusd)).balance
  const alreadyMinted =
    store.state.requests['demo-v1'] &&
    Object.values(store.state.deposits).find((r) => r.hash === store.state.operations['deposit:demo-v1']?.hash)
      ?.status === 'minted'
  if (!store.state.requests['demo-v1'] && units((await ledger.line(user, store.state.collateral)).balance) < units('1'))
    await faucet(store, ledger)
  const hash = await deposit(store, ledger, '1', 'demo-v1')
  // account_tx indexing can lag the validated tx response; catch up without skipping ledgers.
  for (let count = 0; count < 10 && store.state.deposits[hash]?.status !== 'minted'; count++) {
    await runOnce(store, ledger, store.keys.issuer)
    if (store.state.deposits[hash]?.status !== 'minted') await delay(2000)
  }
  assert.equal(store.state.deposits[hash]?.status, 'minted', JSON.stringify(store.state.deposits[hash]))
  const minted = store.state.deposits[hash]
  const depositTx = await ledger.lookup(hash)
  const mintTx = await ledger.lookup(minted.mintHash)
  assertDelivered(depositTx, store.state.collateral, '1')
  assertDelivered(mintTx, store.state.yusd, '1')
  const balance = (await ledger.line(user, store.state.yusd)).balance
  assert.equal(units(balance), units(before) + (alreadyMinted ? 0n : units('1')))
  // Force replay of the deposit ledger and re-open the on-disk journal like a restart.
  store.state.cursor = Math.min(store.state.cursor, minted.ledger - 1)
  store.save()
  store.release()
  store.acquire()
  await runOnce(store, ledger, store.keys.issuer)
  assert.equal((await ledger.line(user, store.state.yusd)).balance, balance)
  assert.equal(store.state.deposits[hash].mintHash, minted.mintHash)
  const evidence = {
    network: 'testnet',
    issuer: store.state.issuer,
    currency: YUSD_CURRENCY,
    market: store.state.market,
    user,
    collateralMode: mode,
    collateral: store.state.collateral,
    depositHash: hash,
    mintHash: minted.mintHash,
    depositLedger: depositTx.ledger_index,
    mintLedger: mintTx.ledger_index,
    deliveredCollateral: '1',
    deliveredYusd: '1',
    userYusdBalance: balance,
    replayDidNotMintAgain: true,
  }
  console.log(JSON.stringify(evidence, null, 2))
  return evidence
}

async function execute() {
  if (!command || values.help) {
    console.log(HELP)
    return
  }
  if (values.issuer !== undefined && command !== 'holders') throw new Error('--issuer is only supported by holders')
  if (command === 'holders') {
    let issuer = values.issuer
    if (issuer === undefined) {
      const state = JSON.parse(await readFile(`${directory}/state.json`, 'utf8'))
      if (
        state.version !== 1 ||
        state.network !== 'testnet' ||
        state.url !== TESTNET_URL ||
        (state.collateralMode || 'rlusd') !== mode ||
        state.yusd?.currency !== YUSD_CURRENCY ||
        state.yusd.issuer !== state.issuer
      ) {
        throw new Error('Holder query deployment identity mismatch')
      }
      issuer = state.issuer
    }
    if (!isValidClassicAddress(issuer)) throw new Error('A classic XRPL issuer address is required')
    const ledger = new Ledger()
    try {
      await ledger.connect()
      console.log(
        JSON.stringify(
          { network: 'testnet', ...(await holderSnapshot(ledger.client, issuer, YUSD_CURRENCY)) },
          null,
          2,
        ),
      )
    } finally {
      await ledger.disconnect()
    }
    return
  }
  const allowed = [
    'setup',
    'onboard',
    'allow',
    'disallow',
    'faucet',
    'deposit',
    'worker',
    'pause',
    'resume',
    'retry',
    'status',
    'demo',
  ]
  if (!allowed.includes(command)) throw new Error(`Unknown command: ${command}\n${HELP}`)
  let stopped = false
  process.on('SIGINT', () => {
    stopped = true
  })
  process.on('SIGTERM', () => {
    stopped = true
  })
  do {
    const store = new Store(directory)
    const ledger = new Ledger()
    try {
      store.acquire()
      if (!['setup', 'demo'].includes(command)) requireState(store)
      if (['pause', 'resume', 'allow', 'disallow', 'retry'].includes(command)) {
        if (command === 'pause' || command === 'resume') store.state.paused = command === 'pause'
        if (command === 'allow' || command === 'disallow') {
          if (
            !isValidClassicAddress(args[0]) ||
            [store.state.issuer, store.state.market, store.state.collateral.issuer].includes(args[0])
          )
            throw new Error('An external classic XRPL account address is required')
          store.state.allowlist = store.state.allowlist.filter((a) => a !== args[0])
          if (command === 'allow') store.state.allowlist.push(args[0])
        }
        if (command === 'retry') retryMint(store, args[0]?.toUpperCase())
        store.save()
        console.log(`${command}: saved`)
      } else {
        await ledger.connect()
        if (command === 'setup') await setup(store, ledger)
        if (command === 'onboard') await onboard(store, ledger)
        if (command === 'faucet') await faucet(store, ledger)
        if (command === 'deposit') await deposit(store, ledger, args[0], values.id)
        if (command === 'worker') {
          await runOnce(store, ledger, store.keys.issuer)
          console.log(JSON.stringify({ cursor: store.state.cursor, minted: decimal(mintedUnits(store.state)) }))
        }
        if (command === 'status') await status(store, ledger)
        if (command === 'demo') await demo(store, ledger)
      }
    } catch (error) {
      if (command !== 'worker' || values.once) throw error
      console.error(error.message)
    } finally {
      try {
        await ledger.disconnect()
      } finally {
        store.release()
      }
    }
    if (command !== 'worker' || values.once || stopped) return
    await delay(5000)
  } while (!stopped)
}

execute().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
