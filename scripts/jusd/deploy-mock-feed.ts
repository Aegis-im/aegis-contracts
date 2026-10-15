import { ethers, run } from 'hardhat'

/**
 * Deploys a VaultChainlinkOracleV3 to use as a mock Chainlink price feed for the JUSDAssetGuard
 * Ondo leg on testnet (no real USDT/USDY feeds exist on Sepolia). Seeds it with a $1.00 answer so
 * the guard's _validatedPrice passes. Deployer is both owner and operator, so it can re-poke the
 * price later (updatePrice) to keep it fresh within the configured heartbeat.
 *
 * Env:
 *   FEED_DESC      feed description (default "USDT / USD (mock)")
 *   FEED_DECIMALS  answer decimals (default 8)
 *   FEED_PRICE     initial answer in feed decimals (default 1e8 = $1.00)
 *
 * Run:  SEPOLIA_RPC_URL=... VAULT_GAS_PRICE_WEI=auto \
 *       npx hardhat run scripts/jusd/deploy-mock-feed.ts --network sepolia
 */
async function main() {
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error('Missing deployer — set PRIVATE_KEY in .env')

  const description = process.env.FEED_DESC || 'USDT / USD (mock)'
  const decimals = Number(process.env.FEED_DECIMALS || 8)
  const price = BigInt(process.env.FEED_PRICE || 10n ** BigInt(decimals)) // default $1.00

  console.log(`deployer: ${deployer.address}`)
  const feed: any = await ethers.deployContract('VaultChainlinkOracleV3', [description, decimals, [deployer.address], deployer.address])
  console.log(`submitted: ${feed.deploymentTransaction()?.hash}`)
  await feed.waitForDeployment()
  const address = await feed.getAddress()
  console.log(`feed: ${address}`)

  await (await feed.updatePrice(price)).wait(1)
  const [, answer, , updatedAt] = await feed.latestRoundData()
  console.log(`seeded price: answer=${answer} decimals=${decimals} updatedAt=${updatedAt}`)

  try {
    await run('verify:verify', {
      address,
      contract: 'contracts/AegisVault/VaultChainlinkOracleV3.sol:VaultChainlinkOracleV3',
      constructorArguments: [description, decimals, [deployer.address], deployer.address],
    })
    console.log('etherscan: verified')
  } catch (e: any) {
    if (/already verified/i.test(e.message)) console.log('etherscan: already verified')
    else console.error(`etherscan verification failed: ${e.message}`)
  }

  console.log(`\nMock feed ready: ${address}`)
  console.log('Use this address in the Manage JUSD tab -> Ondo leg -> "Set feed" (with a large heartbeat).')
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
