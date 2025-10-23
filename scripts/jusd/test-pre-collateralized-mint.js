// scripts/jusd/test-pre-collateralized-mint.js
const { ethers } = require('hardhat')

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Testing pre-collateralized mint with account:', deployer.address)

  const network = await ethers.provider.getNetwork()
  console.log('Network:', network.name)

  // Get contract addresses from environment or config
  const jusdAddress = process.env.JUSD_ADDRESS || '0xC832f4063D654aC62708c67F9B079dC6186eA406'
  const aegisMintingJUSDAddress = process.env.AEGIS_MINTING_JUSD_ADDRESS || '0xE0FA3992a0c1390199C06aaf250d9BE3fFf473DE'
  const testRecipient = process.env.TEST_RECIPIENT || deployer.address

  console.log('\nContract addresses:')
  console.log('JUSD:', jusdAddress)
  console.log('AegisMintingJUSD:', aegisMintingJUSDAddress)
  console.log('Test recipient:', testRecipient)

  // Connect to contracts
  const jusd = await ethers.getContractAt('JUSD', jusdAddress)
  const aegisMinting = await ethers.getContractAt('AegisMintingJUSD', aegisMintingJUSDAddress)

  // Check balances before
  console.log('\n=== BEFORE MINT ===')
  const balanceBefore = await jusd.balanceOf(testRecipient)
  console.log('Recipient JUSD balance:', ethers.formatEther(balanceBefore))

  const totalSupplyBefore = await jusd.totalSupply()
  console.log('Total JUSD supply:', ethers.formatEther(totalSupplyBefore))

  // Check current pre-collateralized minter
  const currentMinter = await aegisMinting.preCollateralizedMinter()
  console.log('Current pre-collateralized minter:', currentMinter)

  // Set pre-collateralized minter if needed
  if (currentMinter.toLowerCase() !== deployer.address.toLowerCase()) {
    console.log('\nSetting deployer as pre-collateralized minter...')
    const setMinterTx = await aegisMinting.setPreCollateralizedMinter(deployer.address)
    await setMinterTx.wait()
    console.log('✅ Pre-collateralized minter set')
  }

  // Mint pre-collateralized JUSD
  const mintAmount = ethers.parseEther('100') // 100 JUSD
  console.log('\nMinting pre-collateralized JUSD...')
  console.log('Amount:', ethers.formatEther(mintAmount), 'JUSD')

  const mintTx = await aegisMinting.mintPreCollateralized(testRecipient, mintAmount)
  const receipt = await mintTx.wait()
  console.log('✅ Mint successful, tx hash:', receipt.hash)

  // Check balances after
  console.log('\n=== AFTER MINT ===')
  const balanceAfter = await jusd.balanceOf(testRecipient)
  console.log('Recipient JUSD balance:', ethers.formatEther(balanceAfter))

  const totalSupplyAfter = await jusd.totalSupply()
  console.log('Total JUSD supply:', ethers.formatEther(totalSupplyAfter))

  // Calculate changes
  const balanceChange = balanceAfter - balanceBefore
  const supplyChange = totalSupplyAfter - totalSupplyBefore

  console.log('\n=== CHANGES ===')
  console.log('Recipient balance change:', ethers.formatEther(balanceChange), 'JUSD')
  console.log('Total supply change:', ethers.formatEther(supplyChange), 'JUSD')

  if (balanceChange === mintAmount) {
    console.log('✅ Pre-collateralized mint test PASSED')
  } else {
    console.log('❌ Pre-collateralized mint test FAILED')
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })

