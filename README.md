# pdp-evidence-scripts

Two small, read-only Node.js scripts we used while running a Curio-PDP storage provider (provider 61) and a
two-operator client pipeline on the Filecoin **Calibration** testnet in November 2026. They answer two narrow
questions with evidence you can rerun:

| Script | Question | Reads |
|---|---|---|
| `proof-status.mjs` | Has FWSS recorded PDP proofs for this data set, period by period? | PDPVerifier and FWSS view contracts via `eth_call` |
| `retrieval-check.mjs` | Can I download this piece over plain HTTPS, without the SDK, over IPv4 **and** IPv6, and is the sha256 what I expect? | The provider's `/piece/<cid>` endpoint (HTTP GET); optionally the ServiceProviderRegistry via `eth_call` |

Neither script needs a wallet or a private key. Neither sends a transaction. They only make JSON-RPC read calls to a
public Calibration endpoint and HTTP GET requests to a provider.

This is prior work, published as-is. It is not the "PDP Evidence Kit" we have proposed for a grant, and it comes
with no maintenance promise.

## Requirements

- Node.js 20 or newer (tested with 24.22.2)
- `npm ci` (installs the pinned `@filoz/synapse-core` 0.10.3 and `viem` 2.57.16 from `package-lock.json`)

The scripts refuse to run unless the RPC endpoint reports chain id 314159 (Calibration).

## proof-status.mjs

```sh
node proof-status.mjs --dataset 51317,51840,51841
node proof-status.mjs --dataset 51841 --expect-owner 0x925e4F053DbC6EA7e288f24Ea44a58ed38d504Be --out status.json
CALIBRATION_RPC=https://your-rpc.example/rpc/v1 DATASETS=51317 node proof-status.mjs
```

Options: `--dataset` (repeatable or comma-separated), `--rpc` (default: `CALIBRATION_RPC`, else the public endpoint
listed in synapse-core's Calibration chain definition), `--expect-owner` (optional storage-provider address to
compare), `--max-periods` (default 2000), `--out` (also write the JSON to a file; nothing is written otherwise).

For each data set it reports `live`, storage provider, listener, active piece count, the FWSS PDP configuration,
`provingActivationEpoch`, `provingDeadline`, `provenThisPeriod`, and walks `provenPeriods(dataSetId, period)` for every
period since activation. `checks.endedPeriods` and `checks.endedPeriodsProven` summarise that walk;
`unprovenEndedPeriods` lists any ended period without a recorded proof.

**Proof evidence comes from FWSS** (`provenPeriods`, `provenThisPeriod`). PDPVerifier's
`getDataSetLastProvenEpoch` is printed for context only. It is set when proving starts, so on its own it does not
show that a proof was accepted.

**What it does not prove:** that the bytes can be retrieved now; that any particular piece is intact (PDP
challenges sample the data set; they do not hash every byte); anything about later periods; or that two providers
are independent operators.

## retrieval-check.mjs

```sh
# Resolve the service URL from the on-chain registry, download over IPv4 and IPv6, compare with a known digest.
node retrieval-check.mjs --provider-id 61 \
  --piece-cid bafkzcibfqcapyaisdl5zlgxkzcyjprd53ruz7zf2coe37mh6gurcatz7deudz5hl7mqa \
  --expect-sha256 7c197fec20e01450fbe336750397274e2c21c43b8c7f66be0a0a6edebef692db

# Or give the service URL yourself, IPv4 only.
node retrieval-check.mjs --service-url https://provider.example --piece-cid <cid> --family 4
```

For each address family it opens a fresh TLS connection with that family forced (no happy-eyeballs fallback, no
connection reuse), follows up to five HTTPS redirects (providers usually answer `/piece/<cid>` with a 301 to
`/public/<cid>`), streams the body into sha256, and records the redirect chain, byte count, whether
`Content-Length` matched, the digest, the socket family that served the response, and the time taken. Remote IP
addresses are not printed.

Exit code 0 means every requested family returned HTTP 200, the families agree on the digest, and the digest
matches `--expect-sha256` if one was given. Exit code 1 means something did not hold. Exit code 2 means bad
arguments.

**What it does not prove:** that the provider holds the piece on-chain or is proving it (use `proof-status.mjs`);
that the bytes match the PieceCID (the script compares sha256 only and does not recompute the PieceCID); anything
about retrievability at another time, from another network location, or through other paths such as a CDN or IPFS;
or that the original data was intact, unless the expected digest was computed from the original.

## Examples

`docs/` contains real output from 2026-11-10 (Calibration epoch 4233320), produced with the commands in
`docs/EXAMPLES.md`. Provider and data-set IDs, contract addresses and service URLs in the examples are public
on-chain data.

## Where these scripts came from

Both are cleaned-up versions of what we ran internally on 2026-11-07 and 2026-11-08:

- `proof-status.mjs` is derived from our internal status script. The internal version built a full Synapse SDK
  client, which in SDK 2.0.2 takes an account, so it loaded a throwaway testnet key from a local file even though
  it only made read calls. The published version uses a viem public client and synapse-core's chain definition
  instead, and opens no key file. The data-set id and the expected owner address, which were hard-coded, are now
  arguments; checking the owner is optional. It no longer writes a file unless `--out` is given. The proof logic
  (FWSS `provenPeriods` / `provenThisPeriod`) is unchanged.
- `retrieval-check.mjs` turns a manual check into a script. On 2026-11-07 and 2026-11-08 we downloaded pieces by
  hand over HTTPS (forcing IPv4 and IPv6 separately) and compared sha256 with the original. That check was not kept
  as a file, so we wrote it down as a script on 2026-11-10 and reran it to produce the examples.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.
