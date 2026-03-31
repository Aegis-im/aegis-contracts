/**
 * Generates setPeer + setEnforcedOptions calldata for multisig-owned OFT contracts
 * that are NOT yet wired on-chain.
 *
 * Monad contracts (deployer-owned) were already wired via `yarn wire`.
 * ALL other chains are owned by multisig 0x4Fe78eF65BD8EDDED480efaB030BA680646503c8.
 *
 * Safe-supported (use Safe Transaction Builder):
 *   Mainnet (1), BSC (56), Avalanche (43114), Arbitrum (42161), Base (8453)
 *
 * Manual execution needed (no Safe TX service):
 *   Plasma (9745), Katana (747474)
 *
 * Usage: node scripts/jusd/generate-multisig-wire-txs.js
 */

const ethers = require('ethers')
const fs = require('fs')
const path = require('path')

// ─── EIDs ─────────────────────────────────────────────────────────────────────
const EID = {
  mainnet:   30101,
  bnb:       30102,
  avalanche: 30106,
  arbitrum:  30110,
  base:      30184,
  plasma:    30383,
  katana:    30375,
  monad:     30390,
}

// ─── Chain IDs ────────────────────────────────────────────────────────────────
const CHAIN_ID = {
  mainnet:   1,
  bnb:       56,
  avalanche: 43114,
  arbitrum:  42161,
  base:      8453,
  plasma:    9745,
  katana:    747474,
}

// ─── RPC URLs (public endpoints, no key required) ─────────────────────────────
const RPC = {
  [CHAIN_ID.mainnet]:   process.env.MAINNET_RPC_URL   || 'https://mainnet.gateway.tenderly.co',
  [CHAIN_ID.bnb]:       process.env.BSC_MAINNET_RPC_URL || 'https://bsc-rpc.publicnode.com',
  [CHAIN_ID.avalanche]: process.env.AVALANCHE_MAINNET_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
  [CHAIN_ID.arbitrum]:  process.env.ARBITRUM_MAINNET_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  [CHAIN_ID.base]:      process.env.BASE_MAINNET_RPC_URL || 'https://base.llamarpc.com',
  [CHAIN_ID.plasma]:    process.env.PLASMA_MAINNET_RPC_URL || 'https://rpc.plasma.to',
  [CHAIN_ID.katana]:    process.env.KATANA_MAINNET_RPC_URL || 'https://rpc.katana.network/',
}

// ─── Contract addresses ───────────────────────────────────────────────────────
const ADDR = {
  // Mainnet
  mainnet_YUSD:   '0xAF12b0Ae5A72D7b8A8eC675f3E76E2Db56143565', // YUSDMintBurnOFTAdapter
  mainnet_sYUSD:  '0x1a7cde558d318052add800ca30dc7464920b41fc', // sYUSDOFTAdapter
  mainnet_JUSD:   '0x70d4C4F48F230037A9e154470EcE79Db85A11f52', // JUSDMintBurnOFTAdapter
  mainnet_sJUSD:  '0x8EDD6A7C9b635490f4a94E0cb85D63d6A084ce0F', // sJUSDOFTAdapter

  // BSC
  bnb_YUSD:       '0x539e46827c37A3ef11c7cE521CC56B4d59E602e3', // YUSDMintBurnOFTAdapter
  bnb_sYUSD:      '0x85636BF94EA95c32e945b0db30A7CDc614F2691e',

  // Avalanche
  avax_YUSD:      '0xca2671Dcd031a72359f456C212F62A9bDa737cD7',
  avax_sYUSD:     '0x539e46827c37A3ef11c7cE521CC56B4d59E602e3',

  // Arbitrum
  arb_YUSD:       '0xF07781182B47e728B040f9e35321260e359fF9f7',

  // Base
  base_YUSD:      '0xca2671Dcd031a72359f456C212F62A9bDa737cD7',

  // Plasma
  plasma_YUSD:    '0xF07781182B47e728B040f9e35321260e359fF9f7',
  plasma_sYUSD:   '0xca2671Dcd031a72359f456C212F62A9bDa737cD7',

  // Katana
  katana_YUSD:    '0xca2671Dcd031a72359f456C212F62A9bDa737cD7',
  katana_sYUSD:   '0xFCeF626dE4A0175ac962DD43EB0A002819FaAEFe',
  katana_JUSD:    '0xAF12b0Ae5A72D7b8A8eC675f3E76E2Db56143565',
  katana_sJUSD:   '0x773B65dfF82a5C49eC4002bb886b2FB4623071B4',

  // Monad (already wired, used as peer targets only)
  monad_YUSD:     '0xca2671Dcd031a72359f456C212F62A9bDa737cD7',
  monad_sYUSD:    '0xF07781182B47e728B040f9e35321260e359fF9f7',
  monad_JUSD:     '0x7C94288E79F6De6E9Baf2e5029CB94CFf032fd69',
  monad_sJUSD:    '0xCFA67e9Da72af570e7f8344B7738D6BdF698BD20',
}

// ─── Gas limits per destination EID ──────────────────────────────────────────
const GAS = {
  [EID.mainnet]:   100000,
  [EID.bnb]:        80000,
  [EID.avalanche]: 120000,
  [EID.arbitrum]:   80000,
  [EID.katana]:     80000,
  [EID.base]:       80000,
  [EID.plasma]:     80000,
  [EID.monad]:      80000,
}

// ─── ABI ──────────────────────────────────────────────────────────────────────
const OFT_ABI = [
  'function peers(uint32 _eid) view returns (bytes32)',
  'function enforcedOptions(uint32 _eid, uint16 _msgType) view returns (bytes)',
  'function setPeer(uint32 _eid, bytes32 _peer)',
  'function setEnforcedOptions(tuple(uint32 dstEid, uint16 msgType, bytes options)[] calldata _enforcedOptions)',
]

const iface = new ethers.Interface(OFT_ABI)

function addressToBytes32(addr) {
  return ethers.zeroPadValue(addr.toLowerCase(), 32)
}

function encodeLzReceiveOptions(gas) {
  const gasHex = ethers.zeroPadValue(ethers.toBeHex(gas), 16).slice(2)
  const valueHex = '0'.repeat(32)
  return '0x0003010021' + '01' + gasHex + valueHex
}

// ─── On-chain check helpers ───────────────────────────────────────────────────
const providers = {}
function getProvider(chainId) {
  if (!providers[chainId]) {
    providers[chainId] = new ethers.JsonRpcProvider(RPC[chainId])
  }
  return providers[chainId]
}

async function isPeerAlreadySet(chainId, contractAddr, dstEid, expectedPeerAddr) {
  try {
    const provider = getProvider(chainId)
    const contract = new ethers.Contract(contractAddr, OFT_ABI, provider)
    const currentPeer = await contract.peers(dstEid)
    const expectedPeer = addressToBytes32(expectedPeerAddr)
    return currentPeer.toLowerCase() === expectedPeer.toLowerCase()
  } catch (err) {
    console.warn(`  ⚠ Failed to check peer for ${contractAddr} on chain ${chainId} (eid ${dstEid}): ${err.message}`)
    return false // If we can't check, include the tx to be safe
  }
}

async function isEnforcedOptionsAlreadySet(chainId, contractAddr, dstEid, expectedOptions) {
  try {
    const provider = getProvider(chainId)
    const contract = new ethers.Contract(contractAddr, OFT_ABI, provider)
    const currentOptions = await contract.enforcedOptions(dstEid, 1) // msgType = 1
    return currentOptions.toLowerCase() === expectedOptions.toLowerCase()
  } catch (err) {
    console.warn(`  ⚠ Failed to check enforcedOptions for ${contractAddr} on chain ${chainId} (eid ${dstEid}): ${err.message}`)
    return false
  }
}

// ─── Builder helpers ──────────────────────────────────────────────────────────
function peerTx(chainId, to, dstEid, peerAddr, label) {
  return {
    chainId,
    to,
    value: '0',
    data: iface.encodeFunctionData('setPeer', [dstEid, addressToBytes32(peerAddr)]),
    description: label,
    // metadata for on-chain check
    _type: 'setPeer',
    _dstEid: dstEid,
    _expectedPeer: peerAddr,
  }
}

function enforcedOptionsTx(chainId, to, peers, label) {
  const params = peers.map(([dstEid]) => ({
    dstEid,
    msgType: 1,
    options: encodeLzReceiveOptions(GAS[dstEid]),
  }))
  return {
    chainId,
    to,
    value: '0',
    data: iface.encodeFunctionData('setEnforcedOptions', [params]),
    description: label,
    _type: 'setEnforcedOptions',
    _peers: peers,
  }
}

// ─── Declare desired wiring ───────────────────────────────────────────────────
// Returns array of { chainId, to, peers: [[dstEid, peerAddr, netName]], name }
function declareAllWiring() {
  const wiring = []

  // ── Mainnet ─────────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.mainnet, to: ADDR.mainnet_YUSD, name: 'YUSDMintBurnOFTAdapter', peers: [
    [EID.bnb,       ADDR.bnb_YUSD,      'bnb'],
    [EID.avalanche, ADDR.avax_YUSD,     'avalanche'],
    [EID.arbitrum,  ADDR.arb_YUSD,      'arbitrum'],
    [EID.katana,    ADDR.katana_YUSD,   'katana'],
    [EID.base,      ADDR.base_YUSD,     'base'],
    [EID.plasma,    ADDR.plasma_YUSD,   'plasma'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.mainnet, to: ADDR.mainnet_sYUSD, name: 'sYUSDOFTAdapter', peers: [
    [EID.bnb,       ADDR.bnb_sYUSD,     'bnb'],
    [EID.avalanche, ADDR.avax_sYUSD,    'avalanche'],
    [EID.katana,    ADDR.katana_sYUSD,  'katana'],
    [EID.plasma,    ADDR.plasma_sYUSD,  'plasma'],
    [EID.monad,     ADDR.monad_sYUSD,   'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.mainnet, to: ADDR.mainnet_JUSD, name: 'JUSDMintBurnOFTAdapter', peers: [
    [EID.monad,     ADDR.monad_JUSD,    'monad'],
    [EID.katana,    ADDR.katana_JUSD,   'katana'],
  ]})

  wiring.push({ chainId: CHAIN_ID.mainnet, to: ADDR.mainnet_sJUSD, name: 'sJUSDOFTAdapter', peers: [
    [EID.monad,     ADDR.monad_sJUSD,   'monad'],
    [EID.katana,    ADDR.katana_sJUSD,  'katana'],
  ]})

  // ── BSC ─────────────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.bnb, to: ADDR.bnb_YUSD, name: 'YUSDMintBurnOFTAdapter', peers: [
    [EID.mainnet,   ADDR.mainnet_YUSD,  'mainnet'],
    [EID.avalanche, ADDR.avax_YUSD,     'avalanche'],
    [EID.arbitrum,  ADDR.arb_YUSD,      'arbitrum'],
    [EID.katana,    ADDR.katana_YUSD,   'katana'],
    [EID.base,      ADDR.base_YUSD,     'base'],
    [EID.plasma,    ADDR.plasma_YUSD,   'plasma'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.bnb, to: ADDR.bnb_sYUSD, name: 'sYUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_sYUSD, 'mainnet'],
    [EID.avalanche, ADDR.avax_sYUSD,    'avalanche'],
    [EID.katana,    ADDR.katana_sYUSD,  'katana'],
    [EID.plasma,    ADDR.plasma_sYUSD,  'plasma'],
    [EID.monad,     ADDR.monad_sYUSD,   'monad'],
  ]})

  // ── Avalanche ───────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.avalanche, to: ADDR.avax_YUSD, name: 'YUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_YUSD,  'mainnet'],
    [EID.bnb,       ADDR.bnb_YUSD,      'bnb'],
    [EID.arbitrum,  ADDR.arb_YUSD,      'arbitrum'],
    [EID.katana,    ADDR.katana_YUSD,   'katana'],
    [EID.base,      ADDR.base_YUSD,     'base'],
    [EID.plasma,    ADDR.plasma_YUSD,   'plasma'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.avalanche, to: ADDR.avax_sYUSD, name: 'sYUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_sYUSD, 'mainnet'],
    [EID.bnb,       ADDR.bnb_sYUSD,     'bnb'],
    [EID.katana,    ADDR.katana_sYUSD,  'katana'],
    [EID.plasma,    ADDR.plasma_sYUSD,  'plasma'],
    [EID.monad,     ADDR.monad_sYUSD,   'monad'],
  ]})

  // ── Arbitrum ────────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.arbitrum, to: ADDR.arb_YUSD, name: 'YUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_YUSD,  'mainnet'],
    [EID.bnb,       ADDR.bnb_YUSD,      'bnb'],
    [EID.avalanche, ADDR.avax_YUSD,     'avalanche'],
    [EID.katana,    ADDR.katana_YUSD,   'katana'],
    [EID.base,      ADDR.base_YUSD,     'base'],
    [EID.plasma,    ADDR.plasma_YUSD,   'plasma'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  // ── Base ────────────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.base, to: ADDR.base_YUSD, name: 'YUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_YUSD,  'mainnet'],
    [EID.bnb,       ADDR.bnb_YUSD,      'bnb'],
    [EID.avalanche, ADDR.avax_YUSD,     'avalanche'],
    [EID.arbitrum,  ADDR.arb_YUSD,      'arbitrum'],
    [EID.katana,    ADDR.katana_YUSD,   'katana'],
    [EID.plasma,    ADDR.plasma_YUSD,   'plasma'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  // ── Plasma ──────────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.plasma, to: ADDR.plasma_YUSD, name: 'YUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_YUSD,  'mainnet'],
    [EID.bnb,       ADDR.bnb_YUSD,      'bnb'],
    [EID.avalanche, ADDR.avax_YUSD,     'avalanche'],
    [EID.arbitrum,  ADDR.arb_YUSD,      'arbitrum'],
    [EID.base,      ADDR.base_YUSD,     'base'],
    [EID.katana,    ADDR.katana_YUSD,   'katana'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.plasma, to: ADDR.plasma_sYUSD, name: 'sYUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_sYUSD, 'mainnet'],
    [EID.bnb,       ADDR.bnb_sYUSD,     'bnb'],
    [EID.avalanche, ADDR.avax_sYUSD,    'avalanche'],
    [EID.katana,    ADDR.katana_sYUSD,  'katana'],
    [EID.monad,     ADDR.monad_sYUSD,   'monad'],
  ]})

  // ── Katana ──────────────────────────────────────────────────────────────────
  wiring.push({ chainId: CHAIN_ID.katana, to: ADDR.katana_YUSD, name: 'YUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_YUSD,  'mainnet'],
    [EID.bnb,       ADDR.bnb_YUSD,      'bnb'],
    [EID.avalanche, ADDR.avax_YUSD,     'avalanche'],
    [EID.arbitrum,  ADDR.arb_YUSD,      'arbitrum'],
    [EID.base,      ADDR.base_YUSD,     'base'],
    [EID.plasma,    ADDR.plasma_YUSD,   'plasma'],
    [EID.monad,     ADDR.monad_YUSD,    'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.katana, to: ADDR.katana_sYUSD, name: 'sYUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_sYUSD, 'mainnet'],
    [EID.bnb,       ADDR.bnb_sYUSD,     'bnb'],
    [EID.avalanche, ADDR.avax_sYUSD,    'avalanche'],
    [EID.plasma,    ADDR.plasma_sYUSD,  'plasma'],
    [EID.monad,     ADDR.monad_sYUSD,   'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.katana, to: ADDR.katana_JUSD, name: 'JUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_JUSD,  'mainnet'],
    [EID.monad,     ADDR.monad_JUSD,    'monad'],
  ]})

  wiring.push({ chainId: CHAIN_ID.katana, to: ADDR.katana_sJUSD, name: 'sJUSDOFT', peers: [
    [EID.mainnet,   ADDR.mainnet_sJUSD, 'mainnet'],
    [EID.monad,     ADDR.monad_sJUSD,   'monad'],
  ]})

  return wiring
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Checking on-chain peer state to find missing wires...\n')

  const allWiring = declareAllWiring()
  const txs = []
  let skippedPeers = 0
  let skippedOptions = 0

  for (const entry of allWiring) {
    const { chainId, to, name, peers } = entry

    // Check each peer
    const missingPeers = []
    for (const [dstEid, peerAddr, netName] of peers) {
      const alreadySet = await isPeerAlreadySet(chainId, to, dstEid, peerAddr)
      if (alreadySet) {
        console.log(`  ✓ ${name}.peers(${netName}) already set — skipping`)
        skippedPeers++
      } else {
        console.log(`  ✗ ${name}.peers(${netName}) NOT set — will generate tx`)
        missingPeers.push([dstEid, peerAddr, netName])
      }
    }

    // Generate setPeer txs for missing peers only
    for (const [dstEid, peerAddr, netName] of missingPeers) {
      txs.push(peerTx(chainId, to, dstEid, peerAddr, `${name}.setPeer(${netName})`))
    }

    // Check enforcedOptions — only include if at least one peer needs options set
    // We check each destination's enforcedOptions individually
    const missingOptionsPeers = []
    for (const [dstEid, peerAddr, netName] of peers) {
      const expectedOptions = encodeLzReceiveOptions(GAS[dstEid])
      const alreadySet = await isEnforcedOptionsAlreadySet(chainId, to, dstEid, expectedOptions)
      if (alreadySet) {
        skippedOptions++
      } else {
        missingOptionsPeers.push([dstEid, peerAddr, netName])
      }
    }

    if (missingOptionsPeers.length > 0) {
      // Generate setEnforcedOptions for ALL destinations (idempotent, but we batch them)
      // We include all peers in the options call since it's a single batch call
      txs.push(enforcedOptionsTx(chainId, to, missingOptionsPeers, `${name}.setEnforcedOptions`))
    } else {
      console.log(`  ✓ ${name}.enforcedOptions all set — skipping`)
    }

    console.log()
  }

  // ─── Output ───────────────────────────────────────────────────────────────
  const SAFE_CHAINS = new Set([CHAIN_ID.mainnet, CHAIN_ID.bnb, CHAIN_ID.avalanche, CHAIN_ID.arbitrum, CHAIN_ID.base])
  const CHAIN_NAMES = Object.fromEntries(Object.entries(CHAIN_ID).map(([k,v]) => [v,k]))

  const byChain = {}
  for (const tx of txs) {
    ;(byChain[tx.chainId] ??= []).push(tx)
  }

  let total = 0
  for (const [chainId, chainTxs] of Object.entries(byChain)) {
    const name = CHAIN_NAMES[chainId]
    const safeNote = SAFE_CHAINS.has(Number(chainId)) ? '(Safe UI)' : '(manual — no Safe service)'
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`  ${name.toUpperCase()} chainId:${chainId} — ${chainTxs.length} txs ${safeNote}`)
    console.log('═'.repeat(60))
    for (const tx of chainTxs) {
      console.log(`\n  [${tx.description}]`)
      console.log(`    to:   ${tx.to}`)
      console.log(`    data: ${tx.data}`)
    }
    total += chainTxs.length
  }

  // Write per-chain JSON files in Safe Transaction Builder batch format
  const outDir = path.join(__dirname)

  // Remove old files first
  const oldFiles = fs.readdirSync(outDir).filter(f => f.startsWith('multisig-wire-txs'))
  for (const f of oldFiles) {
    fs.unlinkSync(path.join(outDir, f))
    console.log(`\nRemoved old file: ${f}`)
  }

  if (total === 0) {
    console.log(`\n${'═'.repeat(60)}`)
    console.log('ALL WIRES ARE ALREADY SET — no transactions needed! 🎉')
    console.log('═'.repeat(60))
    return
  }

  for (const [chainId, chainTxs] of Object.entries(byChain)) {
    const name = CHAIN_NAMES[chainId]
    const safeTxs = chainTxs.map(tx => ({
      to: tx.to,
      value: tx.value,
      data: tx.data,
      contractMethod: null,
      contractInputsValues: null,
    }))

    // Build verbose description from transaction descriptions
    const txDescriptions = chainTxs.map(tx => tx.description)
    const batchName = `Wire OFTs on ${name.toUpperCase()} — ${chainTxs.length} txs (missing wires only)`
    const descriptionLines = [
      `Batch of ${chainTxs.length} transactions to wire OFT contracts on ${name}:`,
      '',
      ...txDescriptions.map(d => `• ${d}`),
      '',
      'Generated by generate-multisig-wire-txs.js — only includes paths not yet wired on-chain.',
    ]

    const batchFile = {
      version: '1.0',
      chainId: String(chainId),
      createdAt: Date.now(),
      meta: {
        name: batchName,
        description: descriptionLines.join('\n'),
        txBuilderVersion: '1.16.5',
        createdFromSafeAddress: '',
        createdFromOwnerAddress: '',
      },
      transactions: safeTxs,
    }
    const outPath = path.join(outDir, `multisig-wire-txs-${name}.json`)
    fs.writeFileSync(outPath, JSON.stringify(batchFile, null, 2))
  }

  // Also write combined
  const cleanTxs = txs.map(({ _type, _dstEid, _expectedPeer, _peers, ...rest }) => rest)
  fs.writeFileSync(path.join(outDir, 'multisig-wire-txs.json'), JSON.stringify(cleanTxs, null, 2))

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`TOTAL: ${total} transactions across ${Object.keys(byChain).length} chains`)
  console.log(`SKIPPED: ${skippedPeers} peers already set, ${skippedOptions} enforced options already set`)
  console.log(`\nPer-chain JSON files written to scripts/jusd/:`)
  for (const [chainId] of Object.entries(byChain)) {
    const name = CHAIN_NAMES[chainId]
    const safeNote = SAFE_CHAINS.has(Number(chainId)) ? '← import to Safe Transaction Builder' : '← execute manually via explorer'
    console.log(`  multisig-wire-txs-${name}.json ${safeNote}`)
  }
  console.log()
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
