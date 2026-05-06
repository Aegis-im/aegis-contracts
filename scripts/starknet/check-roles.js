/**
 * Check who holds MINTER_ROLE, BURNER_ROLE, and DEFAULT_ADMIN_ROLE on the YUSD ERC20.
 *
 * Usage:
 *   node scripts/starknet/check-roles.js
 */

require('dotenv').config()
const { RpcProvider, CallData } = require('starknet')
const networksConfig = require('../../config/networks.json')

const RPC_URL     = process.env.STARKNET_RPC_URL || networksConfig.networks.starknet.rpcUrl
const ERC20       = networksConfig.networks.starknet.contracts.yusdERC20Address
const OFT         = networksConfig.networks.starknet.contracts.yusdOftAddress
const DEPLOYER    = networksConfig.networks.starknet.adminAddress

const DEFAULT_ADMIN_ROLE = '0x0'
const MINTER_ROLE        = '0x4d494e5445525f524f4c45'
const BURNER_ROLE        = '0x4255524e45525f524f4c45'

const ROLES = [
  { name: 'DEFAULT_ADMIN_ROLE', felt: DEFAULT_ADMIN_ROLE },
  { name: 'MINTER_ROLE',        felt: MINTER_ROLE },
  { name: 'BURNER_ROLE',        felt: BURNER_ROLE },
]

const ACCOUNTS = [
  { name: 'Deployer', address: DEPLOYER },
  { name: 'OFT',      address: OFT },
]

async function hasRole(provider, erc20, role, account) {
  const result = await provider.callContract({
    contractAddress: erc20,
    entrypoint: 'has_role',
    calldata: [role, account],
  })
  return result[0] !== '0x0'
}

async function main() {
  const provider = new RpcProvider({ nodeUrl: RPC_URL })

  console.log(`ERC20:    ${ERC20}`)
  console.log(`OFT:      ${OFT}`)
  console.log(`Deployer: ${DEPLOYER}`)
  console.log('')

  for (const role of ROLES) {
    console.log(`${role.name}:`)
    for (const acct of ACCOUNTS) {
      const has = await hasRole(provider, ERC20, role.felt, acct.address)
      console.log(`  ${has ? '✅' : '❌'} ${acct.name} (${acct.address})`)
    }
    console.log('')
  }
}

main().catch(err => {
  console.error('Fatal:', err.message || err)
  process.exit(1)
})
