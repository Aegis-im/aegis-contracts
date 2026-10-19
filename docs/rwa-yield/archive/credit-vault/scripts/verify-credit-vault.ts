import { network, run } from 'hardhat'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
async function main() {
  const folder = join('deployments', network.name)
  const r = JSON.parse(readFileSync(join(folder, 'AegisCreditVault.json'), 'utf8'))
  await run('verify:etherscan', { address: r.address, constructorArgsParams: [r.asset, r.aegisConfig, r.counterparty, r.admin, r.manager],
    contract: 'contracts/AegisCreditVault.sol:AegisCreditVault' })
  writeFileSync(join(folder, 'AegisCreditVault.verification.json'), JSON.stringify({ address: r.address,
    chainId: r.chainId, etherscan: 'verified' }, null, 2)+'\n')
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
