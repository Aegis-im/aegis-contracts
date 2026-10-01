import hre, { ethers, run } from 'hardhat'
import { getEtherscanInstance, verifyAndGetStatus } from '@openzeppelin/hardhat-upgrades/dist/utils/etherscan-api'
import { writeFileSync } from 'fs'
import { loadRecord, checkNetwork, recordPath } from './common'
async function main() {
  await checkNetwork()
  const r = loadRecord(), results: any[] = []; let failed = false
  async function verify(key: string, address: string, contract: string, args: any[]) {
    try {
      await run('verify:etherscan', { address, contract, constructorArgsParams: args })
      results.push({ key, address, etherscan: 'verified' })
    } catch (e: any) {
      if (/already verified/i.test(e.message)) results.push({ key, address, etherscan: 'verified' })
      else { failed = true; results.push({ key, address, error: e.message }); console.error(`${key}: ${e.message}`) }
    }
  }
  for (const [key, value] of Object.entries(r.contracts) as [string, any][]) {
    if (key === 'staking') {
      await verify('stakingImplementation', value.implementation, 'contracts/AegisVault/VaultStaking.sol:VaultStaking', [])
      const transaction = await ethers.provider.getTransaction(value.transactionHash)
      const build = require('@openzeppelin/upgrades-core/artifacts/build-info-v5.json')
      const proxyArtifact = require('@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts-v5/proxy/transparent/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json')
      const adminArtifact = require('@openzeppelin/upgrades-core/artifacts/@openzeppelin/contracts-v5/proxy/transparent/ProxyAdmin.sol/ProxyAdmin.json')
      if (!transaction!.data.startsWith(proxyArtifact.bytecode)) throw new Error('Proxy deployment does not match installed upgrades artifact')
      const instance = await getEtherscanInstance(hre)
      for (const [part, address, artifact, args] of [
        ['stakingProxy', value.address, proxyArtifact, transaction!.data.slice(proxyArtifact.bytecode.length)],
        ['stakingProxyAdmin', value.proxyAdmin, adminArtifact, ethers.AbiCoder.defaultAbiCoder().encode(['address'], [r.settings.admin]).slice(2)],
      ] as const) {
        try {
          const status = await verifyAndGetStatus({ contractAddress: address, sourceCode: JSON.stringify(build.input), contractName: `${artifact.sourceName}:${artifact.contractName}`, compilerVersion: `v${build.solcLongVersion}`, constructorArguments: args }, instance)
          if (!status.isSuccess() && !status.isAlreadyVerified()) throw new Error(status.message)
          results.push({ key: part, address, etherscan: 'verified' })
        } catch (e: any) {
          if (/already verified/i.test(e.message)) results.push({ key: part, address, etherscan: 'verified' })
          else { failed = true; results.push({ key: part, address, error: e.message }); console.error(`${part}: ${e.message}`) }
        }
      }
      await verify('stakingSilo', value.silo, 'contracts/AegisVault/VaultStakingSilo.sol:VaultStakingSilo', [value.address, r.contracts.token.address])
    } else await verify(key, value.address, `contracts/AegisVault/${value.contract}.sol:${value.contract}`, value.args)
  }
  writeFileSync(recordPath.replace('.json', '.verification.json'), JSON.stringify({ checkedAt: new Date().toISOString(), chainId: r.chainId, results }, null, 2) + '\n')
  if (failed) throw new Error('Some explorer verifications failed')
}
main().catch(e => { console.error(e.message); process.exitCode = 1 })
