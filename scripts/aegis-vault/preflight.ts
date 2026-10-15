import { ethers } from 'hardhat'
import { settings as c, checkNetwork } from './common'
async function main() {
  await checkNetwork()
  const [signer] = await ethers.getSigners()
  const collateral = await ethers.getContractAt('IERC20Metadata', c.asset)
  console.log(JSON.stringify({ chainId: c.chainId, deployer: signer.address, configuredAdmin: c.admin, fees: JSON.parse(JSON.stringify(await ethers.provider.getFeeData(), (_, v) => typeof v === "bigint" ? v.toString() : v)), latestNonce: await ethers.provider.getTransactionCount(signer.address, "latest"), pendingNonce: await ethers.provider.getTransactionCount(signer.address, "pending"), testEth: ethers.formatEther(await ethers.provider.getBalance(signer.address)), collateral: c.asset, symbol: await collateral.symbol(), decimals: Number(await collateral.decimals()), testCollateralBalance: (await collateral.balanceOf(signer.address)).toString(), endpointHasCode: await ethers.provider.getCode(c.layerZeroEndpoint) !== '0x' }, null, 2))
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
