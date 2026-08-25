/**
 * Transfer Starknet YUSD ownership and admin roles to multisig.
 *
 * What it does:
 *   1. ERC20: grant DEFAULT_ADMIN_ROLE to multisig
 *   2. ERC20: deployer renounces DEFAULT_ADMIN_ROLE
 *   3. OFT:   set_delegate(multisig)  — transfers LZ config authority
 *   4. OFT:   transfer_ownership(multisig)
 *
 * Usage:
 *   STARKNET_MULTISIG_ADDRESS=0x... node scripts/starknet/transfer-ownership-starknet.js
 *
 * Required env vars (loaded from .env automatically):
 *   STARKNET_PRIVATE_KEY       — deployer Stark private key
 *   STARKNET_ACCOUNT_ADDRESS   — deployer account address
 *   STARKNET_MULTISIG_ADDRESS  — target multisig address (or pass as first arg)
 */

require('dotenv').config()
const { Account, RpcProvider } = require('starknet')
const networksConfig = require('../../config/networks.json')

const RPC_URL          = process.env.STARKNET_RPC_URL || networksConfig.networks.starknet.rpcUrl
const starkPrivateKey  = process.env.STARKNET_PRIVATE_KEY
const accountAddress   = process.env.STARKNET_ACCOUNT_ADDRESS
const multisig         = process.argv[2] || process.env.STARKNET_MULTISIG_ADDRESS

const ERC20_ADDRESS    = networksConfig.networks.starknet.contracts.yusdERC20Address
const OFT_ADDRESS      = networksConfig.networks.starknet.contracts.yusdOftAddress
const DEFAULT_ADMIN_ROLE = '0x0'

if (!starkPrivateKey)  throw new Error('STARKNET_PRIVATE_KEY is required')
if (!accountAddress)   throw new Error('STARKNET_ACCOUNT_ADDRESS is required')
if (!multisig)         throw new Error('STARKNET_MULTISIG_ADDRESS is required (env or first arg)')
if (!ERC20_ADDRESS)    throw new Error('yusdERC20Address not set in config/networks.json')
if (!OFT_ADDRESS)      throw new Error('yusdOftAddress not set in config/networks.json')

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL })
  const account  = new Account({ provider, address: accountAddress, signer: starkPrivateKey })

  console.log('🔑 Transferring Starknet YUSD ownership to multisig')
  console.log(`   Deployer:  ${accountAddress}`)
  console.log(`   Multisig:  ${multisig}`)
  console.log(`   ERC20:     ${ERC20_ADDRESS}`)
  console.log(`   OFT:       ${OFT_ADDRESS}`)
  console.log('')

  async function invoke(label, contractAddress, entrypoint, calldata) {
    process.stdout.write(`  ${label}... `)
    const tx = await account.execute([{ contractAddress, entrypoint, calldata }])
    console.log(`Tx: ${tx.transaction_hash}`)
    await provider.waitForTransaction(tx.transaction_hash)
  }

  // 1. Grant DEFAULT_ADMIN_ROLE on ERC20 to multisig
  await invoke(
    'ERC20 grant DEFAULT_ADMIN_ROLE → multisig',
    ERC20_ADDRESS, 'grant_role', [DEFAULT_ADMIN_ROLE, multisig]
  )

  // 2. Deployer renounces DEFAULT_ADMIN_ROLE on ERC20
  await invoke(
    'ERC20 renounce DEFAULT_ADMIN_ROLE (deployer)',
    ERC20_ADDRESS, 'renounce_role', [DEFAULT_ADMIN_ROLE, accountAddress]
  )

  // 3. Set multisig as LZ delegate on OFT (and endpoint)
  await invoke(
    'OFT set_delegate → multisig',
    OFT_ADDRESS, 'set_delegate', [multisig]
  )

  // 4. Transfer OFT ownership to multisig
  await invoke(
    'OFT transfer_ownership → multisig',
    OFT_ADDRESS, 'transfer_ownership', [multisig]
  )

  console.log('')
  console.log('✅ Ownership transferred successfully')
  console.log(`   Multisig ${multisig} now controls:`)
  console.log('   - ERC20 DEFAULT_ADMIN_ROLE (can grant/revoke MINTER/BURNER)')
  console.log('   - OFT ownership + LZ delegate (can update peers, DVNs, options)')
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
