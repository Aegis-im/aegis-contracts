import { units, decimal } from './amounts.js'
import { txJson, txHash, resultCode, sameAsset, submitJournaled, assertDelivered } from './ledger.js'

export function ingest(state, entry) {
  const tx = txJson(entry)
  if (
    entry.validated !== true ||
    resultCode(entry) !== 'tesSUCCESS' ||
    tx?.TransactionType !== 'Payment' ||
    tx.Destination !== state.market
  )
    return
  const hash = txHash(entry)
  if (!/^[A-F0-9]{64}$/.test(hash || '')) throw new Error('Validated deposit is missing a transaction hash')
  if (state.deposits[hash]) return
  const record = {
    hash,
    ledger: entry.ledger_index || tx.ledger_index,
    sender: tx.Account,
    status: 'pending',
    attempts: [],
  }
  if (tx.SourceTag !== undefined) record.destinationTag = tx.SourceTag
  const delivered = entry.meta.delivered_amount
  record.delivered = delivered ?? null
  let reason
  if ([state.issuer, state.market, state.collateral.issuer].includes(tx.Account))
    reason = 'Operational/issuer transfer is not a customer mint'
  else if (tx.DestinationTag !== state.mintTag) reason = 'Missing or incorrect mint destination tag'
  else if ((tx.Flags || 0) & 0x00020000) reason = 'Partial payments are not accepted'
  else if (!sameAsset(delivered, state.collateral)) reason = 'Wrong collateral or missing delivered_amount'
  else {
    try {
      const value = units(delivered.value)
      if (value <= 0n) throw new Error('Non-positive delivered amount')
      record.collateralAmount = decimal(value)
      record.yusdAmount = decimal(value) // Testnet policy: fixed 1:1, no mint fee.
    } catch (error) {
      reason = error.message
    }
  }
  if (reason) {
    record.status = 'review'
    record.reason = reason
  }
  state.deposits[hash] = record
}

export function mintedUnits(state) {
  return Object.values(state.deposits)
    .filter((record) => record.status === 'minted')
    .reduce((sum, record) => sum + units(record.yusdAmount), 0n)
}

export function mintTransaction(state, record) {
  return {
    TransactionType: 'Payment',
    Account: state.issuer,
    Destination: record.sender,
    Amount: { ...state.yusd, value: record.yusdAmount },
    ...(record.destinationTag !== undefined ? { DestinationTag: record.destinationTag } : {}),
    Memos: [{ Memo: { MemoType: Buffer.from('aegis/mint').toString('hex').toUpperCase(), MemoData: record.hash } }],
  }
}

export async function preflight(state, ledger, record) {
  if (state.paused) return 'Minting is paused'
  if (!state.allowlist.includes(record.sender)) return 'Sender is not allowlisted'
  const minted = mintedUnits(state)
  if (minted + units(record.yusdAmount) > units(state.supplyCap)) return 'Mint would exceed the supply cap'
  const snapshot = await ledger.index()
  const [issuer, collateralIssuer, reserve, recipient, issuerLines] = await Promise.all([
    ledger.info(state.issuer, snapshot),
    ledger.info(state.collateral.issuer, snapshot),
    ledger.line(state.market, state.collateral, snapshot),
    ledger.line(record.sender, state.yusd, snapshot),
    ledger.lines(state.issuer, undefined, snapshot),
  ])
  if (!(issuer.Flags & 0x00800000) || issuer.Flags & 0x00040000)
    return 'YUSD issuer settings differ from the Testnet policy'
  if ((issuer.Flags | collateralIssuer.Flags) & 0x00400000) return 'Issuer global freeze is enabled'
  if (!reserve || reserve.freeze || reserve.freeze_peer || reserve.deep_freeze || reserve.deep_freeze_peer)
    return 'Collateral trust line is missing or frozen'
  if (units(reserve.balance, { signed: true }) < minted + units(record.yusdAmount))
    return 'Liquid collateral does not cover issued YUSD plus this mint'
  if (!recipient || recipient.freeze || recipient.freeze_peer || recipient.deep_freeze || recipient.deep_freeze_peer)
    return 'Recipient YUSD trust line is missing or frozen'
  if (units(recipient.limit) - units(recipient.balance, { signed: true }) < units(record.yusdAmount))
    return 'Recipient YUSD trust line has insufficient capacity'
  const supply = issuerLines
    .filter((line) => line.currency === state.yusd.currency)
    .reduce((sum, line) => sum - units(line.balance, { signed: true }), 0n)
  if (supply > minted) return 'Unreconciled YUSD issuance detected'
  return null
}

async function settleMint(store, ledger, record, seed) {
  const key = record.attempts.at(-1)
  const attempt = await submitJournaled(store, ledger, key, mintTransaction(store.state, record), seed)
  if (attempt.status === 'expired' || resultCode(attempt.result) !== 'tesSUCCESS') {
    record.status = 'failed'
    record.reason =
      attempt.status === 'expired'
        ? 'Transaction definitively expired'
        : resultCode(attempt.result) || 'Unexpected transaction result'
  } else {
    // A success with an unexpected delivery must never be automatically retried.
    try {
      assertDelivered(attempt.result, store.state.yusd, record.yusdAmount)
    } catch (error) {
      record.status = 'review'
      record.reason = error.message
      store.state.paused = true
      store.save()
      throw error
    }
    record.status = 'minted'
    record.mintHash = attempt.hash
    record.mintLedger = attempt.result.ledger_index
    delete record.reason
  }
  store.save()
}

export async function runOnce(store, ledger, seed) {
  const state = store.state
  if (!state.ready) throw new Error('Run setup before starting the worker')
  // Finish uncertain signatures before any new issuer sequence can be allocated.
  for (const record of Object.values(state.deposits)) {
    if (record.status === 'submitting') await settleMint(store, ledger, record, seed)
  }
  const latest = await ledger.index()
  if (latest < state.cursor) throw new Error('Ledger moved behind saved cursor; possible Testnet reset')
  if (latest > state.cursor) {
    // Bounded windows make long offline catch-up incremental. Commit only after all pages.
    const through = Math.min(latest, state.cursor + 1000)
    for (const entry of await ledger.history(state.market, state.cursor + 1, through)) ingest(state, entry)
    state.cursor = through
    store.save()
  }
  for (const record of Object.values(state.deposits)) {
    if (!['pending', 'blocked'].includes(record.status)) continue
    const reason = await preflight(state, ledger, record)
    if (reason) {
      record.status = 'blocked'
      record.reason = reason
      store.save()
      continue
    }
    const key = `mint:${record.hash}:${record.attempts.length}`
    // Signing occurs before the transition is saved, but submission occurs only after it.
    const attempt = await ledger.prepare(mintTransaction(state, record), seed)
    state.operations[key] = attempt
    record.attempts.push(key)
    record.status = 'submitting'
    delete record.reason
    store.save()
    await settleMint(store, ledger, record, seed)
  }
}

export function retryMint(store, hash) {
  const record = store.state.deposits[hash]
  if (!record || record.status !== 'failed') throw new Error('Only a definitively failed/expired mint can be retried')
  const attempt = store.state.operations[record.attempts.at(-1)]
  if (
    !attempt ||
    (attempt.status !== 'expired' && (attempt.status !== 'validated' || resultCode(attempt.result) === 'tesSUCCESS'))
  )
    throw new Error('Prior attempt has no definitive failure')
  record.status = 'pending'
  delete record.reason
  store.save()
}
