import { ethers, network } from 'hardhat'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

async function main() {
  const inputs = ['CREDIT_VAULT_ASSET', 'CREDIT_VAULT_CONFIG', 'CREDIT_VAULT_COUNTERPARTY', 'CREDIT_VAULT_ADMIN', 'CREDIT_VAULT_MANAGER']
    .map(key => ethers.getAddress(required(key)))
  if (inputs.some(a => a === ethers.ZeroAddress)) throw new Error('Zero address is not allowed')
  if (existsSync(join('deployments', network.name, 'AegisCreditVault.json'))) throw new Error('Archive the existing deployment record before deploying a replacement')
  const vault = await ethers.deployContract('AegisCreditVault', inputs)
  await vault.waitForDeployment()
  const chainId = (await ethers.provider.getNetwork()).chainId.toString()
  const folder = join('deployments', network.name)
  mkdirSync(folder, { recursive: true })
  const record = { address: await vault.getAddress(), chainId, asset: inputs[0], aegisConfig: inputs[1],
    counterparty: inputs[2], admin: inputs[3], manager: inputs[4], redemptionCooldown: Number(await vault.REDEMPTION_COOLDOWN()),
    transactionHash: vault.deploymentTransaction()?.hash }
  writeFileSync(join(folder, 'AegisCreditVault.json'), JSON.stringify(record, null, 2) + '\n')
  console.log(JSON.stringify(record, null, 2))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
