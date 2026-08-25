/**
 * Deploy Starknet OZ account contract (STRK fees, V3 tx).
 *
 * Usage:
 *   node scripts/starknet/deploy-account.js
 */

require('dotenv').config()
const { Account, RpcProvider, ec, hash } = require('starknet')
const networksConfig = require('../../config/networks.json')

const OZ_CLASS_HASH = '0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f'
const RPC_URL = process.env.STARKNET_RPC_URL || networksConfig.networks.starknet.rpcUrl

const starkPrivateKey = process.env.STARKNET_PRIVATE_KEY
if (!starkPrivateKey) throw new Error('STARKNET_PRIVATE_KEY env var is required')

const starkPublicKey = ec.starkCurve.getStarkKey(starkPrivateKey)
const address = hash.calculateContractAddressFromHash(
  starkPublicKey,
  OZ_CLASS_HASH,
  [starkPublicKey],
  0
)

console.log(`Address:    ${address}`)
console.log(`Public key: ${starkPublicKey}`)
console.log('')

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL, blockIdentifier: 'latest' })
  const account  = new Account({ provider, address, signer: starkPrivateKey })

  console.log('Deploying account (STRK fees)...')
  const { transaction_hash } = await account.deployAccount({
    classHash: OZ_CLASS_HASH,
    constructorCalldata: [starkPublicKey],
    addressSalt: starkPublicKey,
  })

  console.log(`Tx: ${transaction_hash}`)
  console.log('Waiting for confirmation...')
  await provider.waitForTransaction(transaction_hash)
  console.log('Account deployed!')
  console.log(`\nAdd to .env:\n  STARKNET_ACCOUNT_ADDRESS=${address}`)
}

main().catch(err => {
  console.error('Error:', err.message || err)
  process.exit(1)
})
