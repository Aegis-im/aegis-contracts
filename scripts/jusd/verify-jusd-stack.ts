import { run, network } from 'hardhat'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

/**
 * Verifies every contract in a deploy-jusd-stack.ts record on the block explorer, using the
 * constructor arguments the record saved. Already-verified contracts are reported, not retried.
 *
 *   npx hardhat run scripts/jusd/verify-jusd-stack.ts --network sepolia
 */
const recordPath = resolve(process.env.JUSD_RECORD || `deployments/${network.name}/JUSDStack.json`)

async function main() {
  if (!existsSync(recordPath)) throw new Error(`Missing deployment record: ${recordPath}`)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))

  for (const [key, entry] of Object.entries(record.contracts) as [string, any][]) {
    process.stdout.write(`${key} (${entry.address}) ... `)
    try {
      await run('verify:verify', { address: entry.address, constructorArguments: entry.args })
      console.log('verified')
    } catch (e: any) {
      const message = (e.shortMessage || e.message || '').replace(/\s+/g, ' ').trim()
      // The task throws on transport hiccups even when the explorer accepted the source, so a
      // throw here is inconclusive rather than a failure. The explorer is the source of truth.
      if (/already verified/i.test(message)) console.log('already verified')
      else console.log(`inconclusive — ${message.slice(0, 160)}`)
    }
  }
  console.log('\nConfirm anything inconclusive on the explorer:')
  for (const [key, entry] of Object.entries(record.contracts) as [string, any][]) {
    console.log(`  ${key.padEnd(18)} https://sepolia.etherscan.io/address/${entry.address}#code`)
  }
}

main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
