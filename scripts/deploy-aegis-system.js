// scripts/deploy-aegis-system.js
const { ethers } = require('hardhat')
const { updateNetworksConfig } = require('../utils/helpers')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)

  // Get network
  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get parameters from environment variables or use defaults
  // --------------------------------------------------------------------

  // 1. YUSD parameters
  const initialOwner = process.env.INITIAL_OWNER || deployer.address
  console.log('Initial Owner:', initialOwner)

  // 2. AegisConfig parameters
  const trustedSigner = process.env.TRUSTED_SIGNER_ADDRESS || deployer.address
  if (!trustedSigner) {
    throw new Error('Please provide TRUSTED_SIGNER_ADDRESS environment variable')
  }
  console.log('Trusted Signer:', trustedSigner)

  // Initial operators (can be empty array)
  const operators = process.env.OPERATORS ? process.env.OPERATORS.split(',') : []
  console.log('Initial Operators:', operators)

  // 3. AegisMinting parameters
  const insuranceFundAddress = process.env.INSURANCE_FUND_ADDRESS || deployer.address
  if (!insuranceFundAddress) {
    throw new Error('Please provide INSURANCE_FUND_ADDRESS environment variable')
  }
  console.log('Insurance Fund Address:', insuranceFundAddress)

  // Asset details
  const assetAddresses = process.env.ASSET_ADDRESSES ? process.env.ASSET_ADDRESSES.split(',') : []
  if (assetAddresses.length === 0) {
    throw new Error('Please provide at least one asset address in ASSET_ADDRESSES environment variable')
  }

  const lockupPeriods = process.env.LOCKUP_PERIODS ? process.env.LOCKUP_PERIODS.split(',').map(period => Number(period)) : assetAddresses.map(() => 86400) // Default 1 day
  const custodianAddresses = process.env.CUSTODIAN_ADDRESSES ? process.env.CUSTODIAN_ADDRESSES.split(',') : assetAddresses.map(() => process.env.CUSTODIAN_ADDRESS || deployer.address)

  if (assetAddresses.length !== lockupPeriods.length || assetAddresses.length !== custodianAddresses.length) {
    throw new Error('ASSET_ADDRESSES, LOCKUP_PERIODS and CUSTODIAN_ADDRESSES must have the same length')
  }

  console.log('Assets:', assetAddresses)
  console.log('Lockup Periods:', lockupPeriods)
  console.log('Custodians:', custodianAddresses)

  // --------------------------------------------------------------------
  // DEPLOYMENT SEQUENCE
  // --------------------------------------------------------------------

  // 1. Deploy YUSD
  console.log('\n1. Deploying YUSD token...')
  const YUSD = await ethers.getContractFactory('YUSD')
  const yusdContract = await YUSD.deploy(initialOwner)
  await yusdContract.waitForDeployment()
  const yusdAddress = await yusdContract.getAddress()
  console.log('YUSD deployed to:', yusdAddress)

  // 2. Deploy AegisConfig
  console.log('\n2. Deploying AegisConfig...')
  const AegisConfig = await ethers.getContractFactory('AegisConfig')
  const aegisConfigContract = await AegisConfig.deploy(trustedSigner, operators, initialOwner)
  await aegisConfigContract.waitForDeployment()
  const aegisConfigAddress = await aegisConfigContract.getAddress()
  console.log('AegisConfig deployed to:', aegisConfigAddress)

  // 3. Deploy AegisOracle
  console.log('\n3. Deploying AegisOracle...')
  const AegisOracle = await ethers.getContractFactory('AegisOracle')
  const aegisOracleContract = await AegisOracle.deploy(operators, initialOwner)
  await aegisOracleContract.waitForDeployment()
  const aegisOracleAddress = await aegisOracleContract.getAddress()
  console.log('AegisOracle deployed to:', aegisOracleAddress)

  // 4. Deploy AegisRewards
  console.log('\n4. Deploying AegisRewards...')
  const AegisRewards = await ethers.getContractFactory('AegisRewards')
  const aegisRewardsContract = await AegisRewards.deploy(
    yusdAddress,
    aegisConfigAddress,
    initialOwner,
  )
  await aegisRewardsContract.waitForDeployment()
  const aegisRewardsAddress = await aegisRewardsContract.getAddress()
  console.log('AegisRewards deployed to:', aegisRewardsAddress)

  // 5. Deploy AegisMinting
  console.log('\n5. Deploying AegisMinting...')
  const AegisMinting = await ethers.getContractFactory('AegisMinting')
  const aegisMintingContract = await AegisMinting.deploy(
    yusdAddress,
    aegisConfigAddress,
    aegisRewardsAddress,
    aegisOracleAddress,
    '0x4CE6563330166122DBe372Ad7ec175b7783a0FC0', // Feed Registry address
    insuranceFundAddress,
    assetAddresses,
    lockupPeriods,
    [],
    initialOwner,
  )
  await aegisMintingContract.waitForDeployment()
  const aegisMintingAddress = await aegisMintingContract.getAddress()
  console.log('AegisMinting deployed to:', aegisMintingAddress)

  // --------------------------------------------------------------------
  // CONFIGURATION
  // --------------------------------------------------------------------

  console.log('\nSetting up connections between contracts...')

  // Set AegisMinting as YUSD minter
  console.log('Setting AegisMinting as YUSD minter...')
  const setMinterTx = await yusdContract.setMinter(aegisMintingAddress)
  await setMinterTx.wait()

  // Set AegisMinting address in AegisRewards
  console.log('Setting AegisMinting address in AegisRewards...')
  const setAegisMintingAddressTx = await aegisRewardsContract.setAegisMintingAddress(aegisMintingAddress)
  await setAegisMintingAddressTx.wait()

  // --------------------------------------------------------------------
  // VERIFICATION INFO
  // --------------------------------------------------------------------

  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('YUSD:', yusdAddress)
  console.log('AegisConfig:', aegisConfigAddress)
  console.log('AegisOracle:', aegisOracleAddress)
  console.log('AegisRewards:', aegisRewardsAddress)
  console.log('AegisMinting:', aegisMintingAddress)

  console.log('\nVerification commands:')
  console.log(`npx hardhat verify --network ${network.name} ${yusdAddress} "${initialOwner}"`)

  // For empty arrays, use a special format that Hardhat verify can understand
  if (operators.length === 0) {
    console.log(`npx hardhat verify --network ${network.name} ${aegisConfigAddress} "${trustedSigner}" --constructor-args-path empty-array.js "${initialOwner}"`)
    console.log('Create empty-array.js with content:')
    console.log(`module.exports = [
  "${trustedSigner}",
  [],
  "${initialOwner}"
];`)
  } else {
    console.log(`npx hardhat verify --network ${network.name} ${aegisConfigAddress} "${trustedSigner}" ${operators.map(op => `"${op}"`)} "${initialOwner}"`)
  }

  // For AegisOracle
  if (operators.length === 0) {
    console.log(`npx hardhat verify --network ${network.name} ${aegisOracleAddress} --constructor-args-path empty-oracle-array.js "${initialOwner}"`)
    console.log('Create empty-oracle-array.js with content:')
    console.log(`module.exports = [
  [],
  "${initialOwner}"
];`)
  } else {
    console.log(`npx hardhat verify --network ${network.name} ${aegisOracleAddress} ${operators.map(op => `"${op}"`)} "${initialOwner}"`)
  }

  console.log(`npx hardhat verify --network ${network.name} ${aegisRewardsAddress} "${yusdAddress}" "${aegisConfigAddress}" "${initialOwner}"`)

  // For AegisMinting, use constructor-args file approach for empty arrays
  console.log(`npx hardhat verify --network ${network.name} ${aegisMintingAddress} --constructor-args-path minting-args.js`)
  console.log('Create minting-args.js with content:')
  console.log(`module.exports = [
  "${yusdAddress}",
  "${aegisConfigAddress}",
  "${aegisRewardsAddress}",
  "${aegisOracleAddress}",
  "0x4CE6563330166122DBe372Ad7ec175b7783a0FC0",
  "${insuranceFundAddress}",
  ${JSON.stringify(assetAddresses)},
  ${JSON.stringify(lockupPeriods)},
  [],
  "${initialOwner}"
];`)

  // Update networks config
  updateNetworksConfig(network.name, {
    'yusdAddress': yusdAddress,
    'aegisConfigAddress': aegisConfigAddress,
    'aegisOracleAddress': aegisOracleAddress,
    'aegisRewardsAddress': aegisRewardsAddress,
    'aegisMintingAddress': aegisMintingAddress,
    'adminAddress': initialOwner,
  })
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
