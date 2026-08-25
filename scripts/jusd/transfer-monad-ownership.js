/**
 * Transfers ownership of all Monad OFTs from deployer to multisig.
 *
 * Usage: npx hardhat run scripts/jusd/transfer-monad-ownership.js --network monad
 */
const { ethers, network } = require('hardhat')

const NEW_OWNER = '0x4Fe78eF65BD8EDDED480efaB030BA680646503c8'

const CONTRACTS = [
  { name: 'YUSDOFT',  address: '0xca2671Dcd031a72359f456C212F62A9bDa737cD7' },
  { name: 'sYUSDOFT', address: '0xF07781182B47e728B040f9e35321260e359fF9f7' },
  { name: 'JUSDOFT',  address: '0x7C94288E79F6De6E9Baf2e5029CB94CFf032fd69' },
  { name: 'sJUSDOFT', address: '0xCFA67e9Da72af570e7f8344B7738D6BdF698BD20' },
]

const abi = [
  'function owner() view returns (address)',
  'function transferOwnership(address newOwner)',
]

async function main() {
  if (network.name !== 'monad') {
    throw new Error(`Must run on monad network, got: ${network.name}`)
  }

  const [deployer] = await ethers.getSigners()
  console.log(`Deployer: ${deployer.address}`)
  console.log(`New owner: ${NEW_OWNER}\n`)

  for (const { name, address } of CONTRACTS) {
    const contract = await ethers.getContractAt(abi, address)
    const currentOwner = await contract.owner()

    if (currentOwner.toLowerCase() === NEW_OWNER.toLowerCase()) {
      console.log(`✅ ${name} already owned by multisig, skipping`)
      continue
    }

    if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
      console.log(`⚠️  ${name} owner is ${currentOwner}, not deployer — skipping`)
      continue
    }

    console.log(`Transferring ${name} (${address})...`)
    const tx = await contract.transferOwnership(NEW_OWNER)
    await tx.wait()

    const newOwner = await contract.owner()
    if (newOwner.toLowerCase() !== NEW_OWNER.toLowerCase()) {
      throw new Error(`❌ ${name} owner mismatch after transfer: ${newOwner}`)
    }
    console.log(`✅ ${name} ownership transferred`)
  }

  console.log('\nDone. Verify:')
  for (const { address } of CONTRACTS) {
    console.log(`  npx hardhat verify --network monad ${address}`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })
