import { strict as assert } from 'assert'
import { ethers, artifacts, network } from 'hardhat'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'

async function main() {
  const path = join('deployments', network.name, 'AegisCreditVault.json')
  const record = JSON.parse(readFileSync(path, 'utf8'))
  const chain = await ethers.provider.getNetwork()
  assert.equal(chain.chainId.toString(), record.chainId)
  const v = await ethers.getContractAt('AegisCreditVault', record.address)
  const receipt = await ethers.provider.getTransactionReceipt(record.transactionHash)
  assert.equal(receipt?.status, 1)
  assert.equal(receipt?.contractAddress?.toLowerCase(), record.address.toLowerCase())
  assert.equal(await v.asset(), record.asset)
  assert.equal(await v.aegisConfig(), record.aegisConfig)
  assert.equal(await v.counterparty(), record.counterparty)
  assert.equal(await v.share(), record.address)
  assert.equal(await v.REDEMPTION_COOLDOWN(), BigInt(record.redemptionCooldown))
  assert.equal(await v.hasRole(ethers.ZeroHash, record.admin), true)
  assert.equal(await v.hasRole(await v.MANAGER_ROLE(), record.manager), true)
  assert.equal(await v.hasRole(await v.GUARDIAN_ROLE(), record.admin), true)
  for (const id of ['0xe3bc4e65','0x2f0a18c5','0x620ee8e4']) assert.equal(await v.supportsInterface(id), true)
  assert.equal(await v.totalAssets(), 0n)
  assert.equal(await v.totalSupply(), 0n)
  assert.equal(await v.claimReserves(), 0n)
  assert.equal(await v.isBlackListed(record.admin), false)
  assert.equal(await v.paused(), false)
  assert.equal(await v.convertToAssets(10n ** 18n), 10n ** 6n)
  // Runtime equality after masking constructor-patched immutable slots.
  const build = await artifacts.getBuildInfo('contracts/AegisCreditVault.sol:AegisCreditVault')
  const compiled = build!.output.contracts['contracts/AegisCreditVault.sol'].AegisCreditVault.evm.deployedBytecode
  const deployed = await ethers.provider.getCode(record.address)
  const expected = Buffer.from(compiled.object, 'hex')
  const actual = Buffer.from(deployed.slice(2), 'hex')
  assert.equal(actual.length, expected.length)
  for (const refs of Object.values(compiled.immutableReferences) as Array<Array<{start: number, length: number}>>) {
    for (const ref of refs) { expected.fill(0, ref.start, ref.start + ref.length); actual.fill(0, ref.start, ref.start + ref.length) }
  }
  assert.deepEqual(actual, expected)
  const config = await ethers.getContractAt('AegisConfig', record.aegisConfig)
  assert.equal(await v.isEligible(record.admin), true)
  assert.equal(await v.maxDeposit(record.admin), ethers.MaxUint256)
  const result = { address: record.address, chainId: record.chainId, blockNumber: receipt!.blockNumber,
    runtimeCodeHash: ethers.keccak256(deployed), runtimeMatchesCompiledArtifact: true,
    constructorAndRolesChecked: true, initialAccountingChecked: true,
    whitelistEnabled: await config.whitelistEnabled(), admissionPolicy: 'blacklist-only', deployerWhitelisted: await config.isWhitelisted(record.admin), deployerEligible: await v.isEligible(record.admin) }
  writeFileSync(join('deployments', network.name, 'AegisCreditVault.validation.json'), JSON.stringify(result, null, 2)+'\n')
  console.log(JSON.stringify(result, null, 2))
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
