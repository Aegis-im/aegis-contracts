# YUSD on the XRP Ledger — Technical Proposal

**From:** Aegis  
**Updated:** 2026-09-10  
**Scope:** Trust-line YUSD backed by RLUSD. The first implementation covers
XRPL Testnet token setup and payment-triggered minting. Redemption is deferred.

This revision incorporates the [redemption discussion](https://chatgpt.com/share/6aa29607-ff54-83eb-9d34-810c1e5e9b0f)
and the subsequent decision to mint on an incoming collateral payment. Both
minting and redemption are asynchronous backend workflows. No DEX offer is
required for either primary-market flow.

## 1. Proposed design

| Area | Proposal |
|---|---|
| Token | Trust-line token issued by a dedicated YUSD issuer account |
| Collateral | RLUSD on the same XRPL network; identify it by currency **and issuer** |
| Mint | Validated RLUSD Payment to Aegis triggers a separate YUSD issuer Payment to the sender |
| Redeem, later | User sends YUSD; Aegis unwinds liquidity, settles RLUSD, then retires YUSD |
| Primary-market access | Backend eligibility check; production KYC/credential policy to be integrated |
| Testnet access | Explicit operator-managed address allowlist |
| Rewards, later | Direct payments to eligible holders |
| Secondary market, optional | YUSD/RLUSD AMM or DEX liquidity, independent of primary issuance |
| Smart contracts | None required |

YUSD currency code: `5955534400000000000000000000000000000000`.

| RLUSD network | Issuer |
|---|---|
| Mainnet, reference only | `rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De` |
| Testnet, implementation default | `rQhWct2fv4Vc4KRjRgMrxa8xPN9Zx9iLKV` |

RLUSD currency code: `524C555344000000000000000000000000000000`.
Testnet RLUSD has no monetary value and is not backed by real-world assets.
Network identity and token addresses must never be inferred from the ticker.

## 2. Accounts and configuration

| Account | Role |
|---|---|
| `AEGIS_YUSD_ISSUER` | Issues YUSD directly to holders; later receives YUSD for retirement |
| `AEGIS_MARKET` | Receives mint RLUSD; later holds redemption YUSD and pays redemption RLUSD |
| `AEGIS_CREDENTIALS`, later | Credential lifecycle if chosen for production eligibility |
| `AEGIS_DISTRIBUTOR`, later | Reward payments |

There is no pre-issued YUSD inventory or mint offer. The issuer's Payment creates
YUSD on the recipient's trust line. The market needs an RLUSD trust line; each
user needs both RLUSD and YUSD trust lines and enough XRP for reserves and fees.

The Testnet issuer enables `asfDefaultRipple`, has no transfer fee, and uses a
locally stored test seed. It does not enable RequireAuth, clawback, trust-line
locking, or disable the master key. The allowlist controls mint service access;
it does not restrict subsequent token transfers or make an XRPL Payment
permissioned. Production signer custody, RequireAuth, freeze/clawback, and
transfer policy require a separate deployment configuration. Irreversible
escrow-related flags are unnecessary for this milestone.

## 3. User flows

### 3.1 Onboarding

1. Aegis checks the user's eligibility. Testnet substitutes an explicit allowlist
   for the future KYC/credential integration.
2. The user creates trust lines to the configured RLUSD and YUSD issuers.
3. The app supplies the receiving address, destination tag, rate, fee, and status.

A PermissionedDomain and Permissioned DEX do not enforce access to this direct
payment mint path. Eligibility must be checked by the backend before issuance.

### 3.2 Mint on incoming payment

1. The user sends RLUSD directly to `AEGIS_MARKET`:

   ```text
   Payment
     Account:        user
     Destination:    AEGIS_MARKET
     DestinationTag: 1                # Testnet mint routing tag
     Amount:         { RLUSD currency, configured RLUSD issuer, value }
   ```

   No OfferCreate, self-payment, DomainID, pathfinding, or DEX liquidity is
   required. The client does not enable partial payments.

2. The backend replays validated receiver account history. It accepts only
   successful Payments, checks destination, tag, sender, collateral identity,
   and the actual `meta.delivered_amount`. Partial payments and unsupported
   deposits are retained for review and do not trigger minting.
3. It checks eligibility, the user's YUSD trust-line capacity, pause state,
   supply cap, issuer/freeze settings, and available backing.
4. It persists a signed transaction and its hash before submission:

   ```text
   Payment
     Account:        AEGIS_YUSD_ISSUER
     Destination:    original RLUSD sender
     Amount:         { YUSD currency, AEGIS_YUSD_ISSUER, minted value }
     LastLedgerSequence: bounded
     Memo:           incoming payment hash
   ```

5. A validated successful YUSD delivery completes the mint. A user SourceTag,
   when present, becomes the mint Payment's DestinationTag.
6. Production treasury may subsequently allocate matched backing to approved
   strategies. The Testnet prototype keeps all collateral at `AEGIS_MARKET`.

**Testnet economics:** 1 RLUSD → 1 YUSD, zero fee, six decimal places, a fixed
1,000,000 YUSD cumulative issuance cap. These are prototype assumptions, not a
production price/oracle or depeg policy. Amounts use exact decimal strings.

The incoming RLUSD transaction and outgoing YUSD transaction are **not atomic**.
If issuance is paused, a trust line is missing, or the backend stops, collateral
can already have arrived. The deposit remains pending/blocked for reconciliation;
it is not discarded and there is no automatic refund in this milestone. A
production version needs quote expiry/minimum output, refund handling, service
availability guarantees, and strategy/custody accounting.

### 3.3 Redeem — future milestone

Redemption is a request lifecycle because backing may be deployed in strategies.
It is not an instant reverse mint or an RLUSD-for-YUSD offer.

**Stage 1 — receive YUSD and unwind**

1. The backend registers a request with amount, recipient, and settlement terms.
2. The user sends YUSD to `AEGIS_MARKET`, correlated to that request.
3. After validation, Aegis records the held YUSD and starts the matching strategy
   unwind and RLUSD recall. No liquid RLUSD needs to be present at request time.

**Stage 2 — settle and retire**

1. Treasury confirms recalled RLUSD is available.
2. Aegis pays the agreed RLUSD to the user and waits for validated success.
3. The market sends the corresponding held YUSD to `AEGIS_YUSD_ISSUER`, retiring it.

Each step must be idempotent and independently reconciled. YUSD held for pending
redemptions remains part of reserve obligations until retirement. If settlement
is delayed or fails, the request remains outstanding; any cancellation/return
policy must be explicit. A token-escrow commitment can be evaluated later, but it
is not required by this design and is not implemented in the Testnet milestone.

### 3.4 Secondary liquidity and rewards — later

An optional YUSD/RLUSD AMM can provide a market-price exit independently of
primary minting and redemption. Its compatibility depends on the production
YUSD authorization policy.

Direct reward distributions would snapshot balances at a validated ledger,
apply eligibility and exclusions, submit payments, and reconcile each result.
YUSD rewards must be backed by realized RLUSD proceeds added to reserves. A staked
token, reward denomination, and vault support are outside this milestone.

## 4. Implementation scope

The runnable package is [`../../xrpl`](../../xrpl/README.md).

An explicit `--mock` mode provisions a separate Testnet deployment with a local
MRLUSD collateral issuer for live verification without the authenticated RLUSD
faucet. It uses the same mint worker, distinct token identities and separate
state. It never replaces official RLUSD in the default deployment.

| Included in Testnet | Deferred |
|---|---|
| Faucet-funded issuer, receiver, and demo user | Mainnet deployment and production signing |
| Issuer settings and trust-line setup | KYC, on-ledger credentials, RequireAuth policy |
| Direct RLUSD deposit and YUSD mint | Redemption, refunds, custody and strategy execution |
| Validated account history replay | Multi-instance indexer/database/service deployment |
| Durable signed transaction journal and reconciliation | Quote API, pricing oracle, fees and depeg automation |
| Allowlist, pause, cap and liquid-backing checks | Frontend/wallet connectors, rewards and AMM |
| Local failure tests and live demo command | Production reserve attestations and external audit |

## 5. Required controls

- Only validated successful collateral delivery can create a mint obligation.
- Check currency and issuer on `delivered_amount`; never credit nominal Amount.
- A deposit hash identifies at most one successful YUSD issuance.
- Persist signed bytes, hash, sequence, and ledger validity bounds before submit.
- An uncertain submission is reconciled/rebroadcast using identical bytes. A new
  signature is allowed only after a definitive failure or proven expiration.
- A missing transaction after its validity window is not sufficient evidence of
  expiration unless the server has complete history for that window.
- Persist the history cursor only after all pages of the requested range arrive.
- Serialize issuer signing and state mutation; do not share this local journal
  between hosts or run independent copies against the same issuer.
- New mints require sufficient liquid collateral for cumulative issued YUSD
  plus the new mint. Unknown external issuance blocks further minting.
- Pause blocks new signatures; previously signed payments must still reconcile.
- Unexpected successful delivery pauses issuance and requires manual review.
- Production reserve reporting must include outstanding mint/refund obligations,
  circulating YUSD and held redemption YUSD, with strategy/custody attestations.

## 6. Delivery sequence

| Phase | Deliverable |
|---|---|
| 1, current | XRPL Testnet YUSD and incoming-payment minting |
| 2 | Production eligibility, quotes, refund policy, signer custody, service deployment |
| 3 | Two-stage redemption, strategy/custody adapters, reserve reporting |
| 4 | Security/failure audit and controlled Mainnet launch |
| Later | Rewards, optional AMM, staked product |

## 7. Items to validate before production

1. Issuer RequireAuth, freeze/clawback, multisign and key-custody policy.
2. Pricing, mint fees, minimum output, expiry, and unmatched-deposit refunds.
3. Strategy allocation timing, reserve evidence, and RLUSD control/depeg response.
4. Redemption settlement terms and whether an escrow commitment adds value.
5. Primary-market eligibility and secondary-market compatibility.

## 8. Official references

- [RLUSD networks, addresses, and faucet](https://docs.ripple.com/products/stablecoin/developer-resources/rlusd-on-the-xrpl)
- [Issue a fungible token](https://xrpl.org/docs/tutorials/how-tos/use-tokens/issue-a-fungible-token)
- [Stablecoin issuer settings](https://xrpl.org/docs/concepts/tokens/fungible-tokens/stablecoins/settings)
- [Payment](https://xrpl.org/docs/references/protocol/transactions/types/payment)
- [Partial payments and delivered amounts](https://xrpl.org/docs/concepts/payment-types/partial-payments)
- [Reliable transaction submission](https://xrpl.org/docs/concepts/transactions/reliable-transaction-submission)
- [account_tx](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/account-methods/account_tx)
