// scripts/deploy-local-full.js
// Deploys all contracts for local testing including new contracts (AegisIncomeRouter, AegisRewardsV2, sJUSD with cooldown)
const { ethers, upgrades } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)
  console.log('Account balance:', (await ethers.provider.getBalance(deployer.address)).toString())

  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name, 'ChainID:', network.chainId)

  const initialOwner = deployer.address
  const trustedSigner = deployer.address
  const insuranceFundAddress = deployer.address
  const operators = [deployer.address]

  // Deploy mock ERC20 tokens for collateral
  console.log('\n--- Deploying Mock Collateral Tokens ---')

  const TestToken = await ethers.getContractFactory('TestToken')

  const usdc = await TestToken.deploy('USD Coin', 'USDC', 6)
  await usdc.waitForDeployment()
  const usdcAddress = await usdc.getAddress()
  console.log('Mock USDC deployed to:', usdcAddress)

  const usdt = await TestToken.deploy('Tether', 'USDT', 6)
  await usdt.waitForDeployment()
  const usdtAddress = await usdt.getAddress()
  console.log('Mock USDT deployed to:', usdtAddress)

  // Mint some tokens to deployer
  await usdc.mint(deployer.address, ethers.parseUnits('1000000', 6))
  await usdt.mint(deployer.address, ethers.parseUnits('1000000', 6))
  console.log('Minted 1M USDC and USDT to deployer')

  // ---------------------------------------------------
  // YUSD SYSTEM DEPLOYMENT
  // ---------------------------------------------------
  console.log('\n--- Deploying YUSD System ---')

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

  // 4. Deploy AegisRewards (V1)
  console.log('\n4. Deploying AegisRewards...')
  const AegisRewards = await ethers.getContractFactory('AegisRewards')
  const aegisRewardsContract = await AegisRewards.deploy(yusdAddress, aegisConfigAddress, initialOwner)
  await aegisRewardsContract.waitForDeployment()
  const aegisRewardsAddress = await aegisRewardsContract.getAddress()
  console.log('AegisRewards deployed to:', aegisRewardsAddress)

  // 5. Deploy Mock Feed Registry
  console.log('\n5. Deploying Mock Feed Registry...')
  const FeedRegistry = await ethers.getContractFactory('FeedRegistry')
  const feedRegistry = await FeedRegistry.deploy()
  await feedRegistry.waitForDeployment()
  const feedRegistryAddress = await feedRegistry.getAddress()
  console.log('Mock Feed Registry deployed to:', feedRegistryAddress)

  // USD quote address (standard Chainlink USD denominator)
  const USD = '0x0000000000000000000000000000000000000348'

  // Set prices in feed registry (1 USDC = 1 USD, 1 USDT = 1 USD)
  await feedRegistry.setPrice(usdcAddress, USD, ethers.parseUnits('1', 8))
  await feedRegistry.setPrice(usdtAddress, USD, ethers.parseUnits('1', 8))
  console.log('Set mock prices in Feed Registry')

  // 6. Deploy AegisMinting (YUSD)
  console.log('\n6. Deploying AegisMinting (YUSD)...')
  const AegisMinting = await ethers.getContractFactory('AegisMinting')
  const aegisMintingContract = await AegisMinting.deploy(
    yusdAddress,
    aegisConfigAddress,
    aegisRewardsAddress,
    aegisOracleAddress,
    feedRegistryAddress,
    insuranceFundAddress,
    [usdcAddress, usdtAddress], // supported assets
    [86400, 86400], // lockup periods
    [], // custodians
    initialOwner
  )
  await aegisMintingContract.waitForDeployment()
  const aegisMintingAddress = await aegisMintingContract.getAddress()
  console.log('AegisMinting deployed to:', aegisMintingAddress)

  // 7. Deploy sYUSD (Staked YUSD) - Upgradeable
  console.log('\n7. Deploying sYUSD (upgradeable)...')
  const SYUSD = await ethers.getContractFactory('sYUSD')
  const syusdProxy = await upgrades.deployProxy(
    SYUSD,
    [yusdAddress, initialOwner],
    {
      kind: 'transparent',
      initializer: 'initialize',
      unsafeAllow: ['constructor', 'delegatecall'],
    }
  )
  await syusdProxy.waitForDeployment()
  const syusdAddress = await syusdProxy.getAddress()
  console.log('sYUSD deployed to:', syusdAddress)

  // ---------------------------------------------------
  // JUSD SYSTEM DEPLOYMENT
  // ---------------------------------------------------
  console.log('\n--- Deploying JUSD System ---')

  // 8. Deploy JUSD
  console.log('\n8. Deploying JUSD token...')
  const JUSD = await ethers.getContractFactory('JUSD')
  const jusdContract = await JUSD.deploy(initialOwner)
  await jusdContract.waitForDeployment()
  const jusdAddress = await jusdContract.getAddress()
  console.log('JUSD deployed to:', jusdAddress)

  // 9. Deploy AegisOracleJUSD
  console.log('\n9. Deploying AegisOracleJUSD...')
  const AegisOracleJUSD = await ethers.getContractFactory('AegisOracleJUSD')
  const aegisOracleJUSDContract = await AegisOracleJUSD.deploy(operators, initialOwner)
  await aegisOracleJUSDContract.waitForDeployment()
  const aegisOracleJUSDAddress = await aegisOracleJUSDContract.getAddress()
  console.log('AegisOracleJUSD deployed to:', aegisOracleJUSDAddress)

  // 10. Deploy AegisMintingJUSD
  console.log('\n10. Deploying AegisMintingJUSD...')
  const AegisMintingJUSD = await ethers.getContractFactory('AegisMintingJUSD')
  const aegisMintingJUSDContract = await AegisMintingJUSD.deploy(
    jusdAddress,
    aegisConfigAddress,
    aegisRewardsAddress, // Using same rewards for now
    aegisOracleJUSDAddress,
    feedRegistryAddress,
    insuranceFundAddress,
    [usdcAddress, usdtAddress],
    [86400, 86400],
    [],
    initialOwner
  )
  await aegisMintingJUSDContract.waitForDeployment()
  const aegisMintingJUSDAddress = await aegisMintingJUSDContract.getAddress()
  console.log('AegisMintingJUSD deployed to:', aegisMintingJUSDAddress)

  // 11. Deploy sJUSD (Staked JUSD with cooldown) - Upgradeable
  console.log('\n11. Deploying sJUSD (upgradeable)...')
  const SJUSD = await ethers.getContractFactory('sJUSD')
  const sjusdProxy = await upgrades.deployProxy(
    SJUSD,
    [jusdAddress, initialOwner],
    {
      kind: 'transparent',
      initializer: 'initialize',
      unsafeAllow: ['constructor', 'delegatecall'],
    }
  )
  await sjusdProxy.waitForDeployment()
  const sjusdAddress = await sjusdProxy.getAddress()
  console.log('sJUSD deployed to:', sjusdAddress)

  // ---------------------------------------------------
  // NEW CONTRACTS DEPLOYMENT
  // ---------------------------------------------------
  console.log('\n--- Deploying New Contracts ---')

  // 12. Deploy AegisIncomeRouter
  console.log('\n12. Deploying AegisIncomeRouter...')
  let aegisIncomeRouterAddress = ethers.ZeroAddress
  try {
    const AegisIncomeRouter = await ethers.getContractFactory('AegisIncomeRouter')
    const aegisIncomeRouterContract = await AegisIncomeRouter.deploy(
      yusdAddress,
      aegisMintingAddress,
      aegisRewardsAddress,
      initialOwner,
      0 // initialDelay - 0 for local testing
    )
    await aegisIncomeRouterContract.waitForDeployment()
    aegisIncomeRouterAddress = await aegisIncomeRouterContract.getAddress()
    console.log('AegisIncomeRouter deployed to:', aegisIncomeRouterAddress)
  } catch (e) {
    console.log('AegisIncomeRouter deployment skipped (contract may not exist):', e.message)
  }

  // 13. Deploy AegisRewardsV2
  console.log('\n13. Deploying AegisRewardsV2...')
  let aegisRewardsV2Address = ethers.ZeroAddress
  try {
    const AegisRewardsV2 = await ethers.getContractFactory('AegisRewardsV2')
    const aegisRewardsV2Contract = await AegisRewardsV2.deploy(
      yusdAddress,
      aegisConfigAddress,
      initialOwner,
      true // isMainChain
    )
    await aegisRewardsV2Contract.waitForDeployment()
    aegisRewardsV2Address = await aegisRewardsV2Contract.getAddress()
    console.log('AegisRewardsV2 deployed to:', aegisRewardsV2Address)
  } catch (e) {
    console.log('AegisRewardsV2 deployment skipped (contract may not exist):', e.message)
  }

  // ---------------------------------------------------
  // CONFIGURATION
  // ---------------------------------------------------
  console.log('\n--- Configuring Contracts ---')

  // Set YUSD minter
  console.log('Setting AegisMinting as YUSD minter...')
  await yusdContract.setMinter(aegisMintingAddress)

  // Set JUSD minter
  console.log('Setting AegisMintingJUSD as JUSD minter...')
  await jusdContract.setMinter(aegisMintingJUSDAddress)

  // Set AegisMinting in AegisRewards
  console.log('Setting AegisMinting address in AegisRewards...')
  await aegisRewardsContract.setAegisMintingAddress(aegisMintingAddress)

  // Set initial YUSD oracle price to $1
  console.log('Setting initial YUSD price in oracle...')
  await aegisOracleContract.updateYUSDPrice(ethers.parseUnits('1', 8))

  // Set initial JUSD oracle price to $1
  console.log('Setting initial JUSD price in oracle...')
  await aegisOracleJUSDContract.updateJUSDPrice(ethers.parseUnits('1', 8))

  // ---------------------------------------------------
  // OUTPUT DEPLOYMENT INFO
  // ---------------------------------------------------
  console.log('\n=======================================')
  console.log('DEPLOYMENT SUMMARY')
  console.log('=======================================')
  console.log('Network ChainID:', network.chainId.toString())
  console.log('')
  console.log('--- Mock Tokens ---')
  console.log('USDC:', usdcAddress)
  console.log('USDT:', usdtAddress)
  console.log('')
  console.log('--- YUSD System ---')
  console.log('YUSD:', yusdAddress)
  console.log('sYUSD:', syusdAddress)
  console.log('AegisConfig:', aegisConfigAddress)
  console.log('AegisOracle:', aegisOracleAddress)
  console.log('AegisRewards:', aegisRewardsAddress)
  console.log('AegisMinting:', aegisMintingAddress)
  console.log('FeedRegistry:', feedRegistryAddress)
  console.log('')
  console.log('--- JUSD System ---')
  console.log('JUSD:', jusdAddress)
  console.log('sJUSD:', sjusdAddress)
  console.log('AegisOracleJUSD:', aegisOracleJUSDAddress)
  console.log('AegisMintingJUSD:', aegisMintingJUSDAddress)
  console.log('')
  console.log('--- New Contracts ---')
  console.log('AegisIncomeRouter:', aegisIncomeRouterAddress)
  console.log('AegisRewardsV2:', aegisRewardsV2Address)
  console.log('=======================================')

  // Output as JSON for easy parsing
  const deploymentInfo = {
    chainId: network.chainId.toString(),
    deployer: deployer.address,
    mockTokens: {
      usdc: usdcAddress,
      usdt: usdtAddress,
    },
    yusdSystem: {
      yusd: yusdAddress,
      syusd: syusdAddress,
      aegisConfig: aegisConfigAddress,
      aegisOracle: aegisOracleAddress,
      aegisRewards: aegisRewardsAddress,
      aegisMinting: aegisMintingAddress,
      feedRegistry: feedRegistryAddress,
    },
    jusdSystem: {
      jusd: jusdAddress,
      sjusd: sjusdAddress,
      aegisOracleJUSD: aegisOracleJUSDAddress,
      aegisMintingJUSD: aegisMintingJUSDAddress,
    },
    newContracts: {
      aegisIncomeRouter: aegisIncomeRouterAddress,
      aegisRewardsV2: aegisRewardsV2Address,
    },
  }

  console.log('\n--- JSON Output ---')
  console.log(JSON.stringify(deploymentInfo, null, 2))

  // Write to file for server to read
  const fs = require('fs')
  fs.writeFileSync('deployment-local.json', JSON.stringify(deploymentInfo, null, 2))
  console.log('\nDeployment info written to deployment-local.json')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
