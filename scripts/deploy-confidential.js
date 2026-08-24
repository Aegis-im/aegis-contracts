/**
 * Deploys the confidential (ERC-7984 / Zama FHEVM) contracts: cYUSD, csYUSD and the
 * StakeAndWrapRouter, wrapping the network's existing YUSD / sYUSD deployments.
 *
 * The wrappers only work on FHEVM-enabled host chains (Sepolia, Ethereum mainnet).
 * Current Sepolia deployment (already live) is recorded in config/networks.json:
 *   cYUSDAddress, csYUSDAddress, stakeAndWrapRouterAddress
 *
 * Usage: npx hardhat run scripts/deploy-confidential.js --network sepolia
 * Env:   AUDITOR_ADDRESS (optional; defaults to the deployer — the Aegis auditor key that
 *        can decrypt all balances/amounts), OWNER_ADDRESS (optional; defaults to deployer)
 */
const { ethers, network } = require('hardhat')
const networksConfig = require('../config/networks.json')

async function main() {
  const [deployer] = await ethers.getSigners()
  const netCfg = networksConfig.networks[network.name]
  if (!netCfg || !netCfg.contracts) {
    throw new Error(`No networks.json entry for network "${network.name}"`)
  }
  const { yusdAddress, sYUSDAddress } = netCfg.contracts
  if (!yusdAddress || !sYUSDAddress) {
    throw new Error(`networks.json for "${network.name}" is missing yusdAddress/sYUSDAddress`)
  }

  const auditor = process.env.AUDITOR_ADDRESS || deployer.address
  const owner = process.env.OWNER_ADDRESS || deployer.address
  console.log(`Deployer: ${deployer.address}`)
  console.log(`Underlying YUSD:  ${yusdAddress}`)
  console.log(`Underlying sYUSD: ${sYUSDAddress}`)
  console.log(`Auditor: ${auditor}  Owner: ${owner}`)

  const cYusd = await ethers.deployContract('ConfidentialYUSD', [yusdAddress, auditor, owner])
  await cYusd.waitForDeployment()
  console.log(`ConfidentialYUSD (cYUSD): ${await cYusd.getAddress()}`)

  const csYusd = await ethers.deployContract('ConfidentialStakedYUSD', [
    sYUSDAddress,
    yusdAddress,
    auditor,
    owner,
  ])
  await csYusd.waitForDeployment()
  console.log(`ConfidentialStakedYUSD (csYUSD): ${await csYusd.getAddress()}`)

  const router = await ethers.deployContract('StakeAndWrapRouter', [
    yusdAddress,
    sYUSDAddress,
    await csYusd.getAddress(),
  ])
  await router.waitForDeployment()
  console.log(`StakeAndWrapRouter: ${await router.getAddress()}`)

  console.log('\nRecord these addresses in config/networks.json (cYUSDAddress, csYUSDAddress, stakeAndWrapRouterAddress).')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
