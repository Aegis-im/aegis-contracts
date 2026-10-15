import { checkNetwork, loadRecord } from './common'
import { createQuote } from './quotes'
async function main() {
  await checkNetwork()
  if (!process.env.VAULT_USER || !process.env.VAULT_AMOUNT) throw new Error('Set VAULT_USER, VAULT_AMOUNT and optionally VAULT_ORDER_TYPE=1 for redemption')
  console.log(JSON.stringify(await createQuote(loadRecord(), Number(process.env.VAULT_ORDER_TYPE || 0), process.env.VAULT_USER, process.env.VAULT_AMOUNT), null, 2))
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
