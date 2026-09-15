import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { Wallet } from 'xrpl'
import { RLUSD, YUSD_CURRENCY, TESTNET_URL } from '../src/ledger.js'

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url))
function invoke(args, directory) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, XRPL_STATE_DIR: directory },
    encoding: 'utf8',
    timeout: 5000,
  })
}
function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-xrpl-cli-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
function fixture(dir) {
  const issuer = Wallet.generate(),
    market = Wallet.generate(),
    user = Wallet.generate()
  const state = {
    version: 1,
    network: 'testnet',
    url: TESTNET_URL,
    collateralMode: 'rlusd',
    collateral: RLUSD,
    issuer: issuer.classicAddress,
    market: market.classicAddress,
    yusd: { currency: YUSD_CURRENCY, issuer: issuer.classicAddress },
    cursor: 100,
    mintTag: 1,
    supplyCap: '1000000',
    paused: false,
    allowlist: [],
  }
  fs.writeFileSync(
    path.join(dir, 'wallets.json'),
    JSON.stringify({ issuer: issuer.seed, market: market.seed, user: user.seed }),
  )
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
  return state
}
test('public CLI documents both modes and rejects unknown commands', (t) => {
  const dir = directory(t)
  const help = invoke(['--help'], dir)
  assert.equal(help.status, 0)
  assert.match(help.stdout, /--mock/)
  assert.match(help.stdout, /npm run holders/)
  assert.match(help.stdout, /Redemption.*deferred/)
  const bad = invoke(['redeem'], dir)
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /Unknown command/)
  assert.equal(fs.readdirSync(dir).length, 0)
})
test('holder CLI validates public issuer arguments without creating state or loading keys', (t) => {
  const dir = directory(t)
  const result = invoke(['holders', '--issuer', 'bad-address'], dir)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /classic XRPL issuer/)
  assert.deepEqual(fs.readdirSync(dir), [])
  const misuse = invoke(['pause', '--issuer', Wallet.generate().classicAddress], dir)
  assert.equal(misuse.status, 1)
  assert.match(misuse.stderr, /only supported by holders/)
})
test('public pause/resume and allowlist mutate only the selected deployment', (t) => {
  const dir = directory(t)
  fixture(dir)
  const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json')))
  assert.equal(invoke(['pause'], dir).status, 0)
  assert.equal(read().paused, true)
  assert.equal(invoke(['resume'], dir).status, 0)
  assert.equal(read().paused, false)
  const account = Wallet.generate().classicAddress
  assert.equal(invoke(['allow', account], dir).status, 0)
  assert.deepEqual(read().allowlist, [account])
  assert.equal(invoke(['disallow', account], dir).status, 0)
  assert.deepEqual(read().allowlist, [])
  assert.equal(invoke(['allow', 'bad-address'], dir).status, 1)
})
test('CLI refuses network, asset, key and mode mismatches before connecting', (t) => {
  const dir = directory(t)
  const original = fixture(dir)
  for (const change of [
    { network: 'mainnet' },
    { collateral: { ...RLUSD, issuer: Wallet.generate().classicAddress } },
    { issuer: Wallet.generate().classicAddress },
    { collateralMode: 'mock' },
  ]) {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ ...original, ...change }))
    const result = invoke(['worker', '--once'], dir)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /identity mismatch/)
    assert.equal(fs.existsSync(path.join(dir, 'writer.lock')), false)
  }
})
