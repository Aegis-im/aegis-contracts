// scripts/jusd/deploy-aegis-minting-jusd.js
const { ethers } = require('hardhat')
const { updateNetworksConfig, getNetworksConfig } = require('../../utils/helpers')
const fs = require('fs')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Read network configuration
  const config = getNetworksConfig()
  if (!config || !config.networks || !config.networks[network.name]) {
    console.log('⚠️  Network not found in config, will use environment variables only')
  }

  const networkConfig = config?.networks?.[network.name] || {}
  const contracts = networkConfig.contracts || {}

  // Get parameters from environment variables or config
  // --------------------------------------------------------------------

  const initialOwner = process.env.INITIAL_OWNER || deployer.address
  console.log('Initial Owner:', initialOwner)

  // Get required contract addresses from config or env
  const jusdAddress = contracts.jusdAddress || process.env.JUSD_ADDRESS
  if (!jusdAddress) {
    throw new Error('Please provide JUSD_ADDRESS in environment or deploy JUSD first')
  }
  console.log('JUSD Address:', jusdAddress)

  const aegisConfigAddress = contracts.aegisConfigAddress || process.env.AEGIS_CONFIG_ADDRESS
  if (!aegisConfigAddress) {
    throw new Error('Please provide AEGIS_CONFIG_ADDRESS in environment or deploy AegisConfig first')
  }
  console.log('AegisConfig Address:', aegisConfigAddress)

  const aegisOracleJUSDAddress = contracts.aegisOracleJUSDAddress || process.env.AEGIS_ORACLE_JUSD_ADDRESS
  if (!aegisOracleJUSDAddress) {
    throw new Error('Please provide AEGIS_ORACLE_JUSD_ADDRESS in environment or deploy AegisOracleJUSD first')
  }
  console.log('AegisOracleJUSD Address:', aegisOracleJUSDAddress)

  // Insurance Fund address
  const insuranceFundAddress = process.env.INSURANCE_FUND_ADDRESS || deployer.address
  console.log('Insurance Fund Address:', insuranceFundAddress)

  // Asset details
  const assetAddresses = process.env.ASSET_ADDRESSES ? process.env.ASSET_ADDRESSES.split(',') : []
  if (assetAddresses.length === 0) {
    throw new Error('Please provide at least one asset address in ASSET_ADDRESSES environment variable')
  }

  const lockupPeriods = process.env.LOCKUP_PERIODS
    ? process.env.LOCKUP_PERIODS.split(',').map((period) => Number(period))
    : assetAddresses.map(() => 86400) // Default 1 day

  const custodianAddresses = process.env.CUSTODIAN_ADDRESSES
    ? process.env.CUSTODIAN_ADDRESSES.split(',')
    : [process.env.CUSTODIAN_ADDRESS || deployer.address]

  if (assetAddresses.length !== lockupPeriods.length) {
    throw new Error('ASSET_ADDRESSES and LOCKUP_PERIODS must have the same length')
  }

  console.log('Assets:', assetAddresses)
  console.log('Lockup Periods:', lockupPeriods)
  console.log('Custodians:', custodianAddresses)

  // --------------------------------------------------------------------
  // DEPLOYMENT
  // --------------------------------------------------------------------

  console.log('\nDeploying AegisMintingJUSD...')
  const AegisMintingJUSD = await ethers.getContractFactory('AegisMintingJUSD')
  const aegisMintingJUSDContract = await AegisMintingJUSD.deploy(
    jusdAddress,
    aegisConfigAddress,
    ethers.ZeroAddress, // No AegisRewards for JUSD
    aegisOracleJUSDAddress,
    ethers.ZeroAddress, // No Feed Registry for JUSD
    insuranceFundAddress,
    assetAddresses,
    lockupPeriods,
    custodianAddresses,
    initialOwner,
  )
  await aegisMintingJUSDContract.waitForDeployment()
  const aegisMintingJUSDAddress = await aegisMintingJUSDContract.getAddress()
  console.log('AegisMintingJUSD deployed to:', aegisMintingJUSDAddress)

  // --------------------------------------------------------------------
  // CONFIGURATION (optional, commented out by default)
  // --------------------------------------------------------------------

  // console.log('\nSetting up connections between contracts...')
  //
  // // Set AegisMintingJUSD as JUSD minter
  // console.log('Setting AegisMintingJUSD as JUSD minter...')
  // const jusdContract = await ethers.getContractAt('JUSD', jusdAddress)
  // const setMinterTx = await jusdContract.setMinter(aegisMintingJUSDAddress)
  // await setMinterTx.wait()
  // console.log('✅ AegisMintingJUSD set as JUSD minter')

  // Update networks.json
  updateNetworksConfig(network.name, {
    aegisMintingJUSDAddress: aegisMintingJUSDAddress,
  })

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('AegisMintingJUSD:', aegisMintingJUSDAddress)

  // Create verification arguments file
  const verifyArgsContent = `module.exports = [
  "${jusdAddress}",
  "${aegisConfigAddress}",
  "${ethers.ZeroAddress}",
  "${aegisOracleJUSDAddress}",
  "${ethers.ZeroAddress}",
  "${insuranceFundAddress}",
  [${assetAddresses.map((addr) => `"${addr}"`).join(', ')}],
  [${lockupPeriods.join(', ')}],
  [${custodianAddresses.map((addr) => `"${addr}"`).join(', ')}],
  "${initialOwner}"
];`

  const verifyArgsPath = `aegis-minting-jusd-args-${network.name}.js`
  fs.writeFileSync(verifyArgsPath, verifyArgsContent)

  console.log(`\n📝 Created verification arguments file: ${verifyArgsPath}`)
  console.log('\nVerification command:')
  console.log(
    `npx hardhat verify --network ${network.name} --contract contracts/AegisMintingJUSD.sol:AegisMintingJUSD ${aegisMintingJUSDAddress} --constructor-args ${verifyArgsPath}`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
