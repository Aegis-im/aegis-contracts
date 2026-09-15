import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Wallet, encode, decode } from 'xrpl'
import { Store } from '../src/store.js'
import { units, decimal, positive } from '../src/amounts.js'
import { RLUSD, YUSD_CURRENCY, Ledger, coversLedgers, submitJournaled } from '../src/ledger.js'
import { ingest, runOnce, preflight, mintTransaction, retryMint } from '../src/minter.js'

const issuer = Wallet.generate()
const market = Wallet.generate()
const user = Wallet.generate()
const hash = 'A'.repeat(64)
function state() {
  return {
    issuer: issuer.classicAddress,
    market: market.classicAddress,
    yusd: { currency: YUSD_CURRENCY, issuer: issuer.classicAddress },
    collateral: { ...RLUSD },
    mintTag: 1,
    ready: true,
    paused: false,
    cursor: 99,
    supplyCap: '1000000',
    allowlist: [user.classicAddress],
    deposits: {},
    operations: {},
  }
}
function incoming() {
  return {
    hash,
    ledger_index: 100,
    validated: true,
    tx_json: {
      TransactionType: 'Payment',
      Account: user.classicAddress,
      Destination: market.classicAddress,
      DestinationTag: 1,
      Flags: 0,
      Amount: { ...RLUSD, value: '1000' },
    },
    meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...RLUSD, value: '1.234567' } },
  }
}
function disk(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-xrpl-test-'))
  const store = new Store(directory)
  store.acquire()
  store.state = state()
  store.save()
  t.after(() => {
    store.release()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return store
}
class FakeLedger {
  constructor() {
    this.issued = 0n
    this.prepared = 0
    this.entries = [incoming()]
    this.resolved = new Map()
    this.reserve = '100'
  }
  async index() {
    return 100
  }
  async history() {
    return this.entries
  }
  async info() {
    return { Flags: 0x00800000 }
  }
  async line(account, asset) {
    if (asset.issuer === RLUSD.issuer) return { balance: this.reserve }
    return { balance: decimal(this.issued), limit: '1000000000' }
  }
  async lines() {
    return [{ currency: YUSD_CURRENCY, balance: decimal(-this.issued) }]
  }
  async prepare(tx) {
    this.prepared++
    return {
      hash: this.prepared.toString(16).padStart(64, '0').toUpperCase(),
      account: tx.Account,
      blob: JSON.stringify(tx),
      status: 'signed',
      firstLedger: 100,
      lastLedger: 120,
    }
  }
  async resolve(attempt) {
    if (this.resolved.has(attempt.hash)) return this.resolved.get(attempt.hash)
    const tx = JSON.parse(attempt.blob)
    this.issued += units(tx.Amount.value)
    const outcome = {
      status: 'validated',
      result: {
        hash: attempt.hash,
        validated: true,
        ledger_index: 101,
        tx_json: tx,
        meta: { TransactionResult: 'tesSUCCESS', delivered_amount: tx.Amount },
      },
    }
    this.resolved.set(attempt.hash, outcome)
    if (this.loseAcknowledgement) {
      this.loseAcknowledgement = false
      throw new Error('connection lost after validation')
    }
    return outcome
  }
}

test('decimal amounts preserve micro-units, exponents and large exact balances', () => {
  for (const [input, expected] of [
    ['1.234567', 1234567n],
    ['1e-6', 1n],
    ['1000000000', 1000000000000000n],
    ['0.0000010', 1n],
  ])
    assert.equal(units(input), expected)
  assert.equal(decimal(units('9.010000')), '9.01')
  assert.equal(units('-1.1', { signed: true }), -1100000n)
})
test('amount parser rejects invalid, dust, negative, excessive and non-string inputs', () => {
  for (const input of [
    '',
    ' ',
    'NaN',
    'Infinity',
    '-1',
    '1e-7',
    '0.0000001',
    '1000000000.000001',
    '1e999',
    1,
    null,
    undefined,
  ])
    assert.throws(() => positive(input), String(input))
  assert.throws(() => positive('0'))
})
test('incoming Payment credits delivered_amount, never nominal Amount, and preserves SourceTag', () => {
  const s = state()
  const entry = incoming()
  entry.tx_json.SourceTag = 42
  ingest(s, entry)
  assert.equal(s.deposits[hash].yusdAmount, '1.234567')
  assert.equal(s.deposits[hash].destinationTag, 42)
  ingest(s, entry)
  assert.equal(Object.keys(s.deposits).length, 1)
})

for (const [name, alter] of [
  [
    'XRP',
    (e) => {
      e.meta.delivered_amount = '1234567'
    },
  ],
  [
    'wrong issuer',
    (e) => {
      e.meta.delivered_amount.issuer = user.classicAddress
    },
  ],
  [
    'wrong currency',
    (e) => {
      e.meta.delivered_amount.currency = YUSD_CURRENCY
    },
  ],
  [
    'partial payment',
    (e) => {
      e.tx_json.Flags = 0x00020000
    },
  ],
  [
    'missing delivered amount',
    (e) => {
      delete e.meta.delivered_amount
    },
  ],
  [
    'unavailable delivered amount',
    (e) => {
      e.meta.delivered_amount = 'unavailable'
    },
  ],
  [
    'zero delivery',
    (e) => {
      e.meta.delivered_amount.value = '0'
    },
  ],
  [
    'dust delivery',
    (e) => {
      e.meta.delivered_amount.value = '1e-7'
    },
  ],
  [
    'untagged deposit',
    (e) => {
      delete e.tx_json.DestinationTag
    },
  ],
  [
    'wrong tag',
    (e) => {
      e.tx_json.DestinationTag = 0
    },
  ],
  [
    'issuer transfer',
    (e) => {
      e.tx_json.Account = issuer.classicAddress
    },
  ],
])
  test(`${name} is retained for review without minting`, () => {
    const s = state()
    const e = incoming()
    alter(e)
    ingest(s, e)
    assert.equal(s.deposits[hash].status, 'review')
    assert.ok(s.deposits[hash].reason)
  })

for (const [name, alter] of [
  [
    'unvalidated',
    (e) => {
      e.validated = false
    },
  ],
  [
    'failed',
    (e) => {
      e.meta.TransactionResult = 'tecPATH_DRY'
    },
  ],
  [
    'outgoing',
    (e) => {
      e.tx_json.Destination = user.classicAddress
    },
  ],
  [
    'non-payment',
    (e) => {
      e.tx_json.TransactionType = 'OfferCreate'
    },
  ],
])
  test(`${name} transaction cannot produce a mint record`, () => {
    const s = state()
    const e = incoming()
    alter(e)
    ingest(s, e)
    assert.deepEqual(s.deposits, {})
  })

test('mint serializes as a direct issuer Payment using the actual XRPL codec', () => {
  const s = state()
  ingest(s, incoming())
  const tx = mintTransaction(s, s.deposits[hash])
  const decoded = decode(
    encode({ ...tx, Sequence: 1, Fee: '12', LastLedgerSequence: 120, SigningPubKey: issuer.publicKey }),
  )
  assert.equal(decoded.TransactionType, 'Payment')
  assert.equal(decoded.Account, issuer.classicAddress)
  assert.equal(decoded.Destination, user.classicAddress)
  assert.equal(decoded.Amount.value, '1.234567')
  for (const key of ['Paths', 'SendMax', 'DomainID', 'TakerGets', 'TakerPays']) assert.equal(decoded[key], undefined)
  assert.equal(decoded.Memos[0].Memo.MemoData, hash)
})

test('deposit replay and actual disk reopen produce exactly one issuance', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  await runOnce(store, ledger, issuer.seed)
  assert.equal(store.state.deposits[hash].status, 'minted')
  store.state.cursor = 99
  store.save()
  store.release()
  store.acquire()
  await runOnce(store, ledger, issuer.seed)
  assert.equal(ledger.prepared, 1)
  assert.equal(ledger.issued, 1234567n)
})

test('lost success acknowledgement is reconciled after restart without a new signature', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  ledger.loseAcknowledgement = true
  await assert.rejects(runOnce(store, ledger, issuer.seed), /connection lost/)
  assert.equal(store.state.deposits[hash].status, 'submitting')
  store.release()
  store.acquire()
  // Pausing blocks new issuance, but must not abandon an already signed transaction.
  store.state.paused = true
  await runOnce(store, ledger, issuer.seed)
  assert.equal(store.state.deposits[hash].status, 'minted')
  assert.equal(ledger.prepared, 1)
  assert.equal(ledger.issued, 1234567n)
})

test('journal is durable before the submission is exposed to the network', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  const resolve = ledger.resolve.bind(ledger)
  ledger.resolve = async (attempt) => {
    const persisted = JSON.parse(fs.readFileSync(store.file, 'utf8'))
    assert.equal(persisted.deposits[hash].status, 'submitting')
    assert.equal(persisted.operations[persisted.deposits[hash].attempts[0]].blob, attempt.blob)
    return resolve(attempt)
  }
  await runOnce(store, ledger, issuer.seed)
})

test('allowlist and missing trust line block and later release the same deposit', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  store.state.allowlist = []
  await runOnce(store, ledger, issuer.seed)
  assert.equal(store.state.deposits[hash].reason, 'Sender is not allowlisted')
  store.state.allowlist.push(user.classicAddress)
  const line = ledger.line.bind(ledger)
  ledger.line = async (account, asset) => (asset.issuer === issuer.classicAddress ? undefined : line(account, asset))
  await runOnce(store, ledger, issuer.seed)
  assert.match(store.state.deposits[hash].reason, /trust line/)
  assert.equal(ledger.prepared, 0)
  ledger.line = line
  await runOnce(store, ledger, issuer.seed)
  assert.equal(ledger.prepared, 1)
})

test('cap includes earlier mints and liquid reserve is enforced', async () => {
  const s = state()
  ingest(s, incoming())
  const ledger = new FakeLedger()
  s.supplyCap = '1.234566'
  assert.match(await preflight(s, ledger, s.deposits[hash]), /cap/)
  s.supplyCap = '1.234567'
  assert.equal(await preflight(s, ledger, s.deposits[hash]), null)
  s.supplyCap = '1.234568'
  assert.equal(await preflight(s, ledger, s.deposits[hash]), null)
  ledger.reserve = '1.234566'
  assert.match(await preflight(s, ledger, s.deposits[hash]), /collateral/)
  ledger.reserve = '1.234567'
  assert.equal(await preflight(s, ledger, s.deposits[hash]), null)
  s.deposits['B'.repeat(64)] = { status: 'minted', yusdAmount: '0.000002' }
  assert.match(await preflight(s, ledger, s.deposits[hash]), /cap/)
})

test('issuer global freeze, drift, trust limit, external issuance and pause block mint', async () => {
  const s = state()
  ingest(s, incoming())
  const record = s.deposits[hash]
  const ledger = new FakeLedger()
  s.paused = true
  assert.match(await preflight(s, ledger, record), /paused/)
  s.paused = false
  ledger.info = async () => ({ Flags: 0x00800000 | 0x00400000 })
  assert.match(await preflight(s, ledger, record), /global freeze/)
  ledger.info = async () => ({ Flags: 0 })
  assert.match(await preflight(s, ledger, record), /settings/)
  ledger.info = async () => ({ Flags: 0x00800000 })
  const line = ledger.line.bind(ledger)
  ledger.line = async (account, asset) => ({ ...(await line(account, asset)), freeze_peer: true })
  assert.match(await preflight(s, ledger, record), /frozen/)
  ledger.line = async (account, asset) => ({ ...(await line(account, asset)), limit: '1.234566' })
  assert.match(await preflight(s, ledger, record), /capacity/)
  ledger.line = line
  ledger.issued = 1n
  assert.match(await preflight(s, ledger, record), /Unreconciled/)
})

test('failed history page does not advance the durable cursor', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  ledger.history = async () => {
    throw new Error('history gap')
  }
  await assert.rejects(runOnce(store, ledger, issuer.seed), /history gap/)
  assert.equal(JSON.parse(fs.readFileSync(store.file)).cursor, 99)
  assert.equal(ledger.prepared, 0)
})

test('known failed mint waits for explicit retry; uncertain and successful attempts cannot retry', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  const resolve = ledger.resolve.bind(ledger)
  ledger.resolve = async () => ({
    status: 'validated',
    result: { validated: true, meta: { TransactionResult: 'tecPATH_DRY' } },
  })
  await runOnce(store, ledger, issuer.seed)
  await runOnce(store, ledger, issuer.seed)
  assert.equal(ledger.prepared, 1)
  assert.equal(store.state.deposits[hash].status, 'failed')
  retryMint(store, hash)
  ledger.resolve = resolve
  await runOnce(store, ledger, issuer.seed)
  assert.equal(ledger.prepared, 2)
  assert.equal(store.state.deposits[hash].status, 'minted')
  assert.throws(() => retryMint(store, hash))
})

test('unexpected successful delivery pauses minting and cannot be retried', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  ledger.resolve = async () => ({
    status: 'validated',
    result: {
      validated: true,
      meta: { TransactionResult: 'tesSUCCESS', delivered_amount: { ...store.state.yusd, value: '0.5' } },
    },
  })
  await assert.rejects(runOnce(store, ledger, issuer.seed), /unexpected/)
  assert.equal(store.state.paused, true)
  assert.equal(store.state.deposits[hash].status, 'review')
  assert.throws(() => retryMint(store, hash))
})

test('exclusive disk lock prevents a second writer and journal is private', (t) => {
  const store = disk(t)
  const second = new Store(store.directory)
  assert.throws(() => second.acquire(), /Writer lock/)
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600)
  store.release()
  second.acquire()
  second.release()
})

test('transaction expiration requires complete ledger coverage', async () => {
  assert.equal(coversLedgers('1-99,101-140', 90, 120), false)
  assert.equal(coversLedgers('1-99,100-140', 100, 120), true)
  const ledger = new Ledger()
  ledger.index = async () => 121
  ledger.lookup = async () => null
  ledger.client.request = async () => ({ result: { info: { complete_ledgers: '101-140' } } })
  await assert.rejects(ledger.resolve({ firstLedger: 100, lastLedger: 120, hash }), /history has a gap/)
  ledger.client.request = async () => ({ result: { info: { complete_ledgers: '100-140' } } })
  assert.deepEqual(await ledger.resolve({ firstLedger: 100, lastLedger: 120, hash }), { status: 'expired' })
})

test('known validated result bypasses resubmission; provisional response cannot finalize', async () => {
  const ledger = new Ledger()
  const result = { validated: true, hash }
  ledger.lookup = async () => result
  ledger.client.submitAndWait = async () => {
    throw new Error('must not submit')
  }
  assert.deepEqual(await ledger.resolve({ hash }), { status: 'validated', result })
  ledger.lookup = async () => null
  ledger.index = async () => 100
  ledger.client.submitAndWait = async () => ({ result: { validated: false } })
  await assert.rejects(ledger.resolve({ hash, lastLedger: 120 }), /no validated outcome/)
})

test('pagination uses a fixed ledger range; incomplete history fails closed', async () => {
  const ledger = new Ledger()
  const requests = []
  ledger.client.request = async (request) => {
    requests.push(request)
    return {
      result: {
        ledger_index_min: 100,
        ledger_index_max: 110,
        validated: true,
        transactions: [incoming()],
        ...(!request.marker ? { marker: { ledger: 105 } } : {}),
      },
    }
  }
  assert.equal((await ledger.history(market.classicAddress, 100, 110)).length, 2)
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].marker, { ledger: 105 })
  assert.equal(requests[1].ledger_index_min, 100)
  assert.equal(requests[1].ledger_index_max, 110)
  ledger.client.request = async () => ({
    result: { ledger_index_min: 101, ledger_index_max: 110, validated: true, transactions: [] },
  })
  await assert.rejects(ledger.history(market.classicAddress, 100, 110), /Incomplete/)
})

test('another unresolved signature prevents sequence reuse by a new operation', async (t) => {
  const store = disk(t)
  const ledger = new FakeLedger()
  store.state.operations.old = { account: issuer.classicAddress, status: 'signed' }
  await assert.rejects(
    submitJournaled(store, ledger, 'new', { Account: issuer.classicAddress }, issuer.seed),
    /unresolved/,
  )
  assert.equal(ledger.prepared, 0)
})
