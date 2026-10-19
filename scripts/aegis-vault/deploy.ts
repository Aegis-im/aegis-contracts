import { ethers, upgrades } from 'hardhat'
import { existsSync } from 'fs'
import { settings as c, recordPath, loadRecord, saveRecord, checkNetwork, confirmed } from './common'
import { attachRewards } from './rewards'
import { attachAssetGuard } from './asset-guard'

async function main() {
  await checkNetwork()
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error('Missing deployer')
  // Setup transactions are issued by the configured test administrator; never silently transfer authority.
  if (deployer.address.toLowerCase() !== c.admin.toLowerCase()) throw new Error('Deployer must be configured admin for setup')
  if (c.chainId !== 11155111 && !c.collateralFeed) throw new Error('Operator-maintained collateral reference prices are testnet-only')
  const record: any = existsSync(recordPath) ? loadRecord() : { version: 1, chainId: c.chainId, settings: c, contracts: {}, status: 'deploying' }
  if (JSON.stringify(record.settings) !== JSON.stringify(c)) throw new Error('Configuration differs from saved deployment')
  if (record.status === 'ready') throw new Error('Already deployed; use rewards.ts to attach optional rewards')
  const asset = await ethers.getContractAt('IERC20Metadata', c.asset)
  if (await asset.decimals() > 18n) throw new Error('Unsupported collateral decimals')
  const fees = await ethers.provider.getFeeData()
  if (!record.contracts.token && await ethers.provider.getBalance(deployer.address) < 20_000_000n * fees.gasPrice!) throw new Error('Insufficient test ETH for the complete deployment; top up before retrying')
  const z = ethers.ZeroAddress
  async function deploy(key: string, contract: string, args: any[]) {
    if (record.contracts[key]) {
      if (record.contracts[key].pending) {
        const receipt = await ethers.provider.waitForTransaction(record.contracts[key].transactionHash, 1, 120000)
        if (receipt?.status !== 1) throw new Error(`Pending deployment has not succeeded: ${key}`)
        delete record.contracts[key].pending; saveRecord(record)
      }
      if (await ethers.provider.getCode(record.contracts[key].address) === '0x') throw new Error(`Missing code: ${key}`)
      return ethers.getContractAt(contract, record.contracts[key].address) as Promise<any>
    }
    const instance: any = await ethers.deployContract(contract, args)
    record.contracts[key] = { address: await instance.getAddress(), contract, args, transactionHash: instance.deploymentTransaction().hash, pending: true }
    saveRecord(record)
    console.log(`Submitted ${key}: ${instance.deploymentTransaction().hash}`)
    await instance.waitForDeployment()
    delete record.contracts[key].pending; saveRecord(record)
    console.log(`${key}: ${await instance.getAddress()}`)
    return instance
  }
  const token = await deploy('token', 'VaultToken', [c.tokenName, c.tokenSymbol, c.admin])
  const config = await deploy('config', 'VaultConfig', [c.trustedSigner, [c.manager], c.admin])
  const oracle = await deploy('oracle', 'VaultChainlinkOracleV3', [`${c.tokenSymbol} / USD`, c.oracleDecimals, [...new Set([deployer.address, c.oracleOperator])], c.admin])
  if (await oracle.USDPrice() === 0n) await confirmed(await oracle.updatePrice(c.initialTokenPrice))
  let collateralFeed = c.collateralFeed
  if (!collateralFeed) {
    const feed = await deploy('collateralOracle', 'VaultChainlinkOracleV3', ['USDC / USD (test reference)', c.oracleDecimals, [...new Set([deployer.address, c.oracleOperator])], c.admin])
    if (await feed.USDPrice() === 0n) await confirmed(await feed.updatePrice(c.initialAssetPrice))
    collateralFeed = await feed.getAddress()
  }
  const minting = await deploy('minting', 'VaultMinting', [c.mintingDomain, token.target, config.target, z, oracle.target, z, c.insuranceFund, [c.asset], [c.assetHeartbeat], [c.custodian], c.admin, c.adminDelay, c.oracleHeartbeat])
  if (await token.minter() !== minting.target) await confirmed(await token.setMinter(minting.target))
  for (const role of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) {
    if (!await minting.hasRole(ethers.id(role), c.manager)) await confirmed(await minting.grantRole(ethers.id(role), c.manager))
    if (!await minting.hasRole(ethers.id(role), deployer.address)) await confirmed(await minting.grantRole(ethers.id(role), deployer.address))
  }
  if (await minting.assetPriceFeeds(c.asset) !== collateralFeed) await confirmed(await minting.setAssetPriceFeed(c.asset, collateralFeed))
  if (!c.whitelistEnabled && await config.whitelistEnabled()) await confirmed(await config.disableWhitelist())
  for (const [method, value] of [['Mint', c.mintFeeBP], ['Redeem', c.redeemFeeBP], ['Income', c.incomeFeeBP]] as const) {
    if (Number(await minting[`${method.toLowerCase()}FeeBP`]()) !== value) await confirmed(await minting[`set${method}FeeBP`](value))
  }
  await confirmed(await minting.setMintLimits(c.limitPeriod, ethers.parseEther(c.mintLimit)))
  await confirmed(await minting.setRedeemLimits(c.limitPeriod, ethers.parseEther(c.redeemLimit)))
  if (!record.contracts.staking) {
    const args = [token.target, c.admin, c.stakingName, c.stakingSymbol, c.cooldown, c.instantUnstakingFeeBP, c.insuranceFund]
    const staking = await upgrades.deployProxy(await ethers.getContractFactory('VaultStaking'), args, { kind: 'transparent', initialOwner: c.admin })
    await staking.waitForDeployment()
    const address = await staking.getAddress()
    record.contracts.staking = { address, contract: 'VaultStaking', initializerArgs: args, transactionHash: staking.deploymentTransaction()?.hash, implementation: await upgrades.erc1967.getImplementationAddress(address), proxyAdmin: await upgrades.erc1967.getAdminAddress(address), silo: await staking.silo() }
    saveRecord(record); console.log(`staking: ${address}`)
  }
  if (c.layerZeroEndpoint) {
    if (await ethers.provider.getCode(c.layerZeroEndpoint) === '0x') throw new Error('Invalid LayerZero endpoint')
    const adapter = await deploy('tokenOFTAdapter', 'VaultMintBurnOFTAdapter', [token.target, minting.target, c.layerZeroEndpoint, c.admin])
    await confirmed(await minting.setCrossChainOperator(adapter.target))
    await deploy('stakingOFTAdapter', 'VaultStakingOFTAdapter', [record.contracts.staking.address, c.layerZeroEndpoint, c.admin])
    record.bridgeStatus = 'adapters deployed; no remote peers configured'
  }
  if (c.assetGuard) await attachAssetGuard(record)
  if (c.rewards) await attachRewards(record)
  // Temporary setup permissions are not retained when the administrator differs from the manager.
  if (c.manager.toLowerCase() !== deployer.address.toLowerCase()) for (const role of ['SETTINGS_MANAGER_ROLE', 'FUNDS_MANAGER_ROLE', 'COLLATERAL_MANAGER_ROLE']) await confirmed(await minting.renounceRole(ethers.id(role), deployer.address))
  record.status = 'ready'; record.deployedAt = new Date().toISOString(); saveRecord(record)
  console.log(`Saved ${recordPath}`)
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
