/**
 * check-dvn-setup.js
 *
 * Queries on-chain DVN configuration for YUSD OFT contracts across all networks.
 * Reads lzEndpoint and rpcUrl from config/networks.json.
 * Checks both send and receive ULN config for each chain pair.
 *
 * Usage (from aegis-contracts/):
 *   node scripts/jusd/check-dvn-setup.js
 */

const ethers = require('ethers')
const path = require('path')

const networks = require(path.join(__dirname, '../../config/networks.json')).networks

// Network key → LZ endpoint ID (not in networks.json for all chains)
const CHAIN_CONFIG = {
  mainnet:    { eid: 30101, oftKey: 'oftAdapterAddress' },
  bnbMainnet: { eid: 30102, oftKey: 'oftAdapterAddress' },
  avalanche:  { eid: 30106, oftKey: 'yusdOftAddress' },
  arbitrum:   { eid: 30110, oftKey: 'yusdOftAddress' },
  base:       { eid: 30184, oftKey: 'yusdOftAddress' },
  plasma:     { eid: 30383, oftKey: 'yusdOftAddress' },
  katana:     { eid: 30375, oftKey: 'yusdOftAddress' },
  monad:      { eid: 30390, oftKey: 'yusdOftAddress' },
}

const CHAINS = Object.entries(CHAIN_CONFIG).map(([key, { eid, oftKey }]) => {
  const net = networks[key]
  return {
    name: key,
    eid,
    oapp: net.contracts[oftKey],
    lzEndpoint: net.contracts.lzEndpoint,
    rpc: net.rpcUrl,
  }
})

// Known DVN addresses → human-readable names
const DVN_NAMES = {
  '0x589dedbd617e0cbcb916a9223f4d1300c294236b': 'LayerZero Labs',
  '0x7fe673201724925b5c477d4e1a4bd3e954688cf5': 'Canary',
  '0x380275805876ff19055ea900cdb2b46a94ecf20d': 'Deutsche Telekom',
  '0xa4fe5a5b9a846458a70cd0748228aed3bf65c2cd': 'Horizen',
  '0x373a6e5c0c4e89e24819f00aa37ea370917aaff4': 'Nethermind',
  '0xd56e4eab23cb81f43168f9f45211eb027b9ac7cc': 'P2P',
  '0xa59ba433ac34d2927232918ef5b2eaafcf130ba5': 'Luganodes',
}

const ENDPOINT_ABI = [
  'function getSendLibrary(address sender, uint32 dstEid) external view returns (address lib)',
  'function getReceiveLibrary(address receiver, uint32 srcEid) external view returns (address lib, bool isDefault)',
  'function getConfig(address oapp, address lib, uint32 eid, uint32 configType) external view returns (bytes memory config)',
]

const ULN_CONFIG_TYPE = 2
const abiCoder = ethers.AbiCoder.defaultAbiCoder()

function decodeUlnConfig(encoded) {
  if (!encoded || encoded === '0x') return null
  const [[confirmations, requiredDVNCount, optionalDVNCount, optionalDVNThreshold, requiredDVNs, optionalDVNs]] =
    abiCoder.decode(
      ['tuple(uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)'],
      encoded
    )
  return { confirmations: confirmations.toString(), requiredDVNCount, optionalDVNCount, optionalDVNThreshold, requiredDVNs, optionalDVNs }
}

function formatDVN(addr) {
  const name = DVN_NAMES[addr.toLowerCase()]
  return name ? `${name} (${addr})` : addr
}

function formatUlnConfig(config, label) {
  const lines = [`    ${label} — confirmations: ${config.confirmations}`]
  lines.push(`      required (${config.requiredDVNCount}): ${config.requiredDVNs.map(formatDVN).join(', ') || 'none'}`)
  if (config.optionalDVNCount > 0)
    lines.push(`      optional (${config.optionalDVNThreshold}/${config.optionalDVNCount}): ${config.optionalDVNs.map(formatDVN).join(', ')}`)
  return lines.join('\n')
}

function makeProvider(rpc) {
  const req = new ethers.FetchRequest(rpc)
  req.timeout = 8000
  return new ethers.JsonRpcProvider(req)
}

async function checkChain(srcChain) {
  const provider = makeProvider(srcChain.rpc)
  const endpoint = new ethers.Contract(srcChain.lzEndpoint, ENDPOINT_ABI, provider)

  const dstChains = CHAINS.filter(c => c.eid !== srcChain.eid)

  const results = await Promise.allSettled(
    dstChains.map(async dstChain => {
      const [sendLib, [recvLib]] = await Promise.all([
        endpoint.getSendLibrary(srcChain.oapp, dstChain.eid),
        endpoint.getReceiveLibrary(srcChain.oapp, dstChain.eid),
      ])
      const [sendRaw, recvRaw] = await Promise.all([
        endpoint.getConfig(srcChain.oapp, sendLib, dstChain.eid, ULN_CONFIG_TYPE),
        endpoint.getConfig(srcChain.oapp, recvLib, dstChain.eid, ULN_CONFIG_TYPE),
      ])
      return { dstChain, sendLib, recvLib, sendConfig: decodeUlnConfig(sendRaw), recvConfig: decodeUlnConfig(recvRaw) }
    })
  )

  console.log(`\n${'═'.repeat(72)}`)
  console.log(`${srcChain.name.toUpperCase()} (eid ${srcChain.eid})  endpoint: ${srcChain.lzEndpoint}`)
  console.log(`  oapp: ${srcChain.oapp}`)
  console.log('═'.repeat(72))

  for (let i = 0; i < dstChains.length; i++) {
    const dstChain = dstChains[i]
    const result = results[i]
    console.log(`\n  → ${dstChain.name} (eid ${dstChain.eid})`)

    if (result.status === 'rejected') {
      const msg = result.reason?.shortMessage || result.reason?.message || String(result.reason)
      let label = msg
      if (msg.includes('revert')) label = 'pathway not registered on-chain'
      else if (msg.includes('decode')) label = 'LZ endpoint not deployed at expected address on this chain'
      console.log(`    ⚠  ${label}`)
      continue
    }

    const { sendLib, recvLib, sendConfig, recvConfig } = result.value
    console.log(`    send lib: ${sendLib}`)
    console.log(sendConfig ? formatUlnConfig(sendConfig, 'SEND') : '    SEND — (default lib config, no override)')
    console.log(`    recv lib: ${recvLib}`)
    console.log(recvConfig ? formatUlnConfig(recvConfig, 'RECV') : '    RECV — (default lib config, no override)')
  }
}

async function main() {
  console.log('Checking on-chain DVN setup for YUSD OFTs...')
  for (const chain of CHAINS) {
    await checkChain(chain)
  }
  console.log(`\n${'═'.repeat(72)}\nDone.\n`)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
