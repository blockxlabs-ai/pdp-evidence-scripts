# Example runs (2026-11-10, Calibration epoch 4233320)

All runs were read-only: JSON-RPC `eth_call` / `eth_blockNumber` / `eth_chainId` against the public Calibration
endpoint, and HTTP GET requests to the providers. No wallet, no key, no transaction.

## 1. Proof status of three data sets

```sh
node proof-status.mjs --dataset 51317,51840,51841
```

Output: [example-proof-status.json](example-proof-status.json)

| Data set | Provider | Live | Active pieces | Ended periods | Ended periods proven | Unproven ended periods |
|---|---|---|---|---|---|---|
| 51317 | 61 | true | 2 | 39 | 39 | none |
| 51840 | 9 | true | 1 | 21 | 21 | none |
| 51841 | 61 | true | 1 | 21 | 21 | none |

The FWSS proving period is 240 epochs (about 2 hours) on Calibration. The current period of each data set was
still open at the time of the run, so it is not counted as ended.

## 2. Independent retrieval of one piece over IPv4 and IPv6

```sh
node retrieval-check.mjs --provider-id 61 \
  --piece-cid bafkzcibfqcapyaisdl5zlgxkzcyjprd53ruz7zf2coe37mh6gurcatz7deudz5hl7mqa \
  --expect-sha256 7c197fec20e01450fbe336750397274e2c21c43b8c7f66be0a0a6edebef692db
```

Output: [example-retrieval-provider61-51317.json](example-retrieval-provider61-51317.json)

Both families: 301 to `/public/<cid>`, then 200, 4,194,304 bytes, sha256 equal to the digest of the original
4 MiB test file (random bytes we uploaded on 2026-11-07). Exit code 0.

## 3. The same piece from two different operators

One object was placed with provider 9 (data set 51840) and provider 61 (data set 51841) on 2026-11-08.

```sh
node retrieval-check.mjs --provider-id 9  --piece-cid bafkzcibey3jsseakztwunihqjay2hefffyjjyl2akvqqxy2eje2kh234rb7quz2kaa --family 4
node retrieval-check.mjs --provider-id 61 --piece-cid bafkzcibey3jsseakztwunihqjay2hefffyjjyl2akvqqxy2eje2kh234rb7quz2kaa
```

Outputs: [example-retrieval-provider9-shared-piece.json](example-retrieval-provider9-shared-piece.json),
[example-retrieval-provider61-shared-piece.json](example-retrieval-provider61-shared-piece.json)

Both providers returned 1,398,330 bytes with the same sha256. Provider 9 was checked over IPv4 only, because its
service host resolved to an IPv4 address only when we placed the copy. No `--expect-sha256` was given, because these
bytes are an encrypted envelope and its digest is not published here. The runs therefore show that both operators
return identical bytes, not that the bytes are the right ones.
