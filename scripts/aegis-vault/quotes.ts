import { ethers } from 'hardhat'
import { randomBytes, randomUUID } from 'crypto'
import { orderTypes } from './common'

// Shared by the local testnet quote service and the operator CLI. Never exported to the browser.
export async function createQuote(record: any, type: number, wallet: string, amount: string) {
  if (record.chainId !== 11155111 || Number((await ethers.provider.getNetwork()).chainId) !== 11155111) throw new Error('Quote helper is Sepolia-only')
  if (![0, 1].includes(type) || !/^\d+(\.\d+)?$/.test(amount)) throw new Error('Invalid quote request')
  const userWallet = ethers.getAddress(wallet), asset = record.settings.asset
  const minting: any = await ethers.getContractAt('VaultMinting', record.contracts.minting.address)
  const config: any = await ethers.getContractAt('VaultConfig', await minting.aegisConfig())
  const [signer] = await ethers.getSigners()
  if (signer.address.toLowerCase() !== (await config.trustedSigner()).toLowerCase()) throw new Error('Configured signing key does not match trusted signer')
  if (!await config.isWhitelisted(userWallet)) throw new Error('Wallet is not eligible')
  if (await minting[type === 0 ? 'mintPaused' : 'redeemPaused']()) throw new Error('Operation is paused')
  const token: any = await ethers.getContractAt('VaultToken', record.contracts.token.address)
  if (await token.isBlackListed(userWallet)) throw new Error('Wallet is blacklisted')
  const collateral = await ethers.getContractAt('IERC20Metadata', asset)
  const value = ethers.parseUnits(amount, type === 0 ? Number(await collateral.decimals()) : 18)
  if (value <= 0n || Number(amount) > 1000) throw new Error('Testnet quote limit is 1,000 units per request')
  const collateralAmount = type === 0 ? value : await minting.quoteRedeem(asset, value)
  const tokenAmount = type === 0 ? await minting.quoteMint(asset, value) : value
  const redeemFee = Number(await minting.redeemFeeBP())
  const feeActive = await minting.insuranceFundAddress() !== ethers.ZeroAddress
  const floor = type === 0 ? tokenAmount : await minting.quoteRedeem(asset, tokenAmount - (feeActive ? tokenAmount * BigInt(redeemFee) / 10000n : 0n))
  if (floor === 0n) throw new Error('Amount too small')
  const block = await ethers.provider.getBlock('latest'); if (!block) throw new Error('Missing latest block')
  const requestId = randomUUID()
  const order = { orderType: type, userWallet, collateralAsset: asset, collateralAmount: collateralAmount.toString(), tokenAmount: tokenAmount.toString(), slippageAdjustedAmount: (floor * 9990n / 10000n).toString(), expiry: block.timestamp + (type === 0 ? 900 : 30 * 86400), nonce: BigInt('0x' + randomBytes(16).toString('hex')).toString(), additionalData: ethers.AbiCoder.defaultAbiCoder().encode(['string'], [requestId]) }
  const domain = { name: await minting.domainName(), version: '1', chainId: record.chainId, verifyingContract: minting.target }
  const signature = await signer.signTypedData(domain, orderTypes, order)
  return { domain, order, signature, requestId }
}
