#!/usr/bin/env node
// proof-status.mjs: read-only PDP proof status of one or more FWSS data sets on Filecoin Calibration.
//
// Sends NO transactions and needs NO wallet or private key. It only makes eth_call / eth_blockNumber /
// eth_chainId requests to a public JSON-RPC endpoint.
//
// Usage:
//   node proof-status.mjs --dataset 51317 [--dataset 51840,51841] [--rpc URL] [--expect-owner 0x...] [--out FILE]
//   CALIBRATION_RPC=URL DATASETS=51317,51841 node proof-status.mjs
//
// Proof evidence comes from FWSS (FilecoinWarmStorageService view contract): provenPeriods(dataSetId, period)
// and provenThisPeriod(dataSetId). PDPVerifier's getDataSetLastProvenEpoch is reported for context only:
// it is set when proving starts, so on its own it is not evidence that a proof was accepted.
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createPublicClient, http } from 'viem'
import { calibration } from '@filoz/synapse-core/chains'
import * as PDPVerifier from '@filoz/synapse-core/pdp-verifier'

const CALIBRATION_CHAIN_ID = 314159
const DOES_NOT_PROVE = [
  'That the bytes can be retrieved now (use retrieval-check.mjs for that).',
  'That any particular piece is intact: PDP challenges sample the data set, they do not hash every byte.',
  'Anything about future proving periods, or about periods after the reported epoch.',
  'That the provider is independent of any other provider.',
]

const { values } = parseArgs({
  options: {
    dataset: { type: 'string', multiple: true },
    rpc: { type: 'string' },
    'expect-owner': { type: 'string' },
    'max-periods': { type: 'string', default: '2000' },
    out: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})
if (values.help) {
  console.log('Usage: node proof-status.mjs --dataset <id>[,<id>...] [--rpc URL] [--expect-owner 0x...] [--out FILE]')
  process.exit(0)
}

const ids = [...(values.dataset ?? []), process.env.DATASETS ?? '']
  .flatMap((s) => s.split(','))
  .map((s) => s.trim())
  .filter(Boolean)
if (ids.length === 0) {
  console.error('error: give at least one --dataset <id> (or DATASETS=<id,...>)')
  process.exit(2)
}
if (!ids.every((s) => /^\d+$/.test(s))) {
  console.error('error: data set ids must be decimal integers')
  process.exit(2)
}
const expectOwner = values['expect-owner']?.toLowerCase()
if (expectOwner && !/^0x[0-9a-f]{40}$/.test(expectOwner)) {
  console.error('error: --expect-owner must be a 0x-prefixed 20-byte address')
  process.exit(2)
}
const maxPeriods = BigInt(values['max-periods'])
const rpcUrl = values.rpc || process.env.CALIBRATION_RPC || calibration.rpcUrls.default.http[0]

const client = createPublicClient({ chain: calibration, transport: http(rpcUrl, { timeout: 30_000, retryCount: 2 }) })
const chainId = await client.getChainId()
if (chainId !== CALIBRATION_CHAIN_ID) {
  console.error(`refusing: RPC reports chain id ${chainId}, expected Calibration (${CALIBRATION_CHAIN_ID})`)
  process.exit(2)
}
const { pdp, fwssView, fwss } = calibration.contracts
const epoch = await client.getBlockNumber()

const j = (o) => JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
const errText = (e) => String(e?.shortMessage || e?.message || e).slice(0, 200)

async function statusOf(idText) {
  const ID = BigInt(idText)
  const P = (functionName, args = [ID]) => client.readContract({ address: pdp.address, abi: pdp.abi, functionName, args })
  const V = (functionName, args = [ID]) =>
    client.readContract({ address: fwssView.address, abi: fwssView.abi, functionName, args })
  const out = { dataSetId: idText }
  const tryset = async (k, f) => {
    try {
      out[k] = await f()
    } catch (e) {
      out[`${k}Error`] = errText(e)
    }
  }

  await tryset('live', () => P('dataSetLive'))
  await tryset('storageProvider', async () => (await P('getDataSetStorageProvider'))[0])
  await tryset('listener', () => P('getDataSetListener'))
  await tryset('activePieceCount', () => P('getActivePieceCount'))
  await tryset('lastProvenEpoch', () => P('getDataSetLastProvenEpoch'))
  await tryset('nextChallengeEpoch', () => PDPVerifier.getNextChallengeEpoch(client, { dataSetId: ID }))
  await tryset('pdpConfig', async () => {
    const c = await V('getPDPConfig', [])
    return { maxProvingPeriod: c[0], challengeWindowSize: c[1], challengesPerProof: c[2], initChallengeWindowStart: c[3] }
  })
  await tryset('provingActivationEpoch', () => V('provingActivationEpoch'))
  await tryset('provenThisPeriod', () => V('provenThisPeriod'))
  await tryset('provingDeadline', () => V('provingDeadline'))

  const period = out.pdpConfig?.maxProvingPeriod
  out.provenPeriods = []
  out.unprovenEndedPeriods = []
  if (period && out.provingActivationEpoch > 0n && epoch > out.provingActivationEpoch) {
    const current = (epoch - out.provingActivationEpoch - 1n) / period
    const first = current + 1n > maxPeriods ? current + 1n - maxPeriods : 0n
    if (first > 0n) out.periodsSkipped = String(first)
    for (let p = first; p <= current; p++) {
      let ok
      try {
        ok = await V('provenPeriods', [ID, p])
      } catch (e) {
        out.provenPeriodsError = errText(e)
        break
      }
      if (ok) out.provenPeriods.push(String(p))
      else if (p < current) out.unprovenEndedPeriods.push(String(p))
    }
    out.currentPeriod = String(current)
  }
  out.checks = {
    listenerIsFWSS: String(out.listener || '').toLowerCase() === fwss.address.toLowerCase(),
    proofRecorded: Boolean(out.provenThisPeriod) || out.provenPeriods.length > 0,
    endedPeriods: out.currentPeriod === undefined ? 0 : Number(out.currentPeriod) - Number(out.periodsSkipped ?? 0),
    endedPeriodsProven: out.provenPeriods.filter((p) => p !== out.currentPeriod).length,
  }
  if (expectOwner) out.checks.ownerMatchesExpected = String(out.storageProvider || '').toLowerCase() === expectOwner
  return out
}

const report = {
  tool: 'proof-status.mjs',
  at: new Date().toISOString(),
  chainId,
  epoch,
  rpcHost: new URL(rpcUrl).host,
  contracts: { pdpVerifier: pdp.address, fwss: fwss.address, fwssView: fwssView.address },
  dataSets: [],
  doesNotProve: DOES_NOT_PROVE,
}
for (const id of ids) report.dataSets.push(await statusOf(id))

const text = j(report)
if (values.out) writeFileSync(values.out, `${text}\n`)
console.log(text)
