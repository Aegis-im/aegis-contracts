import { ethers, network } from 'hardhat'
import { writeFileSync } from 'fs'

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId
  if (!['hardhat', 'localhost'].includes(network.name) || ![1337n, 31337n].includes(chainId)) throw new Error('Local demo requires a local Hardhat network')
  const [admin, manager, counterparty, investor] = await ethers.getSigners()
  const token = await ethers.deployContract('TestToken', ['USD Coin (local test)', 'USDC', 6])
  const config = await ethers.deployContract('AegisConfig', [admin.address, [admin.address], admin.address])
  await config['whitelistAddress(address,bool)'](investor.address, true)
  const vault = await ethers.deployContract('AegisCreditVault', [token.target, config.target, counterparty.address,
    admin.address, manager.address])
  await vault.waitForDeployment()
  for (const who of [investor, counterparty, manager]) await token.mint(who.address, ethers.parseUnits('10000', 6))
  const record = { chainId: Number(chainId), address: await vault.getAddress(), asset: await token.getAddress(),
    config: await config.getAddress(), admin: admin.address, manager: manager.address, counterparty: counterparty.address,
    investor: investor.address, redemptionCooldown: Number(await vault.REDEMPTION_COOLDOWN()) }
  const path = process.env.CREDIT_VAULT_LOCAL_OUTPUT || '/private/tmp/aegis-credit-vault-local.json'
  writeFileSync(path, JSON.stringify(record, null, 2) + '\n')
  console.log(`Local test deployment saved to ${path}`)
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
