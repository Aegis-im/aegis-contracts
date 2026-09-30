import { ethers, upgrades } from 'hardhat'
import { settings as c } from './common'
async function main() {
  if (![1337n, 31337n].includes((await ethers.provider.getNetwork()).chainId)) throw new Error('Local only')
  const [admin] = await ethers.getSigners(), z = ethers.ZeroAddress
  const collateral = await ethers.deployContract('TestToken', ['USDC', 'USDC', 6])
  const endpoint = await ethers.deployContract('EndpointHarness')
  const start = await ethers.provider.getBlockNumber()
  const token = await ethers.deployContract('VaultToken', [c.tokenName, c.tokenSymbol, admin.address])
  const config = await ethers.deployContract('VaultConfig', [admin.address, [admin.address], admin.address])
  const oracle = await ethers.deployContract('VaultChainlinkOracleV3', [`${c.tokenSymbol} / USD`, 8, [admin.address], admin.address])
  const assetOracle = await ethers.deployContract('VaultChainlinkOracleV3', ['USDC / USD (test reference)', 8, [admin.address], admin.address])
  await oracle.updatePrice(100000000); await assetOracle.updatePrice(100000000)
  const minting = await ethers.deployContract('VaultMinting', [c.mintingDomain, token.target, config.target, z, oracle.target, z, admin.address, [collateral.target], [c.assetHeartbeat], [admin.address], admin.address, c.adminDelay, c.oracleHeartbeat])
  await token.setMinter(minting.target)
  for (const role of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) await minting.grantRole(ethers.id(role), admin.address)
  await minting.setAssetPriceFeed(collateral.target, assetOracle.target); await config.disableWhitelist()
  await minting.setMintLimits(c.limitPeriod, ethers.parseEther(c.mintLimit)); await minting.setRedeemLimits(c.limitPeriod, ethers.parseEther(c.redeemLimit))
  const staking = await upgrades.deployProxy(await ethers.getContractFactory('VaultStaking'), [token.target, admin.address, c.stakingName, c.stakingSymbol, c.cooldown, c.instantUnstakingFeeBP, admin.address], { kind: 'transparent' })
  const adapter = await ethers.deployContract('VaultMintBurnOFTAdapter', [token.target, minting.target, endpoint.target, admin.address])
  await minting.setCrossChainOperator(adapter.target)
  await ethers.deployContract('VaultStakingOFTAdapter', [staking.target, endpoint.target, admin.address])
  let gas = 0n
  for (let b = start + 1; b <= await ethers.provider.getBlockNumber(); b++) {
    const block = await ethers.provider.getBlock(b)
    for (const hash of block!.transactions) gas += (await ethers.provider.getTransactionReceipt(hash))!.gasUsed
  }
  console.log(JSON.stringify({ localDeploymentGas: gas.toString(), estimatedTestETHAt1Gwei: ethers.formatEther(gas * 1000000000n), includes: 'token, config, two oracles, minting, staking implementation/proxy/admin/silo, both OFT adapters and setup' }, null, 2))
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
