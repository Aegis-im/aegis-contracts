> Historical credit-vault prototype. Superseded by [AegisVault](../AegisVault/README.md). Source, tests and scripts are preserved under `archive/credit-vault/`; deployed contracts are not upgraded or migrated.

# Aegis Credit Vault — synchronous deposits, asynchronous redemptions

This implementation supersedes the September 18 epoch-based prototype. It uses the repository's MIT-licensed OpenZeppelin Contracts 5.0.1 ERC4626, SafeERC20, AccessControl, Pausable, ReentrancyGuard and Math primitives. The custom vault and this composition have not been independently audited.

## Public flow

- `deposit(assets, receiver)` / `mint(shares, receiver)` are synchronous ERC-4626 operations. USDC arrives and shares are minted in the same transaction, using current reported NAV. `previewDeposit` / `previewMint` retain standard rounding.
- Shares have 18 decimals, symbol `acUSDC`, and can transfer between wallets unless the sender or receiver is blacklisted. USDC has 6 decimals. Transfers into the vault itself are rejected; escrow is entered only through redemption requests.
- `requestRedeem(shares, controller, owner)` escrows shares and starts a fixed **30-day** cooldown. It does not fix a USDC amount. Escrowed shares remain in total supply and participate in gains/losses until fulfillment. Other shares remain transferable.
- Requests always return ID `0`, using ERC-7540's controller-aggregated form. Each controller can have one pending request plus an independently claimable balance. A second pending request is rejected rather than resetting an existing cooldown. Requests cannot be cancelled.
- After cooldown, anyone can call `fulfillRedeem(controller)`. It requires enough active USDC to fund the whole pending request, fixes its value at current NAV, burns the escrowed shares, and reserves the payout. It never pushes cash to the user. There is no monthly settlement, cutoff, epoch, or automatic transaction.
- `redeem(shares, receiver, controller)` / `withdraw(assets, receiver, controller)` consume funded entitlements. They do not use shares remaining in the user's wallet. `maxRedeem` / `maxWithdraw` expose the funded balance. `previewRedeem` / `previewWithdraw` always revert, as required for the asynchronous side.
- Partial claims are supported. Multiple funded requests aggregate their assets/shares for a controller and use that aggregate exchange rate. Redemption rounds assets down; withdrawal rounds shares up. A partial asset withdrawal that would consume the final share by rounding is rejected; a full claim receives all remaining cash. A zero-valued loss claim is cleared using `redeem`.
- `setOperator` / `isOperator` authorize request controllers. An ERC-20 allowance permits requesting another owner's shares but does not grant permission to claim their redemption. A different controller must authorize the caller to avoid unsolicited pending-request griefing. Controller overloads for synchronous `deposit`/`mint` pull USDC from the authorized controller.
- ERC-165 exposes operator `0xe3bc4e65`, async redemption `0x620ee8e4`, and ERC-7575 `0x2f0a18c5` interfaces; `share()` returns this vault. Async-deposit interface support is deliberately false.

Reference: [ERC-7540](https://eips.ethereum.org/EIPS/eip-7540). Interface compatibility is an implementation target, not an independent conformance certification.

## Reported value and movable liquidity

`totalAssets() = liquidAssets + reportedExternalAssets`

Both values exclude `claimReserves`. Actual token balance must cover `liquidAssets + claimReserves`; direct donations are not priced into shares.

`fundCounterparty(assets)` lets the manager move active cash to the immutable counterparty. It decreases liquid assets and increases external book value by the same amount, leaving NAV unchanged. Funded claim reserves cannot be sent out. Pending requests do not reserve cash and can remain pending beyond cooldown if liquidity is unavailable; there is no FIFO guarantee.

`reportExternalAssets(value)` is the preferred manager reporting method. Its input is only the value held by the counterparty, excluding vault cash and funded claims. It updates `reportedExternalAssets` and emits `ExternalAssetsReported(previousValue, newValue)`. The value can be zero even when the vault holds cash. Deposits and investor claims do not need to be reconciled into this input; counterparty funding and returns do. `reportNAV(nav)` remains available as a legacy total-NAV alternative, but the UI uses external-only reporting. It updates share pricing immediately. Reports do not transfer funds. There is no automated oracle, interest accrual, stale-report expiry, or guarantee against inaccurate reports. The manager must report losses and gains promptly and pause deposits/fulfillment when valuation is unreliable. A stale understated NAV allows incoming deposits to dilute existing holders; synchronous deposits deliberately rely on the quality and timeliness of the reported value.

`returnLiquidity(assets)` can be called by the counterparty or manager and pulls approved USDC. It reduces external book value and increases active cash equally. Report accrued yield before returning it so it is not counted twice. Returns cannot exceed external book value.

Example in USDC: deposit 1,000 → fund 1,000 → report external assets 1,010 → return 1,010. NAV is 1,010 after both the report and return, not 1,020. After a redemption is funded, its cash reserve and burned shares leave active NAV/supply together. Later losses affect active/pending holders, not already reserved claims.

Deposits are disabled if active NAV is zero while shares still exist. Total-loss requests can be fulfilled and cleared at zero value. No claim expiry exists.

## Access and pause

Admission currently uses **only the local blacklist**, plus the existing zero-address, vault-address, pause, and accounting guards. AegisConfig membership and its whitelist switch are not consulted by deposits, requests, transfers or claims. The shared AegisConfig is unchanged. `setConfig(address)` remains admin-only and validates its getters, but replacing the config does not re-enable whitelist gating. Restoring whitelist enforcement would require a code change and redeployment of this non-upgradeable version.

The vault has its own blacklist with YUSD-compatible `isBlackListed`, `getBlackListStatus`, `addBlackList`, `removeBlackList`, `AddedBlackList`, `RemovedBlackList`, and `Blacklisted(address)` names. DEFAULT_ADMIN_ROLE administers it. Both share sender and receiver are checked, including mint/burn endpoints. It does not depend on the YUSD token or share its blacklist storage. As in YUSD, transferFrom checks the owner/recipient, not the spender's blacklist status.

Escrow requests additionally check owner/controller, fulfillment checks controller, and cash claims check controller/receiver. A later blacklist entry therefore blocks pending fulfillment and funded claims, including operator claims, until removed. Whitelist removal alone does not freeze existing recovery: pending requests can still be fulfilled, and funded controllers may claim to themselves while paused or de-whitelisted. An alternative cash receiver must be a valid, non-blacklisted address. Operators can claim to eligible receivers and therefore are trusted authorities.

The manager reports NAV and funds the counterparty. Guardian pauses; default admin unpauses and administers roles. Pause blocks deposits, transfers, requests, fulfillment, and funding; reporting NAV, returning liquidity, and claiming reserved funds remain available.

## Deployment and frontend

The constructor now has **five** addresses: asset, AegisConfig, counterparty, admin, manager. The 30-day cooldown is a constant. No initial settlement date or notice period is accepted.

The Sepolia contract `0xEC843093CE8E3D04b44263d18595a416c632408A` is the old non-upgradeable epoch version. It is not this implementation and cannot be upgraded into it. Its deployment record is preserved. The deployment script refuses to overwrite an existing record; archive it explicitly before deploying a successor. The replacement deployment is recorded below.

Set `CREDIT_VAULT_ASSET`, `CREDIT_VAULT_CONFIG`, `CREDIT_VAULT_COUNTERPARTY`, `CREDIT_VAULT_ADMIN`, `CREDIT_VAULT_MANAGER`, then use `npx hardhat run scripts/deploy-credit-vault.ts --network <network>`.

The app's `/credit-yield` page uses `REACT_APP_CREDIT_VAULT_ADDRESS`, `REACT_APP_CREDIT_VAULT_CHAIN_ID`, and optionally `REACT_APP_CREDIT_VAULT_RPC_URL`. Configure it with a fresh compatible deployment; interface discovery rejects the old epoch vault. The UI supports self-managed requests/claims and operations; delegated operator and share-transfer flows are available through the contract API, without dedicated UI controls.

## Validation surfaces

Contract: `contracts/AegisCreditVault.sol`, exercised through its public API by `npx hardhat test test/28_aegis_credit_vault.spec.ts` after `npx hardhat compile`.

Frontend: `aegis-app/src/pages/BankYield`, generated ABI from this contract's artifact, with focused component tests. Component tests mock the wallet hook and do not certify a deployed-wallet end-to-end flow. Full app build/typecheck must be reported separately from these tests.

### Rebuild validation results

| Claim / surface | Evidence | Result |
| --- | --- | --- |
| Contract compilation | `npx hardhat compile` | Exit 0. Compiler warns that inherited synchronous withdrawal bodies are unreachable because async preview overrides revert. |
| Synchronous entry, transferable shares, 30-day pending exits, reported NAV, protected claims, roles | `npx hardhat test test/28_aegis_credit_vault.spec.ts` | Exit 0; 16 public-contract tests pass on local EVM. |
| New constructor deployability | `npx hardhat run scripts/deploy-credit-vault-local.ts` | Exit 0 on configured local chain 1337 after correcting the old script's 31337-only guard. |
| Frontend ABI corresponds to compiled source | Node `assert.deepStrictEqual` between generated artifact ABI and app ABI, five constructor inputs and absence of epoch methods | Exit 0. |
| Frontend component actions and gates | `CI=true yarn test --watchAll=false --runInBand --watchman=false --runTestsByPath src/pages/BankYield/CreditYield.test.tsx` in aegis-app | Exit 0; 12 tests pass. Wallet hook is mocked; live-wallet flow remains unverified. |
| Full frontend production build | `yarn build` in aegis-app | Exit 1: missing `babel-preset-react-app/node_modules/@babel/runtime/helpers/esm/defineProperty.js`, requested by Redux Toolkit. Same blocker as before rebuild. |
| Full frontend typecheck | `npx tsc --noEmit --pretty false` in aegis-app | Exit 2: installed ox/viem declaration syntax is unsupported by the current TypeScript compiler. |

These local rebuild checks do not constitute an independent security audit. Subsequent Sepolia deployment checks are recorded below.


## Previous Sepolia deployment (whitelist enforced)

- Vault: `0x2d701a7B84B75746404eD27662d897bf6C5eA7F6`
- Chain: 11155111
- Transaction: `0x61eabca24dd35bebd3e379951b164858bd061fd3a67757a79a392196ff384a8a`
- USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`
- AegisConfig: `0x1dAe7eBfb0Daa9AEb8a956f38df6f297b9e32B29`
- Counterparty/admin/manager: `0x84fE172c15bb030BAA0dD497D30DD436c6b750E9`
- Cooldown: 2,592,000 seconds (30 days)
- [Verified Etherscan source](https://sepolia.etherscan.io/address/0x2d701a7B84B75746404eD27662d897bf6C5eA7F6#code)

The original epoch deployment record is archived under `deployments/sepolia/archive/`. `AegisCreditVault.json` contains the current deployment; `.validation.json` records asserted live constructor, role, initial accounting, and runtime-bytecode checks. `scripts/check-credit-vault.ts` checks initial empty state, so it is intended for a fresh deployment, not a populated vault. Etherscan-only verification via `scripts/verify-credit-vault.ts` exits 0; Sourcify separately failed with an HTML response.

The development admin is not whitelisted in the shared AegisConfig at validation time. Manager operations are available; deposits require the existing config operator to grant access. The deployment task did not alter the shared whitelist.

The UI now defaults to the Sepolia address through `deployment.sepolia.json`, with explicit testnet labeling and live asset/config/counterparty addresses. `.env.local` is configured identically; environment overrides remain supported. The local app's ethers 5.7.2 and actual ABI successfully read the deployed vault at block 11730654.

Final checks: 23 contract tests and 14 UI component tests pass (exit 0). The UI ABI matches the compiled contract. Full app production build exits 1 on the pre-existing missing Babel runtime helper under `babel-preset-react-app`; no successful production build or live-wallet transaction is claimed.


## Current Sepolia deployment — blacklist-only access

- Vault: `0x40153A568Db1e6D4BAF845eD7C22fd77D65617f3`
- Deployment transaction: `0x4b67d56fc5d4a8a94a54b0783bafefbbe7d23b46545f08549b866ba5f4f421d1`
- Chain: Sepolia (11155111); USDC, AegisConfig, counterparty/admin/manager and 30-day cooldown match the previous deployment.
- [Verified Etherscan source](https://sepolia.etherscan.io/address/0x40153A568Db1e6D4BAF845eD7C22fd77D65617f3#code)

The previous address's deployment, validation and verification records are archived. The current records are under `deployments/sepolia/AegisCreditVault*.json`. Runtime bytecode, roles, accounting and eligibility assertions passed against the deployed contract. The shared config whitelist remains enabled; the development account is not whitelisted but is now eligible in the vault. No shared whitelist was changed.

The app deployment metadata, `.env.local` address, ABI and access wording now point to this blacklist-only version. Live RPC reads through the app's ethers 5.7.2/ABI passed at block 11730864. All 23 contract tests and 14 UI tests pass; the lifecycle test uses investors absent from the whitelist. The previously recorded frontend production-build dependency blocker remains unresolved; component tests and live reads do not constitute a production build.
