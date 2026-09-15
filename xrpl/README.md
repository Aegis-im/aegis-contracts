# YUSD on XRPL Testnet

Native trust-line YUSD with backend minting triggered by incoming collateral
Payments. The default collateral is Ripple's **official Testnet RLUSD**. A
separate `--mock` deployment can exercise the same mint worker with a newly issued
**MRLUSD test token**, which is not Ripple RLUSD. No Solidity contract or DEX offer
is involved. Redemption is not implemented.

## Install and check

Use Node.js 22.14 or newer. Run these commands from this directory:

```sh
npm ci
npm run check
npm test
```

This package has its own pinned SDK dependency and lockfile. It does not load the
repository's root `.env`, use EVM keys, or change the Hardhat deployment.

## Official Testnet RLUSD

```sh
npm run setup
node src/cli.js onboard
npm run status
```

`setup` creates and XRP-funds a new YUSD issuer and market receiver, enables
DefaultRipple on the issuer, and creates the receiver's RLUSD trust line.
`onboard` funds a demo wallet, sets both trust lines, and allowlists that wallet.
Rerunning these commands retains the same accounts and operation journal.

The output contains public addresses only. Obtain at least 1 Testnet RLUSD for
the `demoUser` printed by `status`. The [official faucet](https://tryrlusd.com/)
requires authentication. `node src/cli.js faucet` attempts its public endpoint
and reports an actionable error if a signed-in browser is required; it never
substitutes a different collateral token.

Once funded:

```sh
npm run demo
```

The demo submits 1 RLUSD using the stable deposit ID `demo-v1`, runs the mint
worker, verifies validated collateral and YUSD delivery, checks the holder's
balance, then reopens the durable journal and replays the deposit ledger. It
asserts that replay leaves the same mint hash and balance. Reruns reuse that
deposit rather than paying another 1 RLUSD.

To make a separate payment and process it:

```sh
node src/cli.js deposit 2.5 --id example-001
npm run worker -- --once
npm run status
```

A deposit ID is bound to its amount and sender. Reuse it to resolve an uncertain
submission. Use a new ID only for a deliberately new payment or after a
definitively failed/expired deposit. Changing an existing ID's amount fails.

## Self-contained live Testnet demo

This uses a separate directory and entirely different issuer, receiver, and user
accounts. The local mock collateral issuer supplies MRLUSD without authenticating
to Ripple's RLUSD faucet. All token setup, collateral transfer, minting and replay
checks still execute on the public XRPL Testnet.

```sh
npm run demo -- --mock
npm run status -- --mock
```

Pass `--mock` to **every** command for this deployment. It cannot change an
existing official RLUSD deployment's collateral. Its output explicitly reports
`collateralMode: "mock"` and the distinct currency/issuer. A passing mock demo
does not establish that the official RLUSD wallet has been funded.

For additional live assertions of pause/resume, a second 2.5-token mint,
idempotent deposit submission and rejection of an incoming XRP payment:

```sh
npm run test:live -- --mock
```

The probe drives the public CLI and records public evidence in the instance's
`acceptance.json`. Without `--mock`, this probe requires at least 3.5 official
Testnet RLUSD across its demo and acceptance deposits.

## Mint from another wallet

The user signs only their own trust-line and deposit transactions. The operator
does not need the user's seed.

1. Fund the user's classic XRPL account with Testnet XRP for reserves and fees.
2. Create trust lines for the configured collateral and YUSD. Use the currency
   and issuer from `status`, a sufficient `LimitAmount.value`, and
   `TrustSet` flag `tfSetNoRipple` on the holder.
3. Operator: `node src/cli.js allow ADDRESS` (append `--mock` for the mock instance).
4. The user sends this transaction, replacing the public fields from `status`:

   ```json
   {
     "TransactionType": "Payment",
     "Account": "USER_CLASSIC_ADDRESS",
     "Destination": "MARKET_FROM_STATUS",
     "DestinationTag": 1,
     "Amount": {
       "currency": "COLLATERAL_CURRENCY_FROM_STATUS",
       "issuer": "COLLATERAL_ISSUER_FROM_STATUS",
       "value": "1"
     }
   }
   ```

5. Run `npm run worker` continuously, or `npm run worker -- --once` to process
   one history window. YUSD is paid directly from the issuer to the sender after
   both collateral validation and policy checks succeed. If the incoming payment
   has a SourceTag, issuance uses it as the DestinationTag.

Default RLUSD identity:

- Currency: `524C555344000000000000000000000000000000`
- Issuer: `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV`
- YUSD currency: `5955534400000000000000000000000000000000`
- Network: `wss://s.altnet.rippletest.net:51233`, verified `network_id: 1`

The backend uses `delivered_amount`, not the requested Amount. It rejects partial
payments, wrong currency/issuer, wrong/missing tag, issuer/operational transfers,
zero/dust amounts and unsupported precision into a visible review queue.

## Holder list

```sh
npm run holders
npm run holders -- --mock
```

This queries the selected YUSD issuer's trust lines on Testnet and returns JSON:
`issuer`, `currency`, `ledger`, `ledgerHash`, `holderCount`, and a sorted `holders`
list containing each wallet `address` and its exact `balance` as a decimal string.
All pages use the same validated ledger hash. Zero-balance trust lines and other
currencies are excluded; frozen balances are still holdings and remain included.

The list comes from on-chain balances, so it includes wallets that received YUSD
through transfers as well as minting. From the issuer's perspective, a negative
trust-line balance is owed to the holder; the command reports it as a positive
holding. See the [XRPL account_lines documentation](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_lines).

No signing key or running mint worker is needed. The default command reads only
the deployment identity in `state.json`, without locking or changing the journal.
An explicit public issuer requires no local state at all:

```sh
npm run holders -- --issuer rDwMERNmSRLvPYnU25Nkd7HdYLTsNcoMJ5
```

For a clean JSON export, use `npm run --silent holders > holders.json`. Each run
is a current snapshot; storing snapshots over time or continuously monitoring
changes is a separate service. These are ledger account addresses, not personal
identities or an exchange's internal customer balances. This lists direct trust-line
holdings; future escrow or pool look-through accounting needs separate treatment.

## Policy and operations

The prototype assumes **1 collateral token → 1 YUSD**, no fee, six decimal places,
and a cumulative 1,000,000 YUSD issuance cap. These values do not implement a price
oracle or a production depeg policy. Only allowlisted addresses receive mints.
The token itself remains transferable: the allowlist is not RequireAuth or KYC.

```sh
node src/cli.js pause
node src/cli.js resume
```

`disallow ADDRESS` removes mint eligibility. `retry DEPOSIT_HASH` releases only a
definitively failed or expired mint for another attempt. Successful, uncertain,
and manual-review entries cannot be retried this way. `status` reports deposit
states, reasons, delivery hashes, backing and the replay cursor without seeds.

| State | Meaning and action |
|---|---|
| `pending` | Accepted collateral delivery awaits policy checks |
| `blocked` | Paused, ineligible, missing/frozen trust line, insufficient backing/capacity, or issuer drift; automatically rechecked |
| `submitting` | Signed transaction persisted; reconcile/rebroadcast the same bytes |
| `minted` | Validated successful YUSD delivery recorded |
| `failed` | Definitive failure or proven expiration; explicit retry required |
| `review` | Unsupported collateral payment or unexpected delivery; no automatic mint/refund |

The receiver retains collateral throughout this milestone. The worker checks
liquid backing for cumulative minted YUSD plus each new mint, and blocks unknown
external YUSD issuance. Returning YUSD to the issuer does not release the
cumulative cap. Do not use the issuer key for payments outside this service.

A pause prevents new signatures. It does not prevent collateral deposits or
cancel transactions already signed; those are still reconciled. A recipient
without a trust line can therefore have funds waiting at the receiver until
onboarding is repaired. Refunds and redemption are deliberately deferred.

## State, keys and restart

- Default instance: `.local/testnet/`; mock: `.local/testnet-mock/`.
- Optional `XRPL_STATE_DIR` selects a different directory, but must always follow
  the same deployment and mode. The default paths are relative to this package,
  independent of the caller's working directory.
- `wallets.json` stores generated Testnet seeds with mode `0600`; the state
  directory is `0700`. `.local/` is gitignored. Do not commit or share it.
- `state.json` holds deposits, cursor, policy, and original signed transactions.
  Back it up together with keys. **Never recreate a journal for used accounts or
  restore an old journal and continue signing without reconciliation.**
- One writer may hold `writer.lock`. Worker commands release it between passes,
  so an operator command may briefly need to be rerun while a pass is active.
- Normal interruption releases the lock after the current transaction resolves.
  After a crash/SIGKILL, inspect the lock's PID and host and confirm the writer is
  no longer running before removing only `writer.lock`. Restart with the same
  state; do not remove `state.json` or pending operations.
- A timeout is unresolved, not failure. The worker looks up the saved transaction
  hash and may rebroadcast identical bytes. Replacement requires definitive
  failure or expiration proven against complete ledger history.
- A history gap leaves the cursor unchanged. A Testnet reset requires a fresh
  deployment in a new directory; keep the previous journal for reconciliation.

These local single-key files are for Testnet. Production requires signer custody,
shared transactional storage, operational supervision, credential/quote/refund
policy and reserve/strategy integrations. No service is installed or hosted by
the setup command; the mint worker runs while its process is running.

## References

- [Deployment addresses and validation results](../docs/xrpl/TESTNET-VALIDATION.md)
- [Technical proposal](../docs/xrpl/YUSD-XRPL-TECH-PROPOSAL.md)
- [Architecture](../docs/xrpl/YUSD-XRPL-ARCHITECTURE.md)
- [Ripple RLUSD network addresses and faucet](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)
- [XRPL payment metadata](https://xrpl.org/docs/references/protocol/transactions/metadata)
- [Reliable transaction submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission)
