import { ethers, network } from 'hardhat'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'

export const configPath = resolve(process.env.VAULT_CONFIG || 'config/AegisVault/amina.sepolia.json')
export const settings = JSON.parse(readFileSync(configPath, 'utf8'))
export const recordPath = resolve(process.env.VAULT_RECORD || `deployments/${network.name}/AegisVault.${settings.id}.json`)
export function loadRecord(): any {
  if (!existsSync(recordPath)) throw new Error(`Missing deployment: ${recordPath}`)
  return JSON.parse(readFileSync(recordPath, 'utf8'))
}
export function saveRecord(record: any) {
  mkdirSync(dirname(recordPath), { recursive: true })
  writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n')
}
export async function checkNetwork() {
  const chain = Number((await ethers.provider.getNetwork()).chainId)
  if (chain !== settings.chainId) throw new Error(`Expected chain ${settings.chainId}, got ${chain}`)
  return chain
}
export const orderTypes = { Order: [
  { name: 'orderType', type: 'uint8' }, { name: 'userWallet', type: 'address' },
  { name: 'collateralAsset', type: 'address' }, { name: 'collateralAmount', type: 'uint256' },
  { name: 'tokenAmount', type: 'uint256' }, { name: 'slippageAdjustedAmount', type: 'uint256' },
  { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'additionalData', type: 'bytes' },
] }
export async function confirmed(tx: any) { const receipt = await tx.wait(1); if (receipt?.status !== 1) throw new Error('Transaction failed'); return receipt }
