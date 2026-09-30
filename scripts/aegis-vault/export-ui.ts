import { artifacts } from 'hardhat'
import { mkdirSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { loadRecord } from './common'
async function main() {
  const record = loadRecord(), c = record.settings
  if (record.status !== 'ready') throw new Error('Deployment is incomplete')
  const out = resolve(process.env.VAULT_UI_OUTPUT || '/private/tmp/aegis-vault-ui/src/pages/BankYield')
  mkdirSync(out, { recursive: true })
  const keys = ['token', 'staking', 'minting', 'config', 'oracle', 'tokenOFTAdapter', 'stakingOFTAdapter']
  const contracts = Object.fromEntries(keys.filter(k => record.contracts[k]).map(k => [k, record.contracts[k].address]))
  writeFileSync(join(out, 'deployment.sepolia.json'), JSON.stringify({ chainId: record.chainId, asset: c.asset, custodian: c.custodian, rpcUrl: c.rpcUrl, explorer: c.explorer, tokenSymbol: c.tokenSymbol, stakingSymbol: c.stakingSymbol, contracts }, null, 2) + '\n')
  for (const contract of ['VaultMinting', 'VaultStaking', 'VaultConfig']) writeFileSync(join(out, `${contract}.abi.json`), JSON.stringify((await artifacts.readArtifact(contract)).abi, null, 2) + '\n')
  console.log(`Exported current deployment and ABIs to ${out}`)
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
