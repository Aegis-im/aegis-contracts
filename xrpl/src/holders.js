import { isValidClassicAddress } from 'xrpl'

// Holder balances are not constrained to the mint service's six-decimal input policy.
// Preserve the ledger's decimal strings, including exponent notation, without Number conversion.
export async function holderSnapshot(client, issuer, currency) {
  if (!isValidClassicAddress(issuer)) throw new Error('A classic XRPL issuer address is required')
  const { result: ledger } = await client.request({ command: 'ledger', ledger_index: 'validated', transactions: false })
  if (
    ledger.validated !== true ||
    !Number.isSafeInteger(ledger.ledger_index) ||
    !/^[A-F0-9]{64}$/.test(ledger.ledger_hash || '')
  ) {
    throw new Error('Cannot establish a validated holder snapshot')
  }
  const holders = []
  const seenAccounts = new Set()
  const seenMarkers = new Set()
  let marker
  do {
    const { result } = await client.request({
      command: 'account_lines',
      account: issuer,
      ledger_hash: ledger.ledger_hash,
      ignore_default: false,
      limit: 400,
      ...(marker !== undefined ? { marker } : {}),
    })
    if (
      result.validated !== true ||
      result.ledger_hash !== ledger.ledger_hash ||
      result.account !== issuer ||
      !Array.isArray(result.lines)
    ) {
      throw new Error('Inconsistent holder page; refusing an incomplete snapshot')
    }
    for (const line of result.lines) {
      if (line.currency !== currency) continue
      if (!isValidClassicAddress(line.account) || seenAccounts.has(line.account))
        throw new Error('Invalid or duplicate holder trust line')
      seenAccounts.add(line.account)
      if (typeof line.balance !== 'string' || !/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(line.balance))
        throw new Error('Invalid trust-line balance')
      // From the issuer's perspective, a negative balance is YUSD owed to the holder.
      // Zero-balance trust lines and positive balances owed TO the issuer are not holders.
      if (!line.balance.startsWith('-') || !/[1-9]/.test(line.balance.split(/[eE]/)[0])) continue
      holders.push({ address: line.account, balance: line.balance.slice(1) })
    }
    marker = result.marker ?? undefined
    if (marker !== undefined) {
      const key = JSON.stringify(marker)
      if (seenMarkers.has(key)) throw new Error('Repeated holder pagination marker')
      seenMarkers.add(key)
    }
  } while (marker !== undefined)
  holders.sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : 0))
  return {
    issuer,
    currency,
    ledger: ledger.ledger_index,
    ledgerHash: ledger.ledger_hash,
    holderCount: holders.length,
    holders,
  }
}
