# YUSD on the XRP Ledger — Architecture

Updated 2026-09-10. Companion to the [technical proposal](YUSD-XRPL-TECH-PROPOSAL.md)
and Draw.io diagram. The current [Testnet implementation](../../xrpl/README.md)
includes YUSD and payment-triggered minting; redemption and strategy integration
are future work.

## 1. System boundary

```text
User wallet ── RLUSD Payment ──▶ AEGIS_MARKET
                                    │
                           validated account history
                                    ▼
                         Aegis mint worker + journal
                         eligibility / backing / cap
                                    │
                              signed Payment
                                    ▼
User YUSD trust line ◀── YUSD ── AEGIS_YUSD_ISSUER
```

Both payments are ordinary XRPL transactions. The backend connects them through
a durable obligation identified by the incoming transaction hash. They are not
an atomic swap. There are no mint offers, pre-issued inventory, or primary-market
PermissionedDomain dependencies.

Future treasury services move backing to/from strategies. Until those services
and reserve attestations exist, the Testnet worker requires collateral to remain
at the receiver.

## 2. Components

| Component | Responsibility |
|---|---|
| YUSD issuer | Creates YUSD through direct issuer Payments |
| Market receiver | Holds incoming RLUSD; later holds redemption YUSD and settles RLUSD |
| Ledger adapter | Testnet network guard, validated reads, paginated history, signing and reconciliation |
| Mint worker | Classifies incoming payments, checks issuance policy, submits YUSD |
| Durable journal | Deposit obligations, original signed transactions, results, ledger cursor |
| Operator CLI | Provisioning, demo wallet, deposits, allowlist, pause/resume, retries, status |
| Eligibility service, future | KYC and credential lifecycle |
| Redemption/treasury services, future | Request tracking, unwind, RLUSD settlement, YUSD retirement |
| Reserve/reward services, future | Supply and reserve evidence, holder distributions |

Implementation source map:

| File | Responsibility |
|---|---|
| `xrpl/src/cli.js` | Operator commands and live demo assertions |
| `xrpl/src/ledger.js` | XRPL SDK boundary and reliable submission |
| `xrpl/src/minter.js` | Deposit interpretation and mint state machine |
| `xrpl/src/store.js` | Exclusive local writer and fsynced atomic persistence |
| `xrpl/src/amounts.js` | Exact six-decimal business arithmetic |
| `xrpl/src/holders.js` | Read-only YUSD holder snapshots from paginated trust lines at one validated ledger hash |

## 3. Mint flow

1. Onboard an eligible sender with RLUSD and YUSD trust lines.
2. Receive RLUSD at the configured market address with mint destination tag `1`.
3. Read complete, validated `account_tx` pages from the saved cursor through a
   fixed ledger boundary. Advance the cursor only after the whole range succeeds.
4. For a successful incoming Payment, record its hash and actual
   `meta.delivered_amount`. Wrong tokens/issuers, partial payments, wrong tags,
   operational transfers, and unsupported precision go to review.
5. Check sender allowlist, pause, supply cap, reserve, issuer settings/freeze,
   recipient trust-line capacity and unjournaled external YUSD issuance.
6. Sign a direct issuer-to-sender YUSD Payment. It carries a bounded
   LastLedgerSequence and the incoming hash in its memo. Persist the signed bytes
   and obligation transition before transmitting it.
7. Require validated `tesSUCCESS` and the expected delivered YUSD amount before
   marking the obligation minted.

The Testnet rate is 1:1 with zero fee and six-decimal precision. It is a fixed
prototype policy. There is no price feed or production quote contract.

## 4. Application state and recovery

| Record | Minimum state |
|---|---|
| Deposit | Incoming hash, ledger, sender, delivered collateral, YUSD amount, return tag, state, reason, attempt IDs, mint hash/ledger |
| Signed attempt | Account, serialized signed transaction, hash, sequence, first/last ledgers, terminal result |
| Indexer | Last fully scanned validated ledger |
| Policy | Token identities, allowlist, pause, fixed supply cap |
| Demo request | Stable caller ID bound to one amount, sender and signed deposit operation |
| Redemption, future | Request ID, incoming YUSD hash, amount, recipient, unwind reference, settlement hash, retirement hash, state |

```text
validated RLUSD → pending → submitting → minted
                    │          ├── failed → explicit retry → pending
                    │          └── uncertain → reconcile same signed transaction
                    └── blocked → condition repaired → submitting

unsupported deposit → review
unexpected successful mint delivery → review + global mint pause
```

`blocked` obligations are reconsidered on each worker pass. `failed` means the
previous attempt has a definitive ledger failure or proven expiration and awaits
an explicit retry command. `review` has no automatic retry/refund path.

At restart, resolve all `submitting` obligations before allocating new issuer
sequences. Looking up the saved hash or rebroadcasting the saved bytes cannot
create a second transaction. A timeout is not a final result. Expiration requires
the validated ledger to pass LastLedgerSequence, complete server history for the
validity interval, and a final lookup showing absence.

The on-disk state is local to one deployment and one writer. Every mutation
requires an exclusive lock. State writes use a temporary file, fsync, rename,
and directory fsync. Seeds live separately with mode `0600` in a gitignored
`0700` directory. Back up the journal and keys together. Losing/restoring a stale
journal can lose obligations or break duplicate prevention; do not create a new
journal for previously used issuer/receiver accounts.

## 5. Redemption — deferred

```text
User YUSD Payment → Market holds YUSD → unwind strategy → RLUSD available
                                                              │
                                                              ▼
                    Issuer retires YUSD ◀── validated RLUSD payment to user
```

Suggested states: `received → unwinding → funded → paid → retired`.

A request does not depend on liquid RLUSD at creation time. Settling RLUSD and
retiring YUSD are separately idempotent operations. Unsettled requests keep an
explicit YUSD obligation; a failed retirement after payment must not repeat the
RLUSD payment. Cancellation/returns and optional escrow commitments require a
future specification. No redemption transactions are generated by this prototype.

## 6. Invariants and failure handling

| Condition | Response |
|---|---|
| Worker offline or mint paused | Collateral may arrive; journal/replay obligations and delay new issuance |
| Missing eligibility or trust-line capacity | Retain blocked deposit; recheck after onboarding/repair |
| Wrong issuer/currency, partial payment, bad tag, dust | Record for review; no YUSD issuance |
| Insufficient liquid collateral, excess cap, external issuance | Block the mint |
| Issuer global freeze or trust-line freeze | Block new issuance |
| Submission acknowledgement lost | Resolve saved hash; rebroadcast identical bytes if still valid |
| Missing transaction and incomplete ledger history | Keep unresolved; do not sign a replacement |
| Definitive failed or expired mint | Record failure; operator can request retry |
| Unexpected successful delivery | Pause; manual reconciliation, never blind retry |
| History gap or Testnet reset | Fail closed without advancing cursor |
| Abrupt process death | Inspect stale lock/PID, recover the same journal, reconcile signed transactions |

The cap and backing calculation use cumulative completed issuance, so returning
YUSD to the issuer does not automatically release capacity in this milestone.
Production reserve reporting must also cover pending deposit/refund obligations,
redemption holdings and attested strategy positions. A pause does not cancel
previously signed transactions or prevent users from sending collateral.

## 7. Delivery and verification

The package includes adversarial local tests for deposit validation, exact
amounts, replay/restart, lost acknowledgement, pause/access/cap/backing checks,
failed retries, history gaps and transaction finality. `npm run demo` exercises
the real Testnet flow and asserts the on-ledger deposit, issuance, holder balance,
and no additional issuance after reopening state and replaying the deposit.

An isolated `--mock` deployment uses locally issued MRLUSD to exercise the same
worker when official RLUSD funding is unavailable. `npm run test:live -- --mock`
also asserts pause/resume, another mint, repeated deposit submission and rejection
of a validated incoming XRP payment through the public CLI. This verifies the
payment workflow on Testnet but is not evidence of official RLUSD funding.

The official RLUSD faucet may require an authenticated browser session; account
provisioning does not guarantee collateral funding. See the runbook and actual
validation evidence for the deployment state. Production credentials, multisign,
KMS/HSM, HA storage, wallets, redemption and treasury execution are not implemented.
