#!/usr/bin/env node
// retrieval-check.mjs: independent retrieval of one piece from a PDP provider over plain HTTPS, without the
// Synapse SDK, forced once over IPv4 and once over IPv6, with a sha256 of the downloaded bytes.
//
// Read-only: HTTP GET requests only. No wallet, no private key, no transactions. If --provider-id is given,
// the provider's service URL is read from the on-chain ServiceProviderRegistry (eth_call only).
//
// Usage:
//   node retrieval-check.mjs --provider-id 61 --piece-cid <cid> [--expect-sha256 <hex>] [--family 4,6]
//   node retrieval-check.mjs --service-url https://provider.example --piece-cid <cid> [--expect-sha256 <hex>]
//
// Exit code: 0 if every requested address family returned HTTP 200 and (when --expect-sha256 is given)
// the digest matched; 1 otherwise; 2 on bad arguments.
import { createHash } from 'node:crypto'
import https from 'node:https'
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const DOES_NOT_PROVE = [
  'That the provider holds the data on-chain or is being proven (use proof-status.mjs for that).',
  'That the PieceCID matches the bytes: this script compares sha256 only, it does not recompute the PieceCID.',
  'Anything about retrievability at another time, from another network location, or via other paths (CDN, IPFS).',
  'That a matching sha256 means the original was intact, unless the expected digest came from the original data.',
]

const { values } = parseArgs({
  options: {
    'provider-id': { type: 'string' },
    'service-url': { type: 'string' },
    'piece-cid': { type: 'string' },
    'expect-sha256': { type: 'string' },
    family: { type: 'string', default: '4,6' },
    rpc: { type: 'string' },
    'max-bytes': { type: 'string', default: String(1024 * 1024 * 1024) },
    'timeout-ms': { type: 'string', default: '120000' },
    'max-redirects': { type: 'string', default: '5' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
const usage =
  'Usage: node retrieval-check.mjs (--provider-id <id> | --service-url <https-url>) --piece-cid <cid> ' +
  '[--expect-sha256 <hex>] [--family 4,6] [--rpc URL] [--out FILE]'
if (values.help) {
  console.log(usage)
  process.exit(0)
}
const fail = (msg) => {
  console.error(`error: ${msg}\n${usage}`)
  process.exit(2)
}

const pieceCid = values['piece-cid']
if (!pieceCid || !/^[a-z0-9]+$/i.test(pieceCid)) fail('--piece-cid is required (base32 CID)')
if (Boolean(values['provider-id']) === Boolean(values['service-url'])) fail('give exactly one of --provider-id or --service-url')
const expect = values['expect-sha256']?.toLowerCase()
if (expect && !/^[0-9a-f]{64}$/.test(expect)) fail('--expect-sha256 must be 64 hex characters')
const families = values.family.split(',').map((s) => Number(s.trim()))
if (families.length === 0 || !families.every((f) => f === 4 || f === 6)) fail('--family must be 4, 6 or 4,6')
const maxBytes = Number(values['max-bytes'])
const timeoutMs = Number(values['timeout-ms'])
const maxRedirects = Number(values['max-redirects'])

// Resolve the service URL, optionally from the on-chain registry (read-only).
let serviceURL = values['service-url']
let providerId
if (values['provider-id']) {
  if (!/^\d+$/.test(values['provider-id'])) fail('--provider-id must be a decimal integer')
  providerId = values['provider-id']
  const { createPublicClient, http } = await import('viem')
  const { calibration } = await import('@filoz/synapse-core/chains')
  const { getPDPProvider } = await import('@filoz/synapse-core/sp-registry')
  const rpcUrl = values.rpc || process.env.CALIBRATION_RPC || calibration.rpcUrls.default.http[0]
  const client = createPublicClient({ chain: calibration, transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) })
  if ((await client.getChainId()) !== 314159) fail('RPC is not Calibration (314159)')
  const p = await getPDPProvider(client, { providerId: BigInt(providerId) })
  if (!p) fail(`provider ${providerId} has no active PDP product in the registry`)
  serviceURL = p.pdp.serviceURL
}
const base = new URL(serviceURL)
if (base.protocol !== 'https:') fail('service URL must be https')
const startUrl = new URL(`${base.pathname.replace(/\/$/, '')}/piece/${pieceCid}`, base)

// One GET with a forced address family. A fresh agent per request, so no connection is reused across families.
function getOnce(url, family) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { family, autoSelectFamily: false, agent: new https.Agent({ keepAlive: false }), timeout: timeoutMs },
      (res) => resolve(res),
    )
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)))
    req.on('error', reject)
  })
}

async function fetchWithFamily(family) {
  const t0 = Date.now()
  const hops = []
  let url = startUrl
  try {
    for (let i = 0; ; i++) {
      const res = await getOnce(url, family)
      hops.push({ status: res.statusCode, url: url.href })
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume()
        if (i >= maxRedirects) throw new Error('too many redirects')
        const next = new URL(res.headers.location, url)
        if (next.protocol !== 'https:') throw new Error('refusing redirect to non-https URL')
        url = next
        continue
      }
      if (res.statusCode !== 200) {
        res.resume()
        return { family, ok: false, hops, error: `HTTP ${res.statusCode}`, ms: Date.now() - t0 }
      }
      const h = createHash('sha256')
      let bytes = 0
      for await (const chunk of res) {
        bytes += chunk.length
        if (bytes > maxBytes) {
          res.destroy()
          throw new Error(`more than --max-bytes ${maxBytes}`)
        }
        h.update(chunk)
      }
      const sha256 = h.digest('hex')
      const declared = res.headers['content-length'] === undefined ? undefined : Number(res.headers['content-length'])
      return {
        family,
        ok: true,
        hops,
        bytes,
        contentLengthMatches: declared === undefined ? null : declared === bytes,
        sha256,
        matchesExpected: expect ? sha256 === expect : null,
        ms: Date.now() - t0,
        // Family of the socket that served the final response (the address itself is not printed).
        socketFamily: res.socket?.remoteFamily ?? null,
      }
    }
  } catch (e) {
    return { family, ok: false, hops, error: String(e?.message || e).slice(0, 200), ms: Date.now() - t0 }
  }
}

const results = []
for (const f of families) results.push(await fetchWithFamily(f))
const digests = new Set(results.filter((r) => r.ok).map((r) => r.sha256))
const report = {
  tool: 'retrieval-check.mjs',
  at: new Date().toISOString(),
  providerId: providerId ?? null,
  serviceURL: base.origin,
  pieceCid,
  expectedSha256: expect ?? null,
  results,
  summary: {
    allFamiliesOk: results.every((r) => r.ok),
    familiesAgree: results.every((r) => r.ok) ? digests.size === 1 : null,
    allMatchExpected: expect ? results.every((r) => r.ok && r.matchesExpected) : null,
  },
  doesNotProve: DOES_NOT_PROVE,
}
const text = JSON.stringify(report, null, 2)
if (values.out) writeFileSync(values.out, `${text}\n`)
console.log(text)
const pass = report.summary.allFamiliesOk && report.summary.familiesAgree && report.summary.allMatchExpected !== false
process.exit(pass ? 0 : 1)
