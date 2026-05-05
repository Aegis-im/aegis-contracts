/**
 * Wire YUSD OFTMintBurnAdapter on Starknet to Ethereum Mainnet
 *
 * Performs on Starknet side:
 *   1. set_peer       — register Ethereum mainnet adapter as the peer
 *   2. set_send_configs    — configure DVNs + executor for sending
 *   3. set_receive_configs — configure DVNs + executor for receiving
 *   4. set_enforced_options — set minimum gas for lzReceive on this chain
 *   5. set_delegate   — set deployer as LZ delegate (so config can be changed)
 *
 * Prerequisites:
 *   npm install starknet   (once-off)
 *
 * Required env vars (source .env first):
 *   STARKNET_PRIVATE_KEY        — Stark private key (from compute-account-address.js output)
 *   STARKNET_ACCOUNT_ADDRESS   — deployed Starknet account contract address
 *   STARKNET_YUSD_OFT_ADDRESS  — OFTMintBurnAdapter address from deploy script
 *   STARKNET_RPC_URL           — optional, defaults to public endpoint
 *
 * Usage:
 *   source .env && node scripts/starknet/wire-starknet-yusd.js
 */

require('dotenv').config()
const { RpcProvider, Account } = require('starknet')
const networksConfig = require('../../config/networks.json')

// ─── Starknet Mainnet constants ───────────────────────────────────────────────
const LZ_ENDPOINT  = '0x0524e065abff21d225fb7b28f26ec2f48314ace6094bc085f0a7cf1dc2660f68'
const ULN302       = '0x0727f40349719ac76861a51a0b3d3e07be1577fff137bb81a5dc32e5a5c61d38'
const EXECUTOR     = '0x03887bd8da2999d39e2e88fe55733c4cac8e20a6d51bfe162176c9f2eb134c65'

// Required DVNs — sorted ascending (required by ULN config validation)
const REQUIRED_DVNS = [
  '0x02fff0fb1d28dae06f80120e17a26d23803234dd27d4b275f7742c97ecbfb3f5', // Deutsche Telekom
  '0x067ba9b8e08d78e4600871db457f9620c56c39915167d32b0581a7fb639866dd', // LayerZero Labs
  '0x067f770461867f3634a7f836e96e4f6649c4bbe6972b70e2838b9590e0828e63', // Horizen
  '0x073b30c6cf0094ca96976a6fa8c656d84f7ba88b4edfd068adf9ec0613a91982', // Canary
]

// ─── Ethereum mainnet peer ────────────────────────────────────────────────────
const MAINNET_EID     = 30101
const MAINNET_ADAPTER = '0xAF12b0Ae5A72D7b8A8eC675f3E76E2Db56143565'

// Confirmations matching existing EVM config
const CONFIRMATIONS = 20

// Gas for lzReceive on Starknet (executor will ensure at least this much)
const LZ_RECEIVE_GAS = 200000

// ─── Calldata helpers ─────────────────────────────────────────────────────────

// Convert EVM address to Bytes32 calldata [high_u128, low_u128]
// bytes32 = 0x000000000000000000000000<20-byte-address>
function evmAddressToBytes32Calldata(evmAddr) {
  const clean = evmAddr.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
  const high = '0x' + clean.slice(0, 32)
  const low  = '0x' + clean.slice(32)
  return [high, low]
}

// Encode lzReceive enforced options as Cairo ByteArray calldata
// Options bytes: 0x0003010021 01 <gas_16bytes> <value_16bytes>
function encodeLzReceiveOptionsByteArray(gas) {
  const gasHex = BigInt(gas).toString(16).padStart(32, '0')
  const valueHex = '0'.repeat(32)
  const optionsHex = '000301002101' + gasHex + valueHex  // 76 hex chars = 38 bytes

  // Split into 31-byte chunks for Cairo ByteArray
  const chunk1 = optionsHex.slice(0, 62)   // first 31 bytes
  const pending = optionsHex.slice(62)      // remaining 7 bytes

  return [
    '1',           // data.len = 1 full chunk
    '0x' + chunk1, // data[0] as felt252
    '0x' + (pending === '00000000000000' ? '0' : pending.replace(/^0+/, '') || '0'),  // pending_word
    '7',           // pending_word_len
  ]
}

// Encode UlnConfig as Array<felt252> calldata (with length prefix)
function encodeUlnConfig(confirmations, requiredDvns) {
  const config = [
    String(confirmations), // confirmations: u64
    '1',                   // has_confirmations: bool
    String(requiredDvns.length), // required_dvns.len
    ...requiredDvns,             // required_dvns addresses
    '1',                   // has_required_dvns: bool
    '0',                   // optional_dvns.len
    '0',                   // optional_dvn_threshold: u8
    '0',                   // has_optional_dvns: bool
  ]
  return [String(config.length), ...config]  // Array<felt252> with length prefix
}

// Encode ExecutorConfig as Array<felt252> calldata (with length prefix)
function encodeExecutorConfig(executor) {
  const config = ['10000', executor]  // max_message_size, executor address
  return [String(config.length), ...config]
}

// Build set_send_configs calldata — ULN + Executor
function buildSendConfigsCalldata(oftAddress, eid, confirmations, requiredDvns, executor) {
  const ulnConfig  = encodeUlnConfig(confirmations, requiredDvns)
  const execConfig = encodeExecutorConfig(executor)
  return [
    oftAddress,
    ULN302,
    '2',                 // params.len = 2 (ULN + Executor)
    String(eid), '2', ...ulnConfig,
    String(eid), '1', ...execConfig,
  ]
}

// Build set_receive_configs calldata — ULN only (executor config not valid for receive)
function buildReceiveConfigsCalldata(oftAddress, eid, confirmations, requiredDvns) {
  const ulnConfig = encodeUlnConfig(confirmations, requiredDvns)
  return [
    oftAddress,
    ULN302,
    '1',                 // params.len = 1 (ULN only)
    String(eid), '2', ...ulnConfig,
  ]
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const rpcUrl = process.env.STARKNET_RPC_URL || networksConfig.networks.starknet.rpcUrl
  const starkPrivateKey = process.env.STARKNET_PRIVATE_KEY
  const accountAddress = process.env.STARKNET_ACCOUNT_ADDRESS

  if (!starkPrivateKey)  throw new Error('STARKNET_PRIVATE_KEY env var is required')
  if (!accountAddress)   throw new Error('STARKNET_ACCOUNT_ADDRESS env var is required')

  // Read OFT address from env or networks.json
  let oftAddress = process.env.STARKNET_YUSD_OFT_ADDRESS
    || networksConfig?.networks?.starknet?.contracts?.yusdOftAddress
  if (!oftAddress) {
    throw new Error(
      'OFT address not found. Set STARKNET_YUSD_OFT_ADDRESS env var or add ' +
      'networks.starknet.contracts.yusdOftAddress to config/networks.json'
    )
  }

  console.log('🔌 Wiring YUSD OFTMintBurnAdapter on Starknet...')
  console.log(`   RPC:     ${rpcUrl}`)
  console.log(`   Account: ${accountAddress}`)
  console.log(`   OFT:     ${oftAddress}`)
  console.log(`   Peer:    Ethereum mainnet (EID ${MAINNET_EID}) → ${MAINNET_ADAPTER}`)
  console.log('')

  const provider = new RpcProvider({ nodeUrl: rpcUrl })
  const account  = new Account({ provider, address: accountAddress, signer: starkPrivateKey })

  async function invoke(contractAddress, entrypoint, calldata) {
    const tx = await account.execute([{ contractAddress, entrypoint, calldata }])
    console.log(`   Tx: ${tx.transaction_hash}`)
    await provider.waitForTransaction(tx.transaction_hash)
  }

  // 1. set_delegate — must be first so deployer is authorized on the endpoint
  process.stdout.write('  set_delegate... ')
  await invoke(oftAddress, 'set_delegate', [accountAddress])

  // 2. set_peer
  process.stdout.write('  set_peer... ')
  await invoke(oftAddress, 'set_peer', [String(MAINNET_EID), ...evmAddressToBytes32Calldata(MAINNET_ADAPTER)])

  // 3. set_send_configs (ULN + Executor)
  process.stdout.write('  set_send_configs... ')
  await invoke(LZ_ENDPOINT, 'set_send_configs', buildSendConfigsCalldata(oftAddress, MAINNET_EID, CONFIRMATIONS, REQUIRED_DVNS, EXECUTOR))

  // 4. set_receive_configs (ULN only)
  process.stdout.write('  set_receive_configs... ')
  await invoke(LZ_ENDPOINT, 'set_receive_configs', buildReceiveConfigsCalldata(oftAddress, MAINNET_EID, CONFIRMATIONS, REQUIRED_DVNS))

  // 5. set_enforced_options
  process.stdout.write('  set_enforced_options... ')
  const optionsByteArray = encodeLzReceiveOptionsByteArray(LZ_RECEIVE_GAS)
  await invoke(oftAddress, 'set_enforced_options', ['1', String(MAINNET_EID), '1', ...optionsByteArray])

  console.log('')
  console.log('🎉 Starknet side wired successfully!')
  console.log('')
  console.log('📋 Next step:')
  console.log('   Generate mainnet multisig tx to setPeer on the Ethereum adapter:')
  console.log('     node scripts/jusd/generate-multisig-wire-txs.js')
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
