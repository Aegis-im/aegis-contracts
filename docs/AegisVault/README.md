# AegisVault

Reusable deployment of the existing token, minting, configuration, staking, oracle, rewards and LayerZero infrastructure. Contracts live in `contracts/AegisVault`; existing deployed token contracts are unchanged. This is a new deployment, not an upgrade or migration of the earlier credit vault.

For AMINA, **Amina USDG (`ausdg`) is the yield-bearing product**. **Amina Deposit USDG (`adUSDG`) is its synthetic deposit intermediary**:

```text
USDC → signed mint → adUSDG → ERC-4626 deposit → ausdg
USDC ← bank-approved redemption ← adUSDG ← ERC-4626 exit / cooldown ← ausdg
```

The investor UI has a single **Deposit / Withdraw** form. Deposits convert USDC to `ausdg` through the minting and staking transactions, including approvals when needed. Withdrawals convert `ausdg` back to USDC through an immediate fee-bearing exit or a cooldown, followed by a bank redemption request. Skipping cooldown does not skip bank approval. After a cooldown, **Continue withdrawal** releases the reserved intermediary and submits the bank request in one guided sequence. The bank sends USDC directly on approval.

The intermediary has no investor-facing balance, action, or opt-out. The UI shows USDC valuations from on-chain quotes and `ausdg` shares. Technical intermediary controls remain inside Bank operations. The base token is not a reported-NAV share; staking shares accrue value when actual base tokens fund the staking contract.

Interrupted operations retain their phase, exact receipt-derived amounts and pending transaction hash in browser storage, scoped to the wallet, chain and minting contract. **Continue deposit / withdrawal** reconciles a saved transaction before requesting another; it does not sweep unrelated wallet funds. Deposit and withdrawal progress are stored separately, so deposits can continue while a withdrawal awaits cooldown or bank approval. Expired/rejected withdrawal requests can be retried using the same withdrawn assets. An operation that has not broadcast its first transaction can be reset with **Change amount**.

Recovery requires the same browser storage and wallet. Clearing storage or moving to another browser does not migrate unfinished operations. Ambiguous broadcasts without a returned hash and transactions replaced while the page was closed require reconciliation from wallet activity; the UI fails closed rather than risking a duplicate transfer. A saved cooldown altered outside this flow also requires reconciliation. Supported browsers serialize flows across tabs using Web Locks.

## Components

| Component | Responsibility |
| --- | --- |
| `VaultToken` | Configurable name, symbol and permit domain; owner-managed minter and blacklist. 18 decimals, matching minting and OFT accounting. |
| `VaultConfig` | Independent trusted signer, whitelist switch and operators per deployment. |
| `VaultMinting` | Signed mint/redeem orders, configurable asset feeds, fees, limits, custodian allowlist, collateral withdrawals, funded redeem approvals, optional rewards and mint/burn bridge operator. |
| `VaultAssetGuard` | Optional on-chain replacement for a custody wallet. Withdrawals only to whitelisted destinations, returns to minting as redemption liquidity, separate asset-moving and whitelist-managing roles, no arbitrary-destination escape hatch. |
| `VaultStaking` + `VaultStakingSilo` | ERC-4626 staking, configurable share identity, cooldown and instant exit fee. Transparent proxy; implementation initialization disabled. |
| `VaultChainlinkOracleV3` | Operator-maintained AggregatorV3-compatible rounds with configured description and decimals. This is not a decentralized Chainlink data feed. |
| `VaultRewards` | Optional signed reward snapshots; unfinalized income can fund staking, finalized snapshots can be claimed. |
| `VaultIncomeRouter` | Optional minting/approved-DEX income routes into rewards. |
| `VaultMintBurnOFTAdapter` | Home-chain base-token bridge using the minting contract's authorized mint/burn hooks. |
| `VaultStakingOFTAdapter` | Home-chain lock/unlock adapter for staking shares. |
| `VaultOFT` | Configurable remote token; deploy once for each base/share representation on a remote chain. |

Names, symbols, signature domain names, admin delay, roles, assets, custodians, fees, limits, feed addresses/heartbeats, oracle metadata, cooldown and bridge endpoint are supplied in the deployment configuration. Existing administration functions can change operational settings; token identities are fixed at deployment. Protocol conventions such as 18 token decimals and the 10,000 basis-point denominator remain fixed. The new source tree has no references to the old token identity.

## Pricing and signed orders

The generic minting contract accepts a direct AggregatorV3 collateral feed or a Chainlink feed registry. It normalizes feed precision and uses the configured base-token USD oracle for both mint and redemption quotes. Missing, non-positive, future, incomplete and stale prices revert. Quote getters return amounts before mint/redeem fees. Minting conservatively caps signed output at the on-chain quote; redemption caps payout at the signed collateral amount and current quote.

Generic EIP-712 orders use `tokenAmount` (not a product-specific field) and the configured domain name, version `1`, deployment chain ID and minting address. The signing service is off-chain. Collateral transfer, issuance, staking, requests and payments execute on-chain. Signature domains and nonce tracking prevent cross-deployment reuse and replay.

Mint/redeem eligibility uses the new deployment's `VaultConfig`. Amina's test configuration disables its whitelist; the existing shared config is untouched. The base token and remote OFT retain blacklist controls. Staking shares themselves do not add a separate blacklist. A blacklisted base-token recipient cannot receive base tokens.

## Staking semantics

All four standard ERC-4626 entry/exit operations remain available. With cooldown enabled, instant `withdraw(assets, receiver, owner)` delivers exactly the requested **net** assets. `previewWithdraw`, `previewRedeem` and `maxWithdraw` include the exit fee. `convertToAssets` and `convertToShares` exclude fees. The fee is a proportion of the gross underlying amount; the maximum configurable fee is 9,999 basis points.

The separate `cooldownAssets` / `cooldownShares` flow burns shares, fixes the underlying amount and transfers it into a silo. This amount no longer participates in staking yield. Adding another cooldown aggregates its amount and resets the wait. `unstake(receiver)` releases base tokens after maturity; disabling cooldown permits immediate release. These base tokens still require a separate bank redemption for USDC. ERC-4626 behavior follows the [standard's preview, fee and withdrawal requirements](https://eips.ethereum.org/EIPS/eip-4626).

## Custody and redemption

New mint collateral is accounted as custody-transferrable. Authorized collateral managers can call `transferToCustody` / `forceTransferToCustody`, respecting frozen funds and the custodian allowlist. Returning collateral via ERC-20 transfer makes it untracked liquidity available for redemptions. A token balance at minting is not necessarily redemption liquidity; use `untrackedAvailableAssetBalance`.

`VaultAssetGuard` can take the place of the custody wallet itself. It is registered through `addCustodianAddress` like any other custodian, but it is a contract with a gate. Assets leave it in exactly two directions: `withdraw` sends to an address on its withdrawal whitelist (venues, banks, RWA providers, sub-custodians), and `returnToMinting` sends to the configured minting contract, where the collateral becomes the untracked liquidity that funds redeem requests. Only assets minting supports can be returned: minting has no way to release anything else, so an unsupported token is refused rather than stranded there. `setMintingAddress` names that redemption sink and is restricted to `DEFAULT_ADMIN_ROLE`; it must be a contract.

Duties are split. `COLLATERAL_MANAGER_ROLE` moves assets and holds no authority over where they may go. `WHITELIST_MANAGER_ROLE` maintains the destination whitelist — each entry carrying an operator label — and the pause switch. Pausing stops outbound movement and draws from minting; returning collateral to minting is never paused, so redeem requests stay fundable during an incident. `DEFAULT_ADMIN_ROLE` administers roles and the redemption sink.

The whitelist is the only security boundary the contract has, so there is deliberately no arbitrary-destination rescue function and no ERC-20 approval surface. A compromised asset-moving key can shuffle funds between addresses the whitelist manager already approved, and nowhere else. Recovering a stray token means whitelisting its recipient first, which leaves an on-chain record. Native currency that reaches the contract leaves through the same gate via `withdrawNative`.

An optional whitelist cooldown, fixed at deployment, makes every newly added destination (including the initial whitelist) wait that many seconds before it can receive funds; `destinationActiveAt` reports when it opens. A compromised whitelist manager then cannot add a destination and have it used in the same breath, leaving time to notice the `DestinationAdded` event and react. Removal takes effect immediately, and re-adding a destination restarts its cooldown. Zero disables it. The cooldown gates `withdraw*` only: returns to minting are never delayed.

Granting the guard `COLLATERAL_MANAGER_ROLE` on minting closes the loop in the other direction: `pullFromMinting` and `pullAllFromMinting` draw custody-transferrable collateral out of minting without a second operator call to a second contract. That grant is optional — collateral still arrives whenever a collateral manager calls `transferToCustody` with the guard's address.

A signed `requestRedeem` locks base tokens. The funds manager approves and pays from returned collateral, or rejects and unlocks tokens. Expired requests can be unlocked. Each request has a unique ID and nonce. The underlying bank redemption has no automatically enforced 30-day delay; Amina's configured 30-day duration applies to fee-free **staking** exits. Returning liquidity, approving payouts and updating oracle prices remain operator actions.

## Rewards can be attached later

The core deploys with `aegisRewards == address(0)`. Minting, custody, staking, redemption and bridging work without rewards. `depositIncome` explicitly reverts while rewards are absent. Before installing rewards, an operator can mint fully collateralized intermediary tokens and transfer them to staking. The UI exposes this as **Add funded income**. Do not fund an empty staking vault.

Later, run `scripts/aegis-vault/rewards.ts`. It deploys rewards/router, binds the token/config/minting/staking addresses, grants the router the minting funds-manager role, authorizes reward deposits and finally sets minting's rewards address. No core redeployment or balance migration is required. Retrying uses saved deployment addresses. Governance may detach future deposits by setting the rewards address to zero; old reward claims remain with the old distributor.

The router's minting route uses an order whose `userWallet` is the **router** and whose signature belongs to the **minting** domain. DEX routes use an operator's wallet and the router domain. Only allowlisted DEX contracts should receive approval. DEX prices, calldata, pool addresses, Permit2 and route settings require deployment-specific configuration; the Sepolia core deployment does not create liquidity pools.

## Deploy and operate

Configuration: `config/AegisVault/amina.sepolia.json`. Supply `PRIVATE_KEY` through the existing ignored environment file. Optional `SEPOLIA_RPC_URL` overrides the RPC. Never expose the signing key to the frontend.

```sh
VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/aegis-vault/deploy.ts --network sepolia
npx hardhat run scripts/aegis-vault/check.ts --network sepolia
VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/aegis-vault/smoke.ts --network sepolia
npx hardhat run scripts/aegis-vault/export-ui.ts --network sepolia
npx hardhat run scripts/aegis-vault/quote-server.ts --network sepolia
# Later, attach optional rewards:
VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/aegis-vault/rewards.ts --network sepolia
# Later, install the asset guard in place of a custody wallet:
VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/aegis-vault/asset-guard.ts --network sepolia
```

`asset-guard.ts` deploys `VaultAssetGuard`, points it at minting, registers it as a custodian address, grants the configured operational roles and whitelists the configured destinations. Re-running it is a no-op. Its configuration keys are optional, with these defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `assetGuard` | absent | Deploy the guard as part of `deploy.ts` rather than later. |
| `guardDestinations` | the configured `custodian` wallet | Initial withdrawal whitelist, as `{ "address", "label" }` entries. |
| `guardManager` | `manager` | Holder of `COLLATERAL_MANAGER_ROLE` — moves assets. |
| `guardWhitelistManager` | `admin` | Holder of `WHITELIST_MANAGER_ROLE` — maintains the whitelist and pause. |
| `guardDrawFromMinting` | `true` | Grant the guard minting's `COLLATERAL_MANAGER_ROLE` so it can draw collateral itself. |
| `guardRetireWallet` | `false` | Remove the previously configured custody wallet from minting's custodian list. |
| `guardWhitelistCooldown` | `0` | Seconds a newly whitelisted destination waits before it can receive funds. Fixed at deployment; `0` disables it. |

Retiring the old wallet is a separate governance decision, so it is never implied by installing the guard. Until it is retired, both the wallet and the guard can receive collateral.

Use `VAULT_CONFIG` / `VAULT_RECORD` for another deployment. Deployment records include constructor arguments, transaction hashes and proxy addresses. The script checkpoints deployments and refuses changed settings or overwriting a ready deployment. `export-ui.ts` writes ABI and deployment metadata to `VAULT_UI_OUTPUT` (a staging folder by default).

The Sepolia quote server binds only to `127.0.0.1:8788`, accepts local frontend origins and signs at most 1,000 units per request. It supports mint/redeem only. It is a development helper; a hosted bank deployment needs an authenticated quote service implementing the same response shape. Configure `REACT_APP_AEGIS_VAULT_QUOTE_URL` for a hosted frontend; the local app defaults to the local service. `sign-order.ts` also emits operator quotes for scripts using `VAULT_USER`, `VAULT_AMOUNT` and optional `VAULT_ORDER_TYPE=1`.

Sepolia uses existing test USDC and two operator-maintained test price references, initially 1 USD. Their seven-day heartbeats require ongoing price updates; quotes fail closed when stale. A real collateral feed can replace the test reference via `setAssetPriceFeed`. The staking proxy is owned by the configured admin through a ProxyAdmin; minting/rewards admin delays do not impose a proxy upgrade timelock.

LayerZero adapters alone do not enable a remote route. Remote OFTs, peer bindings, messaging security configuration and fees must be configured before cross-chain transfers. The test suite checks real OFT send/receive code with a test transport, not live cross-chain finality.

## Validation

```sh
npx hardhat test test/aegis-vault/vault.spec.ts test/aegis-vault/oft.spec.ts test/aegis-vault/asset-guard.spec.ts
```

The implementation derives from existing infrastructure but its generalization and fee/pricing changes need independent review before any production deployment. Sepolia deployment and lifecycle evidence are recorded separately alongside deployment records; local tests do not substitute for those checks.

Amina addresses, executed checks and remaining operational limits: [deployment validation](VALIDATION.md).
