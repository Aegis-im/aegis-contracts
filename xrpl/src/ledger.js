import { Client, Wallet, AccountSetAsfFlags, TrustSetFlags } from 'xrpl'
import { units } from './amounts.js'

export const TESTNET_URL = 'wss://s.altnet.rippletest.net:51233'
export const RLUSD = Object.freeze({
  currency: '524C555344000000000000000000000000000000',
  issuer: 'rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV',
})
export const YUSD_CURRENCY = '5955534400000000000000000000000000000000'
export const MOCK_CURRENCY = '4D524C5553440000000000000000000000000000' // MRLUSD, never Ripple RLUSD
export const txJson = (entry) => entry.tx_json || entry.tx
export const txHash = (entry) => entry.hash || txJson(entry)?.hash
export const resultCode = (entry) => (typeof entry?.meta === 'object' ? entry.meta.TransactionResult : undefined)
export const sameAsset = (amount, asset) =>
  amount && typeof amount === 'object' && amount.currency === asset.currency && amount.issuer === asset.issuer

export function coversLedgers(ranges, first, last) {
  return (
    typeof ranges === 'string' &&
    ranges.split(',').some((range) => {
      const [low, high = low] = range.trim().split('-').map(Number)
      return low <= first && high >= last
    })
  )
}

export class Ledger {
  constructor() {
    // Deliberately no arbitrary RPC override: this signer is a Testnet-only tool.
    this.client = new Client(TESTNET_URL, { connectionTimeout: 15_000, timeout: 20_000, maxFeeXRP: '0.01' })
    this.client.on('error', () => {}) // Request errors are surfaced to the caller.
  }

  async connect() {
    await this.client.connect()
    const { result } = await this.client.request({ command: 'server_info' })
    if (result.info.network_id !== 1) throw new Error('Refusing to sign outside XRPL Testnet (network_id 1)')
  }
  async disconnect() {
    await this.client.disconnect()
  }
  async index() {
    return this.client.getLedgerIndex()
  }

  async info(account, ledger = 'validated') {
    return (await this.client.request({ command: 'account_info', account, ledger_index: ledger })).result.account_data
  }

  async lines(account, peer, ledger = 'validated') {
    const lines = []
    let marker
    do {
      const { result } = await this.client.request({
        command: 'account_lines',
        account,
        peer,
        ledger_index: ledger,
        limit: 400,
        ...(marker ? { marker } : {}),
      })
      lines.push(...result.lines)
      marker = result.marker
    } while (marker)
    return lines
  }

  async line(account, asset, ledger = 'validated') {
    return (await this.lines(account, asset.issuer, ledger)).find((line) => line.currency === asset.currency)
  }

  async history(account, first, last) {
    const entries = []
    let marker
    do {
      const { result } = await this.client.request({
        command: 'account_tx',
        account,
        ledger_index_min: first,
        ledger_index_max: last,
        forward: true,
        binary: false,
        limit: 200,
        ...(marker ? { marker } : {}),
      })
      if (result.ledger_index_min !== first || result.ledger_index_max !== last || result.validated !== true) {
        throw new Error('Incomplete or unvalidated account history; cursor unchanged')
      }
      entries.push(...result.transactions)
      marker = result.marker
    } while (marker)
    return entries
  }

  async lookup(hash) {
    try {
      return (await this.client.request({ command: 'tx', transaction: hash, binary: false })).result
    } catch (error) {
      if (error.data?.error === 'txnNotFound') return null
      throw error
    }
  }

  async prepare(transaction, seed) {
    const firstLedger = await this.index()
    const prepared = await this.client.autofill({ ...transaction, LastLedgerSequence: firstLedger + 20 })
    if (BigInt(prepared.Fee) > 10_000n) throw new Error('Fee exceeds Testnet signing cap')
    const signed = Wallet.fromSeed(seed).sign(prepared)
    return {
      hash: signed.hash,
      blob: signed.tx_blob,
      account: transaction.Account,
      firstLedger,
      lastLedger: prepared.LastLedgerSequence,
      sequence: prepared.Sequence,
      status: 'signed',
    }
  }

  async resolve(attempt) {
    const existing = await this.lookup(attempt.hash)
    if (existing?.validated === true) return { status: 'validated', result: existing }
    const latest = await this.index()
    if (latest > attempt.lastLedger) {
      const { result } = await this.client.request({ command: 'server_info' })
      if (!coversLedgers(result.info.complete_ledgers, attempt.firstLedger, attempt.lastLedger)) {
        throw new Error('Cannot prove transaction expiration: server history has a gap')
      }
      // Query again after checking history, so the absence and coverage refer to current server state.
      const final = await this.lookup(attempt.hash)
      if (final?.validated === true) return { status: 'validated', result: final }
      return { status: 'expired' }
    }
    const { result } = await this.client.submitAndWait(attempt.blob)
    if (result.validated !== true) throw new Error('Submission has no validated outcome yet')
    return { status: 'validated', result }
  }

  async fund(seed) {
    const wallet = Wallet.fromSeed(seed)
    try {
      await this.info(wallet.classicAddress)
      return
    } catch (error) {
      if (error.data?.error !== 'actNotFound') throw error
    }
    await this.client.fundWallet(wallet)
  }
}

export function trustTransaction(account, asset) {
  return {
    TransactionType: 'TrustSet',
    Account: account,
    LimitAmount: { ...asset, value: '1000000000' },
    Flags: TrustSetFlags.tfSetNoRipple,
  }
}

export function issuerTransaction(account) {
  return { TransactionType: 'AccountSet', Account: account, SetFlag: AccountSetAsfFlags.asfDefaultRipple }
}

export function assertDelivered(entry, asset, amount) {
  if (entry.validated !== true || resultCode(entry) !== 'tesSUCCESS')
    throw new Error('Payment did not validate successfully')
  const delivered = entry.meta.delivered_amount
  if (!sameAsset(delivered, asset) || units(delivered.value) !== units(amount))
    throw new Error('Validated payment delivered an unexpected asset or amount; manual reconciliation required')
}

// Shared by setup, deposits, and minting. A caller may retry only terminal failures.
export async function submitJournaled(store, ledger, key, transaction, seed) {
  let attempt = store.state.operations[key]
  if (!attempt) {
    if (
      Object.values(store.state.operations).some((op) => op.account === transaction.Account && op.status === 'signed')
    ) {
      throw new Error(`Account ${transaction.Account} has an unresolved signature; resume that operation first`)
    }
    attempt = await ledger.prepare(transaction, seed)
    store.state.operations[key] = attempt
    store.save()
  }
  if (attempt.status === 'validated' || attempt.status === 'expired') return attempt
  const outcome = await ledger.resolve(attempt)
  Object.assign(attempt, outcome)
  store.save()
  return attempt
}
