import assert from 'assert/strict'
import { artifacts, ethers, upgrades } from 'hardhat'
import { writeFileSync } from 'fs'
import { loadRecord, recordPath, checkNetwork } from './common'

async function main() {
  await checkNetwork()
  const r = loadRecord(), c = r.settings, a = r.contracts
  assert.equal(r.status, 'ready')
  const results: string[] = []
  for (const [key, value] of Object.entries(a) as [string, any][]) {
    assert.notEqual(await ethers.provider.getCode(value.address), '0x', `${key} deployed`)
    const contract: any = await ethers.getContractAt(value.contract, value.address)
    if (value.transactionHash) { const tx = await ethers.provider.getTransactionReceipt(value.transactionHash); assert.equal(tx?.status, 1, `${key} deployment confirmed`) }
    if (key === 'staking') {
      assert.equal(await upgrades.erc1967.getImplementationAddress(value.address), value.implementation)
      assert.equal(await upgrades.erc1967.getAdminAddress(value.address), value.proxyAdmin)
      assert.equal(await contract.silo(), value.silo)
      const implementation = await artifacts.readArtifact('VaultStaking')
      // No implementation immutables: compare deployed runtime exactly.
      assert.equal((await ethers.provider.getCode(value.implementation)).toLowerCase(), implementation.deployedBytecode.toLowerCase())
    } else if (value.args) {
      const transaction = await ethers.provider.getTransaction(value.transactionHash)
      const expected = await (await ethers.getContractFactory(value.contract)).getDeployTransaction(...value.args)
      assert.equal(transaction?.data.toLowerCase(), expected.data!.toLowerCase(), `${key} canonical creation bytecode and constructor parameters`)
    }
    results.push(`${key}: confirmed deployment and canonical bytecode`)
  }
  const token: any = await ethers.getContractAt('VaultToken', a.token.address)
  const config: any = await ethers.getContractAt('VaultConfig', a.config.address)
  const minting: any = await ethers.getContractAt('VaultMinting', a.minting.address)
  const staking: any = await ethers.getContractAt('VaultStaking', a.staking.address)
  const oracle: any = await ethers.getContractAt('VaultChainlinkOracleV3', a.oracle.address)
  assert.equal(await token.name(), c.tokenName); assert.equal(await token.symbol(), c.tokenSymbol)
  assert.equal(await staking.name(), c.stakingName); assert.equal(await staking.symbol(), c.stakingSymbol)
  assert.equal(await token.minter(), a.minting.address); assert.equal(await minting.token(), a.token.address)
  assert.equal(await staking.asset(), a.token.address); assert.equal(await minting.aegisConfig(), a.config.address)
  assert.equal(await minting.aegisOracle(), a.oracle.address)
  assert.equal(await config.trustedSigner(), c.trustedSigner); assert.equal(await config.whitelistEnabled(), c.whitelistEnabled)
  assert.equal(await minting.aegisRewards(), a.rewards?.address || ethers.ZeroAddress)
  assert.equal(await oracle.description(), `${c.tokenSymbol} / USD`)
  assert.equal(Number(await staking.cooldownDuration()), c.cooldown)
  assert.equal(Number(await staking.instantUnstakingFeeBP()), c.instantUnstakingFeeBP)
  for (const role of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) assert(await minting.hasRole(ethers.id(role), c.manager))
  assert.equal(await staking.hasRole(ethers.id('ADMIN_ROLE'), c.admin), true)
  assert.equal(await token.owner(), c.admin); assert.equal(await config.owner(), c.admin)
  assert(await minting.quoteMint(c.asset, 1_000_000) > 0n)
  assert.equal(await staking.convertToAssets(ethers.parseEther('1')) > 0n, true)
  if (a.tokenOFTAdapter) {
    const adapter = await ethers.getContractAt('VaultMintBurnOFTAdapter', a.tokenOFTAdapter.address)
    assert.equal(await adapter.token(), a.token.address); assert.equal(await adapter.endpoint(), c.layerZeroEndpoint)
    assert.equal(await adapter.aegisMinting(), a.minting.address)
  }
  if (a.stakingOFTAdapter) {
    const adapter = await ethers.getContractAt('VaultStakingOFTAdapter', a.stakingOFTAdapter.address)
    assert.equal(await adapter.token(), a.staking.address)
  }
  const evidence = { checkedAt: new Date().toISOString(), chainId: r.chainId, block: await ethers.provider.getBlockNumber(), results, configuration: 'token identities, roles, wiring, rewards state, prices, staking previews and OFT adapter asset bindings asserted' }
  writeFileSync(recordPath.replace('.json', '.validation.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify(evidence, null, 2))
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
