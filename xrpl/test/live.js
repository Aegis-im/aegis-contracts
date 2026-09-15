// Public CLI acceptance probe. Uses only this package's generated Testnet accounts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { Wallet } from 'xrpl'
import { Store, atomicJson } from '../src/store.js'
import { Ledger, submitJournaled, resultCode, assertDelivered } from '../src/ledger.js'
import { units } from '../src/amounts.js'

const mock = process.argv.includes('--mock')
if (process.argv.slice(2).some((arg) => arg !== '--mock')) throw new Error('Only --mock is supported')
const directory =
  process.env.XRPL_STATE_DIR ||
  fileURLToPath(new URL(mock ? '../.local/testnet-mock' : '../.local/testnet', import.meta.url))
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
const read = () => JSON.parse(fs.readFileSync(`${directory}/state.json`, 'utf8'))
async function command(...args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args, ...(mock ? ['--mock'] : [])], {
      stdio: 'inherit',
      env: { ...process.env, XRPL_STATE_DIR: directory },
    })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`CLI ${args.join(' ')} exited ${code}`))))
  })
}

await command('demo')
const store = new Store(directory)
const ledger = new Ledger()
await ledger.connect()
try {
  const original = read()
  const keys = JSON.parse(fs.readFileSync(`${directory}/wallets.json`, 'utf8'))
  const user = Wallet.fromSeed(keys.user).classicAddress
  const before = units((await ledger.line(user, original.yusd)).balance)
  const existing = original.operations['deposit:acceptance-v1']
  const alreadyMinted = existing && original.deposits[existing.hash]?.status === 'minted'
  await command('deposit', '2.5', '--id', 'acceptance-v1')
  const deposit = read().operations['deposit:acceptance-v1']
  if (!alreadyMinted) {
    await command('pause')
    try {
      await command('worker', '--once')
      const paused = read().deposits[deposit.hash]
      assert.equal(paused.status, 'blocked')
      assert.match(paused.reason, /paused/)
      assert.equal(units((await ledger.line(user, original.yusd)).balance), before)
    } finally {
      await command('resume')
    }
  }
  await command('worker', '--once')
  const record = read().deposits[deposit.hash]
  assert.equal(record.status, 'minted')
  assertDelivered(await ledger.lookup(record.mintHash), original.yusd, '2.5')
  const after = units((await ledger.line(user, original.yusd)).balance)
  assert.equal(after, before + (alreadyMinted ? 0n : units('2.5')))
  await command('deposit', '2.5', '--id', 'acceptance-v1')
  await command('worker', '--once')
  assert.equal(units((await ledger.line(user, original.yusd)).balance), after)

  // A validated XRP payment reaches the receiver but must not create YUSD.
  store.acquire()
  let probe
  try {
    probe = await submitJournaled(
      store,
      ledger,
      'probe:xrp:v1',
      {
        TransactionType: 'Payment',
        Account: user,
        Destination: original.market,
        DestinationTag: 1,
        Amount: '1',
      },
      keys.user,
    )
    assert.equal(resultCode(probe.result), 'tesSUCCESS')
  } finally {
    store.release()
  }
  await command('worker', '--once')
  const reviewed = read().deposits[probe.hash]
  assert.equal(reviewed.status, 'review')
  assert.match(reviewed.reason, /Wrong collateral/)
  assert.equal(units((await ledger.line(user, original.yusd)).balance), after)
  const evidence = {
    checkedAt: new Date().toISOString(),
    network: 'testnet',
    collateralMode: mock ? 'mock' : 'rlusd',
    issuer: original.issuer,
    market: original.market,
    user,
    collateral: original.collateral,
    mintDepositHash: deposit.hash,
    mintHash: record.mintHash,
    rejectedXrpHash: probe.hash,
    validatedMintAmount: '2.5',
    replayDidNotMintAgain: true,
    wrongAssetDidNotMint: true,
    pauseBlockedNewMint: alreadyMinted ? 'previous run; not repeated' : true,
  }
  atomicJson(`${directory}/acceptance.json`, evidence)
  console.log(JSON.stringify(evidence, null, 2))
} finally {
  await ledger.disconnect()
  store.release()
}
