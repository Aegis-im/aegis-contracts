import { ethers } from 'hardhat'
import { settings as c, loadRecord, saveRecord, checkNetwork, confirmed } from './common'

export async function attachRewards(record: any) {
  const [admin] = await ethers.getSigners()
  if (admin.address.toLowerCase() !== c.admin.toLowerCase()) throw new Error('Rewards setup requires the configured administrator')
  if (record.chainId !== c.chainId) throw new Error('Wrong deployment chain')
  const a = record.contracts, z = ethers.ZeroAddress
  async function deploy(key: string, contract: string, args: any[]) {
    if (a[key]) return ethers.getContractAt(contract, a[key].address) as Promise<any>
    const instance: any = await ethers.deployContract(contract, args); await instance.waitForDeployment()
    a[key] = { address: instance.target, contract, args, transactionHash: instance.deploymentTransaction().hash }; saveRecord(record)
    return instance
  }
  const rewards = await deploy('rewards', 'VaultRewards', [c.rewardsDomain, c.adminDelay, a.token.address, a.config.address, c.admin])
  const router = await deploy('incomeRouter', 'VaultIncomeRouter', [c.incomeDomain, a.token.address, a.minting.address, rewards.target, c.admin, c.adminDelay, c.permit2 || z, c.uniswapRouter || z, c.curvePoolA || z, c.curvePoolB || z, c.secondaryAsset || z, c.asset, c.secondaryAssetCap || 0])
  const minting: any = await ethers.getContractAt('VaultMinting', a.minting.address)
  await confirmed(await rewards.setVaultMintingAddress(minting.target))
  await confirmed(await rewards.setVaultIncomeRouterAddress(router.target))
  await confirmed(await rewards.setStakingContract(a.staking.address))
  await confirmed(await rewards.grantRole(ethers.id('REWARDS_MANAGER_ROLE'), c.manager))
  await confirmed(await router.setTrustedSigner(c.trustedSigner))
  await confirmed(await router.grantRole(ethers.id('INCOME_ROUTER_ROLE'), c.manager))
  await confirmed(await router.grantRole(ethers.id('SETTINGS_MANAGER_ROLE'), c.manager))
  await confirmed(await minting.grantRole(ethers.id('FUNDS_MANAGER_ROLE'), router.target))
  const role = ethers.id('SETTINGS_MANAGER_ROLE'), hadRole = await minting.hasRole(role, admin.address)
  if (!hadRole) await confirmed(await minting.grantRole(role, admin.address))
  await confirmed(await minting.setVaultRewardsAddress(rewards.target))
  if (!hadRole) await confirmed(await minting.renounceRole(role, admin.address))
  record.rewardsAttachedAt = new Date().toISOString(); saveRecord(record)
}
if (require.main === module) checkNetwork().then(() => attachRewards(loadRecord())).catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
