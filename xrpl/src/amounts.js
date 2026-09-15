// Fixed six-decimal business precision. Never pass token amounts through Number.
export const SCALE = 1_000_000n
export const MAX_UNITS = 1_000_000_000n * SCALE

export function units(value, { signed = false } = {}) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Amount must be a decimal string')
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value)
  if (!match || (match[1] && !signed)) throw new Error('Invalid amount')
  const exponent = Number(match[4] || 0)
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) throw new Error('Amount exponent out of range')
  const digits = BigInt(match[2] + (match[3] || ''))
  const shift = 6 + exponent - (match[3] || '').length
  if (shift < 0 && digits % 10n ** BigInt(-shift) !== 0n) throw new Error('Amount exceeds six decimal places')
  const result = shift >= 0 ? digits * 10n ** BigInt(shift) : digits / 10n ** BigInt(-shift)
  if (result > MAX_UNITS) throw new Error('Amount exceeds testnet limit')
  return match[1] ? -result : result
}

export function decimal(value) {
  const sign = value < 0n ? '-' : ''
  const n = value < 0n ? -value : value
  const fraction = (n % SCALE).toString().padStart(6, '0').replace(/0+$/, '')
  return `${sign}${n / SCALE}${fraction ? `.${fraction}` : ''}`
}

export function positive(value) {
  const n = units(value)
  if (n <= 0n) throw new Error('Amount must be positive')
  return decimal(n)
}
