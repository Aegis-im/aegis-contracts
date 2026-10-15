import { createServer } from 'http'
import { checkNetwork, loadRecord } from './common'
import { createQuote } from './quotes'

async function main() {
  await checkNetwork()
  const record = loadRecord()
  if (record.chainId !== 11155111) throw new Error('Local quote server is Sepolia-only')
  const origins = (process.env.VAULT_QUOTE_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000').split(',')
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (req.headers.origin) {
      if (!origins.includes(req.headers.origin)) { res.writeHead(403); res.end('{"error":"Origin not allowed"}'); return }
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin)
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    if (req.method === 'GET' && req.url === '/health') { res.end(JSON.stringify({ chainId: record.chainId, minting: record.contracts.minting.address })); return }
    if (req.method !== 'POST' || req.url !== '/quote') { res.writeHead(404); res.end('{}'); return }
    try {
      let raw = ''
      for await (const chunk of req) { raw += chunk; if (raw.length > 4096) throw new Error('Request too large') }
      const body = JSON.parse(raw)
      const result = await createQuote(record, body.orderType, body.wallet, body.amount)
      res.end(JSON.stringify(result))
    } catch (error: any) { res.writeHead(400); res.end(JSON.stringify({ error: error.shortMessage || error.message })) }
  })
  server.requestTimeout = 15000
  server.listen(Number(process.env.VAULT_QUOTE_PORT || 8788), '127.0.0.1', () => console.log('Sepolia quote service listening on http://127.0.0.1:8788'))
}
main().catch(e => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
