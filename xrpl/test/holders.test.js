import test from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'xrpl'
import { holderSnapshot } from '../src/holders.js'
import { YUSD_CURRENCY } from '../src/ledger.js'

const issuer = Wallet.generate().classicAddress
const accounts = Array.from({ length: 8 }, () => Wallet.generate().classicAddress)
const hash = 'A'.repeat(64)
const line = (index, balance, extra = {}) => ({ account: accounts[index], currency: YUSD_CURRENCY, balance, ...extra })
function clientFor(pages, header = {}) {
  const requests = []
  let index = 0
  return {
    requests,
    async request(request) {
      requests.push(request)
      if (request.command === 'ledger')
        return { result: { validated: true, ledger_index: 123, ledger_hash: hash, ...header } }
      assert.equal(request.command, 'account_lines')
      assert.equal(request.account, issuer)
      assert.equal(request.ledger_hash, hash)
      assert.equal(request.ignore_default, false)
      return { result: { validated: true, ledger_hash: hash, account: issuer, ...pages[index++] } }
    },
  }
}

test('holders include positive ownership regardless of mint history or freeze, with exact ledger precision', async () => {
  const client = clientFor([
    {
      lines: [
        line(0, '-1'),
        line(1, '0'),
        line(2, '-0e-9'),
        line(3, '4'),
        line(4, '-10', { currency: 'USD' }),
        line(5, '-1.234567890123456e-8'),
        line(6, '-1000000000000000e+70', { freeze: true }),
      ],
    },
  ])
  const snapshot = await holderSnapshot(client, issuer, YUSD_CURRENCY)
  assert.equal(snapshot.ledger, 123)
  assert.equal(snapshot.ledgerHash, hash)
  assert.equal(snapshot.holderCount, 3)
  assert.deepEqual(
    snapshot.holders,
    [
      { address: accounts[0], balance: '1' },
      { address: accounts[5], balance: '1.234567890123456e-8' },
      { address: accounts[6], balance: '1000000000000000e+70' },
    ].sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0)),
  )
})

test('pagination remains pinned to one validated ledger and does not stop at an empty filtered page', async () => {
  const marker = { cursor: 'next' }
  const client = clientFor([{ lines: [line(0, '0')], marker }, { lines: [line(1, '-2')] }])
  const snapshot = await holderSnapshot(client, issuer, YUSD_CURRENCY)
  assert.deepEqual(snapshot.holders, [{ address: accounts[1], balance: '2' }])
  assert.equal(client.requests.length, 3)
  assert.deepEqual(client.requests[2].marker, marker)
  assert.equal(client.requests[2].ledger_hash, client.requests[1].ledger_hash)
})

test('zero holders returns an empty list and count, not issuer inventory', async () => {
  const result = await holderSnapshot(clientFor([{ lines: [] }]), issuer, YUSD_CURRENCY)
  assert.equal(result.holderCount, 0)
  assert.deepEqual(result.holders, [])
})

test('missing or inconsistent validation data cannot produce a holder snapshot', async () => {
  for (const header of [
    { validated: false },
    { validated: undefined },
    { ledger_hash: undefined },
    { ledger_index: '123' },
  ]) {
    await assert.rejects(holderSnapshot(clientFor([], header), issuer, YUSD_CURRENCY), /validated holder snapshot/)
  }
  for (const page of [
    { validated: false },
    { ledger_hash: 'B'.repeat(64) },
    { account: accounts[0] },
    { lines: undefined },
  ]) {
    await assert.rejects(
      holderSnapshot(clientFor([{ lines: [], ...page }]), issuer, YUSD_CURRENCY),
      /Inconsistent holder page/,
    )
  }
})

test('duplicate accounts and repeated pagination markers fail closed', async () => {
  await assert.rejects(
    holderSnapshot(clientFor([{ lines: [line(0, '-1'), line(0, '-2')] }]), issuer, YUSD_CURRENCY),
    /duplicate/,
  )
  await assert.rejects(
    holderSnapshot(
      clientFor([
        { lines: [], marker: 'same' },
        { lines: [], marker: 'same' },
      ]),
      issuer,
      YUSD_CURRENCY,
    ),
    /Repeated holder pagination marker/,
  )
})

test('malformed matching balances and addresses are errors, not silently omitted holders', async () => {
  for (const balance of ['', 'NaN', 'Infinity', '-1.2.3', null, undefined, -1]) {
    await assert.rejects(
      holderSnapshot(clientFor([{ lines: [line(0, balance)] }]), issuer, YUSD_CURRENCY),
      /Invalid trust-line balance/,
    )
  }
  await assert.rejects(
    holderSnapshot(clientFor([{ lines: [line(0, '-1', { account: 'bad' })] }]), issuer, YUSD_CURRENCY),
    /Invalid or duplicate/,
  )
  await assert.rejects(holderSnapshot(clientFor([]), 'bad', YUSD_CURRENCY), /classic XRPL issuer/)
})

test('a later page error does not return a partial holder list', async () => {
  const client = clientFor([{ lines: [line(0, '-1')], marker: 'second' }])
  const request = client.request.bind(client)
  client.request = async (args) => {
    if (args.marker) throw new Error('history unavailable')
    return request(args)
  }
  await assert.rejects(holderSnapshot(client, issuer, YUSD_CURRENCY), /history unavailable/)
})
