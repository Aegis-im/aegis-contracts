# JUSDAssetGuard

`contracts/JUSDAssetGuard.sol` extends [`VaultAssetGuard`](AegisVault/README.md#custody-and-redemption) with a metered leg for the Ondo reserve program. JUSD holds part of its reserves as USDY on this contract; USDC is routed to a 2/4 multisig that mints USDY at Ondo and sends it back.

It is registered as a custodian address in `AegisMintingJUSD` and replaces the custody wallet there, so it inherits the whole base gate: assets leave only to whitelisted destinations or back to minting, there is no arbitrary-destination rescue and no ERC-20 approval surface, and returning collateral to minting is never paused.

## Three exits, one of them metered

| Call | Destination | Counter |
| --- | --- | --- |
| `withdraw` / `withdrawBatch` / `withdrawAll` | whitelisted venue, bank, sub-custodian | untouched |
| `returnToMinting` / `returnAllToMinting` | `AegisMintingJUSD` — supported collateral only; becomes redemption liquidity | untouched |
| `withdrawToOndo` | the Ondo multisig | **raises** `ondoOutstanding` |
| `pullFromOndo` | draws assets back out of the multisig | **lowers** `ondoOutstanding` |

The Ondo multisig is not an entry on the withdrawal whitelist. It is its own designated address, and the two sets are kept disjoint in both directions — a whitelisted address cannot become the multisig, and the multisig cannot be whitelisted. That separation is what makes the meter meaningful: there is no way to reach the multisig through an unmetered call.

`returnToMinting` only accepts assets `AegisMintingJUSD` lists as supported collateral, because minting has no way to release anything else. USDY is a reserve asset, not mint collateral, so while it is not listed there it cannot be returned: it goes back through the Ondo leg and returns as USDC. This matters because returns are never paused — the check, not the pause switch, is what keeps the reserve from being stranded in minting.

The base whitelist cooldown, if configured at deployment, applies to venue withdrawals only; the Ondo multisig is not a whitelist entry and is not delayed by it.

## What the counter measures

`ondoOutstanding` is the USD value, at 18 decimals, that the multisig is holding right now and has not returned. It is counterparty exposure to the mint/redeem round trip. `maxOndoOutstanding` caps it.

```text
cap = $10,000,000

withdrawToOndo(USDC, 1,000,000)     outstanding $1,000,000   headroom $9,000,000
pullFromOndo(USDY, 900,000)         outstanding    $19,000   headroom $9,981,000
                                    (900,000 USDY at $1.09 settles $981,000)
```

A redemption round trip is neutral overall — sending USDY back for redemption raises the counter by the USDY value, and the returning USDC lowers it again:

```text
withdrawToOndo(USDY, 900,000)       outstanding  +$981,000
pullFromOndo(USDC, 981,000)         outstanding  -$981,000
```

**What this bounds, and what it does not.** The cap bounds what the multisig holds at any one moment. It does not bound how much USDY the contract accumulates: once USDY is back here the headroom is free again, so recycling USDC → USDY → USDC repeatedly can build a USDY position larger than the cap. That is deliberate — the limit is a control on the multisig leg, not on reserve size. Monitor total reserves separately with `ondoAssetValue()`, which returns the USD value of all registered Ondo assets this contract holds. If reserve size should also be capped on-chain, that is a change to the check in `withdrawToOndo`, not a configuration change.

## Returns are proven, not asserted

`pullFromOndo` draws assets with `transferFrom` against the multisig's own balance, so provenance is established inside the transaction — no operator can credit a return that never arrived. The multisig must approve this contract first. It can also call `pullFromOndo` itself.

If the multisig instead pushes assets here with a plain transfer, the counter does not move. `setOndoOutstanding` lets the whitelist manager reconcile that deliberately; it is restricted to the limit-setting role because lowering the counter frees headroom, which is the same power as raising the cap.

Because a return can be worth more than what left — USDY accrues — a settlement larger than the outstanding position closes it at zero rather than going negative.

## Pricing

Both legs are valued through per-asset Chainlink-compatible feeds, so USDC and USDY share one USD limit. `setPriceFeed(asset, feed, heartbeat)` registers a feed and the maximum age of its answers. Prices are rejected when missing, non-positive, future-dated, stale beyond the heartbeat, from an incomplete round, or from a feed with more than 18 decimals; every feed is normalized to 18 decimals, matching `AegisMintingJUSD`. An asset with no valid price cannot move on the Ondo leg at all — the meter fails closed rather than guessing.

A feed cannot be unset while its asset is still registered on the Ondo leg, and an asset cannot be registered before its feed exists.

## Roles

| Role | Powers |
| --- | --- |
| `DEFAULT_ADMIN_ROLE` | Sets the redemption sink (`setMintingAddress`), administers roles. Expected to be a multisig; handover is delayed by `AccessControlDefaultAdminRules`. |
| `WHITELIST_MANAGER_ROLE` | Every boundary: the destination whitelist, the pause switch, the Ondo multisig address, `maxOndoOutstanding`, the Ondo asset registry, price feeds, and counter reconciliation. |
| `COLLATERAL_MANAGER_ROLE` | Moves assets inside those boundaries. Cannot raise a limit, reprice an asset, change the multisig, or whitelist a destination. |

Price feeds sit with the limit-setting role on purpose: a price decides how much headroom a transfer consumes, so repricing an asset is the same power as moving the cap.

Pausing stops outbound movement, draws from minting, and `withdrawToOndo`. It never stops `returnToMinting` or `pullFromOndo` — value coming back must stay reachable during an incident.

## Opening the leg

A freshly deployed guard has the Ondo leg closed: no multisig, no registered assets, and a zero cap. The whitelist manager opens it in this order, since each step checks the previous one:

```text
setPriceFeed(USDC, usdcUsdFeed, heartbeat)
setPriceFeed(USDY, usdyUsdFeed, heartbeat)
setOndoAsset(USDC, true)          # refused without a feed
setOndoAsset(USDY, true)
setOndoMultisig(multisig)         # refused if already whitelisted
setMaxOndoOutstanding(cap)        # zero cap keeps the leg shut
```

Separately, `AegisMintingJUSD` must `addCustodianAddress(guard)` for collateral to reach it, and — only if the guard should draw collateral itself via `pullFromMinting` — grant it `COLLATERAL_MANAGER_ROLE`.

Rotating the multisig requires a settled position (`ondoOutstanding == 0`), so outstanding value is never reattributed to a new holder.

## Validation

```sh
npx hardhat test test/30_jusd_asset_guard.spec.ts test/aegis-vault/asset-guard.spec.ts
```

The Ondo suite covers the metered round trip with real decimals (USDC at 6, USDY at 18, both on 8-decimal feeds), cap enforcement, venue withdrawals leaving the counter alone, multisig/whitelist disjointness, oracle failure modes, role separation, over-settlement, reconciliation, pause behavior, the closed initial state, returns refused for assets minting does not support, and a real `AegisMintingJUSD` mint carried through custody and back as redemption liquidity.

Deployment and multisig wiring are not scripted yet; the sequence above is what a transaction bundle needs to encode.
