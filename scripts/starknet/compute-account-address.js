/**
 * Compute Starknet OZ account address from your existing EVM private key.
 *
 * The private key scalar works on both secp256k1 (EVM) and the Stark curve —
 * sncast/starknet.js will derive a different public key (different curve) but
 * the same private key number is used.
 *
 * Usage:
 *   source .env && node scripts/starknet/compute-account-address.js
 *
 * Then fund the printed address with ETH on Starknet and run:
 *   sncast account import --name yusd-deployer --type open_zeppelin \
 *     --url https://starknet.drpc.org \
 *     --address <ADDRESS> --private-key $PRIVATE_KEY
 *   sncast account deploy --name yusd-deployer --url https://starknet.drpc.org --fee-token eth
 */

require('dotenv').config()
const { ec, hash } = require('starknet')

const PRIVATE_KEY = process.env.PRIVATE_KEY
if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY env var is required')

// OZ account class hash used by sncast (OpenZeppelin v0.8.x)
const OZ_CLASS_HASH = '0x061dac032f228abef9c6626f995015233097ae253a7f72d68552db02f2971b8f'

// grindKey reduces the EVM key into the valid Stark curve range (same method Argent/Braavos use)
const starkPrivateKey = '0x' + ec.starkCurve.grindKey(PRIVATE_KEY)
const starkKey = ec.starkCurve.getStarkKey(starkPrivateKey)
const address = hash.calculateContractAddressFromHash(
  starkKey,      // salt = public key (sncast default)
  OZ_CLASS_HASH,
  [starkKey],    // constructor calldata: publicKey
  0              // deployer address = 0
)

console.log(`Stark private key:  ${starkPrivateKey}`)
console.log(`Public key (Stark): ${starkKey}`)
console.log(`Account address:    ${address}`)
console.log('')
console.log('Add to .env:')
console.log(`  STARKNET_PRIVATE_KEY=${starkPrivateKey}`)
console.log(`  STARKNET_ACCOUNT_ADDRESS=${address}`)
console.log('')
console.log('Then fund the address with ETH on Starknet and run:')
console.log(`  node scripts/starknet/deploy-account.js`)
