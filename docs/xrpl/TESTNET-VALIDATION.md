# XRPL Testnet implementation — validation

Mint verification: 2026-09-10. Public deployment snapshot: ledger **20644137**.
Holder-list verification: 2026-09-15, documented below.
The [machine-readable evidence](testnet-deployments.json) contains account and
transaction identities plus source SHA-256 digests; it contains no keys.

The accepted scope is the user's XRPL Testnet token and incoming-payment mint
implementation, with redemption deferred. The executable surface is the
`xrpl/src/cli.js` package described in [the runbook](../../xrpl/README.md), and
the live behavior is observed on XRPL Testnet. No EVM contract changed.

## Claims and evidence

| Claim | Verdict | Evidence |
|---|---|---|
| Default official-RLUSD issuer, receiver and user are provisioned | Verified against validated Testnet state | `npm run setup`, `onboard`; fresh account-info/trust-line assertions at ledger 20644137 |
| Incoming collateral produces direct issuer-to-user YUSD with no DEX | Verified on **official-RLUSD and mock-collateral Testnet deployments** | `npm run demo` and `npm run demo -- --mock`, both exit 0; validated deposits and mints below; holder balance assertions; issuers and receivers have zero offers |
| Reopening state and replaying a deposit does not mint again | Verified on both Testnet deployments | Each demo forces replay after journal reopen and asserts unchanged mint hash and holder balance |
| Pause/resume, repeated deposit ID and wrong-asset rejection | Verified on the mock-collateral Testnet deployment | `npm run test:live -- --mock`, exit 0; CLI-driven pause blocks, resume mints 2.5, repeated ID does not remint, incoming XRP remains in review |
| Local failure and CLI checks execute successfully | Verified test execution | `npm run check` and `npm test`, exit 0; 44 tests, zero failures as of 2026-09-15, including holder snapshot checks |
| Lost acknowledgements, incomplete history and failure retries under real network faults | Provisional | Covered by local fault-injection tests, not a live network fault campaign |
| Minting against **official Testnet RLUSD** | Verified against validated Testnet state | After user funding, `npm run demo` exited 0: 1 RLUSD received by the market, 1 YUSD delivered to the user, one mint attempt, replay produced no additional issuance |

The mock mode uses the same mint worker and journal with a separate local
MRLUSD issuer. Official RLUSD minting was subsequently verified independently
after the user funded the demo wallet. These checks do not establish production
readiness. Redemption, refunds, production signing, credentials,
wallet UI, strategy execution and managed service hosting remain out of scope.

## Default deployment — official Testnet RLUSD

| Role | Address |
|---|---|
| YUSD issuer | [`rDwMERNmSRLvPYnU25Nkd7HdYLTsNcoMJ5`](https://testnet.xrpl.org/accounts/rDwMERNmSRLvPYnU25Nkd7HdYLTsNcoMJ5) |
| RLUSD receiver | `rLHxXbAGr5z6ocmd84acoJNMQEDpLvbGDE` |
| Demo user | `rfsVM3114tdD5k7B548g7jwiTs874Qk2zK` |
| Official Testnet RLUSD issuer | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |

YUSD currency: `5955534400000000000000000000000000000000`.
RLUSD currency: `524C555344000000000000000000000000000000`.
Mint destination tag: `1`. Issuer DefaultRipple and all required trust lines were
asserted on-ledger. The demo user now holds **1 YUSD**, backed by **1 official
Testnet RLUSD** at the receiver. The user's RLUSD balance is zero after the deposit.

The user supplied 1 RLUSD in ledger 20644067. The shipped
`npm run demo` then submitted the collateral deposit and ran the mint worker.
It verified the two distinct successful Payments, reopened the durable journal,
replayed the deposit ledger and asserted that the mint hash and balance were
unchanged. One mint attempt is recorded; no DEX offers exist.

| Action | Validated transaction |
|---|---|
| User funding: 1 RLUSD to demo wallet | [5164E410…AE7BEFAA](https://testnet.xrpl.org/transactions/5164E410ACB305C98A399550FE6575C363EB818D7B739BB5477A8435AE7BEFAA) |
| Mint deposit: 1 RLUSD to receiver | [2210235F…5A9F85C1](https://testnet.xrpl.org/transactions/2210235F0265D2395D328179D3A048FF84FDF79854EF96E107E0F0355A9F85C1) |
| Issuance: 1 YUSD to demo wallet | [68276BF4…AFEFC815](https://testnet.xrpl.org/transactions/68276BF43693E948030140F9C9BC0B9B128AB9C586AF2F1623144980AFEFC815) |

The prior authenticated-faucet blocker is resolved for the required mint demo.
Rerunning `npm run demo` reuses the completed deposit. The broader
`npm run test:live` requires another 2.5 RLUSD for its separate acceptance deposit;
its additional control checks have already passed on the mock deployment.

## Isolated mock-collateral deployment

| Role | Address |
|---|---|
| YUSD issuer | [`rpXJVT1vyRb6sv2uvNjdnpeuFd4mWCV7W1`](https://testnet.xrpl.org/accounts/rpXJVT1vyRb6sv2uvNjdnpeuFd4mWCV7W1) |
| Collateral receiver | `r9ErHDdChXQ4rNSBDMuXvmTPYgF3WEMLx4` |
| Demo user | `rfW5REtj6ddMMzKDVLeQ6ZgtHNmqeLBF5B` |
| MRLUSD mock issuer | `rnFKB6BuYtdjvYZDdgww9Hn1dy2qd4Be62` |

Mock currency: `4D524C5553440000000000000000000000000000` (`MRLUSD`).
At the snapshot, the user holds **3.5 YUSD**, the receiver holds **3.5 MRLUSD**,
and neither issuer nor receiver has any offers.

| Action | Validated transaction |
|---|---|
| 1 MRLUSD deposit | [7FD9AEAC…BBE44D63](https://testnet.xrpl.org/transactions/7FD9AEAC2C6AF99AFF0ED8166723948FEB66C8BE633EE31D65317DE8BBE44D63) |
| 1 YUSD issuance | [96DBB8CA…AAAF42C4](https://testnet.xrpl.org/transactions/96DBB8CA06ED2FCEE884A918BD6982C25B306F02DB3498BAE6AC9FB7AAAF42C4) |
| 2.5 MRLUSD deposit | [117205BF…2ED98230](https://testnet.xrpl.org/transactions/117205BF78EA445424B18A22DAF7F3E3A6912495B0E1A4AA5CCE84712ED98230) |
| 2.5 YUSD issuance after resume | [34D0F7AB…FAA7D497](https://testnet.xrpl.org/transactions/34D0F7AB281CA7607917661115EE11CE7797B527BD92419DA9BCE1B0FAA7D497) |
| Incoming XRP retained for review, no mint | [725F6C2A…EB10613](https://testnet.xrpl.org/transactions/725F6C2AAEDFC5A022E236E0ED8BD4C4530E276FCBEC0C1CFD45BCF7AEB10613) |

Both instances retain their local journals and Testnet seeds under the package's
gitignored `.local/` directory. No worker is installed as a background service;
start it with `npm run worker` or `npm run worker -- --mock` when needed.

## Holder tracking — 2026-09-15

The public CLI command
`npm run holders -- --issuer rDwMERNmSRLvPYnU25Nkd7HdYLTsNcoMJ5`
completed with exit 0 against XRPL Testnet. Executable assertions on its JSON
output verified the issuer, validated ledger hash, count and expected holder
balance. The [saved snapshot](holders-snapshot.json) records ledger **20782913**:

| Address | YUSD balance |
|---|---|
| `rfsVM3114tdD5k7B548g7jwiTs874Qk2zK` | `1` |

The command reads public trust lines without signing or accessing wallet keys.
All pages are fixed to one validated ledger hash, and only positive YUSD
holdings are returned, including transferred and frozen balances. The local
tests exercise empty results, pagination, exact decimal/exponent strings,
wrong currencies, issuer-side positive balances, negative zero, inconsistent
pages, repeated markers, malformed data and invalid CLI arguments.

This verifies the current holder list, not a continuously running history
service. Account addresses do not identify exchange customers or other
beneficial owners. The earlier mint source digests in `testnet-deployments.json`
describe the mint verification version; the holder command was added afterward.
