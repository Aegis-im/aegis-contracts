/**
 * Transfer STRK from deployer account to another address.
 *
 * Usage:
 *   node scripts/starknet/transfer-strk.js <recipient> <amount_in_strk>
 *
 * Example:
 *   node scripts/starknet/transfer-strk.js 0x0525b... 1.5
 *
 * Required env vars (loaded from .env automatically):
 *   STARKNET_PRIVATE_KEY      — deployer Stark private key
 *   STARKNET_ACCOUNT_ADDRESS  — deployer account address
 */

require('dotenv').config()
const { Account, RpcProvider } = require('starknet')
const networksConfig = require('../../config/networks.json')

const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d'
const STRK_DECIMALS = 18n

const RPC_URL        = process.env.STARKNET_RPC_URL || networksConfig.networks.starknet.rpcUrl
const starkPrivateKey = process.env.STARKNET_PRIVATE_KEY
const accountAddress  = process.env.STARKNET_ACCOUNT_ADDRESS

const recipient = process.argv[2]
const amountArg = process.argv[3]

if (!starkPrivateKey)  throw new Error('STARKNET_PRIVATE_KEY is required')
if (!accountAddress)   throw new Error('STARKNET_ACCOUNT_ADDRESS is required')
if (!recipient)        throw new Error('Usage: node transfer-strk.js <recipient> <amount_in_strk>')
if (!amountArg)        throw new Error('Usage: node transfer-strk.js <recipient> <amount_in_strk>')

// Parse decimal amount → raw u256 (split into low/high u128)
const [whole, frac = ''] = amountArg.split('.')
const fracPadded = frac.slice(0, 18).padEnd(18, '0')
const raw = BigInt(whole) * (10n ** STRK_DECIMALS) + BigInt(fracPadded)
const low  = '0x' + (raw & ((1n << 128n) - 1n)).toString(16)
const high = '0x' + (raw >> 128n).toString(16)

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL })
  const account  = new Account({ provider, address: accountAddress, signer: starkPrivateKey })

  console.log(`Sending ${amountArg} STRK`)
  console.log(`  From: ${accountAddress}`)
  console.log(`  To:   ${recipient}`)
  console.log(`  Raw:  ${raw.toString()} (low=${low}, high=${high})`)
  console.log('')

  const tx = await account.execute([{
    contractAddress: STRK_TOKEN,
    entrypoint: 'transfer',
    calldata: [recipient, low, high],
  }])

  console.log(`Tx: ${tx.transaction_hash}`)
  process.stdout.write('Waiting for confirmation...')
  await provider.waitForTransaction(tx.transaction_hash)
  console.log(' done')
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
