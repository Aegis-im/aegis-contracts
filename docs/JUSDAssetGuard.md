# JUSDAssetGuard

`contracts/JUSDAssetGuard.sol` extends [`VaultAssetGuard`](AegisVault/README.md#custody-and-redemption) with a metered leg for the Ondo reserve program. JUSD holds part of its reserves as USDY on this contract; USDC is routed to a 2/4 multisig that mints USDY at Ondo and sends it back.

It is registered as a custodian address in `AegisMintingJUSD` and replaces the custody wallet there, so it inherits the whole base gate: assets leave only to whitelisted destination/asset pairs, back to minting, or across a whitelisted CCTP bridge route; there is no arbitrary-destination rescue; and returning collateral to minting is never paused.

## Four exits, one of them metered

| Call | Destination | Counter |
| --- | --- | --- |
| `withdraw` / `withdrawBatch` / `withdrawAll` | whitelisted venue, bank, sub-custodian | untouched |
| `returnToMinting` / `returnAllToMinting` | `AegisMintingJUSD` — supported collateral only; becomes redemption liquidity | untouched |
| `bridgeCctp` | whitelisted CCTP route — a (domain, recipient) pair on another chain | untouched |
| `withdrawToOndo` | the Ondo multisig | **raises** `ondoOutstanding` |
| `pullFromOndo` | draws assets back out of the multisig | **lowers** `ondoOutstanding` |

The Ondo multisig is not an entry on the withdrawal whitelist. It is its own designated address, and the two sets are kept disjoint in both directions — a whitelisted address cannot become the multisig, and the multisig cannot be whitelisted. That separation is what makes the meter meaningful: there is no way to reach the multisig through an unmetered call.

`returnToMinting` only accepts assets `AegisMintingJUSD` lists as supported collateral, because minting has no way to release anything else. USDY is a reserve asset, not mint collateral, so while it is not listed there it cannot be returned: it goes back through the Ondo leg and returns as USDC. This matters because returns are never paused — the check, not the pause switch, is what keeps the reserve from being stranded in minting.

The base whitelist cooldown, if configured at deployment, applies to venue withdrawals only; the Ondo multisig is not a whitelist entry and is not delayed by it. For the same reason the multisig carries no per-destination asset list — what it may receive is governed by the Ondo asset registry instead. A venue, by contrast, needs USDY on its own list before any reserve can reach it.

The multisig is also kept apart from a scheduled change of the redemption sink: it cannot be proposed as the new sink, and a pending sink cannot be made the multisig. The same holds for the bridge, and for a reason worth stating: a Safe deployed through the usual factory has the same address on every chain, so a route naming the multisig's own address on Arbitrum would hand the same counterparty the same exposure with the meter untouched. A route cannot name the multisig, and an address already reachable by bridge cannot become the multisig.

## The CCTP bridge

`bridgeCctp(asset, domain, mintRecipient, amount)` burns through Circle's CCTP TokenMessenger so the asset mints on another chain. It is the guard's one ERC-20 allowance, and it exists for the length of a single external call:

```text
forceApprove(messenger, amount)  →  depositForBurn(...)  →  forceApprove(messenger, 0)
                                                         →  assert balance delta == amount
```

Between transactions the allowance is always zero, so there is no standing approval for a later caller to drain. Three things make that containable rather than merely tidy:

- **The spender is immutable.** `cctpTokenMessenger` is fixed in the constructor and has no setter. No role — including `DEFAULT_ADMIN_ROLE`, which holds no power here anyway — can repoint the approval at a contract of its own choosing. A deployment with the zero address can never bridge; enabling it means a redeploy.
- **The amount is exact, never unlimited.** A messenger that tried to pull twice would fail on the second pull and take the whole call with it.
- **The balance delta is asserted.** If the messenger took more than `amount`, or took it and handed some back, `BridgeAmountMismatch` reverts the call. The event log cannot claim an amount that did not move.

A route is the **pair** `(domain, mintRecipient)`, keyed as `cctpRouteId(domain, mintRecipient)`. Approving a recipient on Arbitrum approves nothing on Base, and the recipient is never chosen at send time — only a whitelisted one can be named. Each route carries its own asset list, exactly as a destination does: a route with an empty list can carry nothing.

Routes are governed by `WHITELIST_MANAGER_ROLE` (`addCctpRoute`, `setCctpRouteAssets`, `removeCctpRoute`) and use the **same `whitelistCooldown`** as the destination whitelist — one immutable value, because both are the same decision: naming an address funds may reach. Routes seeded in the constructor are usable from deployment; routes added to a live contract wait. Removal is immediate, and re-adding restarts the wait. `COLLATERAL_MANAGER_ROLE` moves funds along a route and can neither create one nor pick a recipient.

`addCctpRoute` checks the domain against Circle's own `remoteTokenMessengers` registry, which rejects a mistyped domain immediately rather than after the cooldown has been spent. It also rules out a route home: the local domain has no remote messenger.

Two operational facts the contract does not paper over:

- **It is CCTP v2, standard transfer only.** The messenger is v2 (`0x28b5a0e9…cf5d`), because HyperEVM (domain 19) is served only by v2. Every burn waits for finality, pays no fee and leaves the destination caller open, so anyone holding the attestation can complete the mint; none of these is an operator parameter.
- **Circle caps a single burn** — 10,000,000 USDC on Ethereum at the time of writing. `cctpBurnLimit(asset)` reads it live. Larger moves are several `bridgeCctp` calls; the guard deliberately does not loop, so the cap stays visible to whoever signs.
- **The mint is not atomic.** The burn happens here; the mint needs Circle's attestation fetched and submitted on the destination chain, roughly 13-19 minutes at standard finality. Until then the value exists only as a burned message identified by the burn transaction hash, which is what Circle's attestation API looks up. Nothing in this contract can complete or recall it.

Bridging is paused by the pause switch, like every other outbound path.

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
| `DEFAULT_ADMIN_ROLE` | Nothing. It exists because `AccessControlDefaultAdminRules` requires an admin, and can retire itself. It cannot grant or revoke either operational role. |
| `WHITELIST_MANAGER_ROLE` | Every boundary: the destination whitelist and each destination's asset list, the CCTP bridge routes and their asset lists, the pause switch, the Ondo multisig address, `maxOndoOutstanding`, the Ondo asset registry, price feeds, counter reconciliation, the redemption sink, and appointing operators (`grantCollateralManager` / `revokeCollateralManager`). Fixed at construction. |
| `COLLATERAL_MANAGER_ROLE` | Moves assets inside those boundaries. Cannot raise a limit, reprice an asset, change the multisig, whitelist a destination, or add a bridge route. |

`COLLATERAL_MANAGER_ROLE` is the one role that can change after deployment. The whitelist manager grants and revokes it, effective immediately: a new operator reaches only destinations already on the whitelist, and every new destination still waits out the cooldown. A whitelist manager cannot appoint its own address, but nothing stops it appointing another account it controls — so with this power the whitelist manager can, on its own, both whitelist a destination and send to it once the cooldown passes. The cooldown is the window to notice. The generic `grantRole` / `revokeRole` still always revert, and an operator cannot renounce.

Price feeds sit with the limit-setting role on purpose: a price decides how much headroom a transfer consumes, so repricing an asset is the same power as moving the cap.

Pausing stops outbound movement, draws from minting, `bridgeCctp`, and `withdrawToOndo`. It never stops `returnToMinting` or `pullFromOndo` — value coming back must stay reachable during an incident.

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

Venues are configured independently of the Ondo leg: each is added with the assets it may receive, and `setDestinationAssets` opens or closes single pairs later. Bridge routes are configured the same way, and on the same cooldown:

```text
addCctpRoute(3, zeroPad(recipient, 32), 'Hyperliquid deposit', [USDC])
# usable after whitelistCooldown; setCctpRouteAssets opens or closes single pairs later
```

Separately, `AegisMintingJUSD` must `addCustodianAddress(guard)` for collateral to reach it, and — only if the guard should draw collateral itself via `pullFromMinting` — grant it `COLLATERAL_MANAGER_ROLE`.

Rotating the multisig requires a settled position (`ondoOutstanding == 0`), so outstanding value is never reattributed to a new holder.

## Sepolia deployment

A fresh, self-contained JUSD stack with the guard in place of a custody wallet, independent of the
older Sepolia JUSD addresses. All seven contracts are verified on Etherscan.

| Contract | Address |
| --- | --- |
| `JUSDAssetGuard` | [`0x9e9f449F22128C4DC3c59434555bCb8397568FD0`](https://sepolia.etherscan.io/address/0x9e9f449F22128C4DC3c59434555bCb8397568FD0#code) |
| `AegisMintingJUSD` | [`0xA1C55BEF15a9AAC5E455D40BDf2896422F752399`](https://sepolia.etherscan.io/address/0xA1C55BEF15a9AAC5E455D40BDf2896422F752399#code) |
| `JUSD` | [`0x9Cbde374D450b286d33bB96E5Aa452946c554307`](https://sepolia.etherscan.io/address/0x9Cbde374D450b286d33bB96E5Aa452946c554307#code) |
| `USDTest` (mock collateral, 6 dp) | [`0xE3254ff58fF2FddB2D78f139DDC5fEac681C220E`](https://sepolia.etherscan.io/address/0xE3254ff58fF2FddB2D78f139DDC5fEac681C220E#code) |
| `AegisConfig` | [`0x87D49993d9CD0a7448848740df1Ac5b7865d2C05`](https://sepolia.etherscan.io/address/0x87D49993d9CD0a7448848740df1Ac5b7865d2C05#code) |
| `AegisOracleJUSD` | [`0x85Fc06723e550D406Ab249c4f6c8d1645f9FbAB2`](https://sepolia.etherscan.io/address/0x85Fc06723e550D406Ab249c4f6c8d1645f9FbAB2#code) |
| `AegisRewards` | [`0x600f888a50c66bC39Ac83523EBdbba20Da984173`](https://sepolia.etherscan.io/address/0x600f888a50c66bC39Ac83523EBdbba20Da984173#code) |

`0x84fE172c15bb030BAA0dD497D30DD436c6b750E9` holds every role — minting's admin, settings, funds and collateral manager; the guard's
admin, collateral manager and whitelist manager; the config operator and trusted signer; the oracle
operator; and the USDTest owner. It is also the single whitelisted destination, allowed to receive
USDTest. Both guard cooldowns are **60 seconds**: a newly whitelisted destination waits a minute
before it can receive funds, and replacing the redemption sink waits a minute between propose and
apply. The Ondo leg ships closed — no multisig, no registered assets, zero cap.

`USDTest` is mock collateral with no backing, minted without limit by its owner. Testnet only.

```sh
# deploy (idempotent — a run that dies midway resumes from the record)
VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/jusd/deploy-jusd-stack.ts --network sepolia
# exercise it: mint collateral and JUSD, move through the guard, redeem
VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/jusd/smoke-jusd-stack.ts --network sepolia
# verify sources on the explorer
npx hardhat run scripts/jusd/verify-jusd-stack.ts --network sepolia
```

Both scripts rehearse against a local node before touching a live network: start `npx hardhat node`
and run them with `--network localhost`. The admin account is impersonated there, using the real
key when `PRIVATE_KEY` matches so EIP-712 order signing works.

Record: `deployments/sepolia/JUSDStack.json` — addresses, constructor arguments, transaction hashes
and which wiring steps have landed.

## Admin panel

`aegis-admin-panel` gains a **Manage JUSD** tab (Web3 page) that appears on any chain present in
`JUSD_STACK`. It covers the guard end to end: role banner and balances, the USDTest faucet, the
withdrawal whitelist as destination/asset pairs with live cooldown countdowns, the three asset legs
(push to a destination, return to minting, draw from minting), the propose/apply/cancel flow for the
redemption sink, and the Ondo leg including limits, price feeds and the metered transfers. Reverts
are decoded against the guard's custom errors rather than shown as raw calldata.

## Validation

```sh
npx hardhat test test/30_jusd_asset_guard.spec.ts test/aegis-vault/asset-guard.spec.ts
```

The Ondo suite covers the metered round trip with real decimals (USDC at 6, USDY at 18, both on 8-decimal feeds), cap enforcement, venue withdrawals leaving the counter alone, multisig/whitelist disjointness, oracle failure modes, role separation, over-settlement, reconciliation, pause behavior, the closed initial state, returns refused for assets minting does not support, per-destination asset gating against the Ondo registry, collisions between a scheduled sink change and the multisig, and a real `AegisMintingJUSD` mint carried through custody and back as redemption liquidity.

Deployment and multisig wiring are not scripted yet; the sequence above is what a transaction bundle needs to encode.
