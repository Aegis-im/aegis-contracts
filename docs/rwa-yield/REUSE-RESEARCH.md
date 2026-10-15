> Historical credit-vault prototype. Superseded by [AegisVault](../AegisVault/README.md). Source, tests and scripts are preserved under `archive/credit-vault/`; deployed contracts are not upgraded or migrated.

**Aegis bank-loan yield product — reuse research**

Research date: 14 September 2026. Scope: a new USDC product, independent of YUSD/JUSD, sharing only AegisConfig whitelist eligibility. This is a source, licensing and audit-evidence assessment, not a contract security audit or an approved implementation design.

**Decision**

No candidate was verified as a drop-in match for unrestricted production reuse, relevant public audit coverage, a single bank borrower, monthly yield treatment, and an enforced monthly asynchronous withdrawal schedule.

There are usable foundations. Goldfinch is the strongest MIT-licensed credit-system candidate found with publicly inspectable audit evidence relevant to epoch withdrawals. Centrifuge's older Liquidity Pools implementation supplies audited ERC-7540 machinery under open copyleft licenses, but requires substantially more infrastructure. Pareto/Idle credit vaults are a closer product match, but the relevant contracts are marked UNLICENSED. Lagoon is a credible managed-vault alternative with a BUSL licensing constraint. Maestro is MIT and comparatively small, but its audit report is not public and its queue has no monthly enforcement.

Recommendation: do not start by forking a whole lending protocol. If independent deployment under an open license is a firm requirement, compare a narrowly scoped custom vault with adaptation of Goldfinch's epoch-withdrawal approach. If commercial reuse rights or a hosted protocol are acceptable, prioritize Pareto/Idle and Accountable for a concrete release/license/integration proposal. An upstream audit does not cover Aegis-specific modifications.

**Product interpretation used for the comparison**

- USDC is the deposit and redemption asset. No YUSD/JUSD minting, collateral, rewards or shared asset accounting.
- Investors may request redemption before a cutoff; eligible requests settle together monthly, after principal liquidity arrives; funded claims remain available afterward. A monthly claim-only window is a separate, unresolved requirement.
- Monthly bank interest receipt does not settle the choice between share-price appreciation and separate USDC coupons. Both remain possible; most vault candidates naturally fit share-price appreciation. A separate coupon layer needs its own entitlement accounting.
- Deployment chain is unspecified. Sharing the existing AegisConfig directly assumes deployment on the same chain as the chosen config instance.

These interpretations are provisional; no product choice was inferred from the lack of a clarification response.

**What the reference actually is**

The [supplied Accountable page](https://yield.accountable.capital/vaults/143/0x77410132Fd468d67B820314d378bE1fDbfA2bAa4) is K3 × Galaxy Lending on Monad. Accountable's [public API response for the address](https://yield.accountable.capital/api/loan/address/0x77410132Fd468d67B820314d378bE1fDbfA2bAa4), fetched directly because the web renderer returned an empty page, identifies AUSD as the underlying asset and gAUSD as the share token. The address in the URL is the strategy; the vault/share address returned by the API is `0x0143C3eF3a76Ed825Fd5201953f65b52aCEfD799`.

The issuer's description says the loans have 90-day maturities and monthly LP liquidity through maturity laddering. The API reports an interest interval of 2,592,000 seconds (30 days), implementation label EARLY_EXIT, and strategy version 2. These are application/API observations, not independently verified RPC state or proof of audit coverage. They do not establish that the deployed code enforces a particular calendar-month settlement policy.

Accountable documents an [asynchronous redeem vault](https://docs.accountable.capital/accountable-documentation/vault-as-a-service/accountable-asynchronous-vault) and a [withdrawal queue](https://docs.accountable.capital/accountable-documentation/vault-as-a-service/accountable-withdrawal-queue) with partial processing and reserved liquidity. Its [audit index](https://docs.accountable.capital/accountable-documentation/vault-as-a-service/audits) lists protocol v1 reports, a Cyfrin re-audit, and NAV-related reports. I did not establish a public production-reuse license, nor map those reports to this EARLY_EXIT v2 deployment. Accountable qualifies for a provider discussion, not yet as a freely reusable audited codebase.

**Candidate comparison**

| Candidate | License evidence | Audit evidence | Monthly product fit | Assessment |
| --- | --- | --- | --- | --- |
| Goldfinch | MIT repository and inspected SeniorPool source | Public Spearbit report includes SeniorPool epoch-withdrawal work | Configurable epoch duration, requests, partial liquidity allocation and later claims; credit system supports borrower repayment accounting | Strongest confirmed permissive foundation, but substantial adaptation |
| Centrifuge Liquidity Pools, older generation | ERC7540Vault is AGPL-3.0-only; root LICENSE is LGPL-3.0, so exact release/file licensing needs reconciliation | Public Code4rena, SRLabs, Cantina and Spearbit reports | Async requests and restricted shares; monthly schedule and single-bank settlement must be supplied by surrounding system | Open-license technical reference, heavy standalone deployment |
| Pareto/Idle credit vaults | Core epoch vault, credit strategy and queue are UNLICENSED | Idle publishes credit-vault and queue reviews by Hans Friese | Explicit epochs, borrower funding/repayment and queued operations; default epoch is 30 days | Closest product candidate if reuse rights are obtained |
| Lagoon | BUSL-1.1; production use not established under public grant | Public versioned reports, including v0.6.0 in 2026 | Async settlement and reported NAV; monthly operation possible, calendar enforcement needs additional policy | Strong licensed/provider option |
| Maestro | MIT | Maintainer says audited; report available by contacting them | Managed capital, P&L reports, FIFO redemption queue; anyone can process when liquidity exists | Conditional small-code candidate; cannot call audit verified |
| Maple V2 | BUSL in inspected cyclical withdrawal-manager license | Core repository publishes reports | Dedicated cyclical and FIFO withdrawal managers; institutional loan stack | Relevant mechanics, not a confirmed open-license fit |
| TrueFi Fluorine | BUSL-1.1 in StructuredAssetVault; stated change to MIT | Public ChainSecurity report in repository | Managed asset vault framework; monthly specialization still needs assessment | Does not clear open-license requirement for current use |
| Wildcat V2 | Apache-2.0 **with Commons Clause** | Public Code4rena V2 report | Uncollateralized credit with withdrawal batches; monthly semantics not established here | Not unrestricted commercial reuse |

Licenses above describe inspected sources, not a legal clearance for every dependency, historical release or deployment. BUSL licenses can convert after a version-specific period; inspect the exact version and applicable grants rather than assuming either a permanent restriction or an already effective conversion.

**Goldfinch: what is genuinely reusable**

The [MIT license](https://github.com/goldfinch-eng/mono/blob/main/LICENSE) and [SeniorPool.sol](https://github.com/goldfinch-eng/mono/blob/main/packages/protocol/contracts/protocol/core/SeniorPool.sol) were inspected. The source provides `requestWithdrawal`, `claimWithdrawalRequest`, epoch checkpoints and `setEpochDuration`. Claims use a withdrawal-request NFT and the protocol's Go eligibility checks. When an epoch ends, available USDC can settle only part of requested capital; zero available liquidity can extend the epoch. The default duration is two weeks, configurable in seconds. This is not a calendar/business-day scheduler.

The [Spearbit report dated 3 February 2023](https://github.com/goldfinch-eng/goldfinch-contracts/blob/main/v3.0.0/GoldfinchRetainer.pdf) explicitly includes SeniorPool, WithdrawalRequestToken and ISeniorPoolEpochWithdrawals in its October–November scope at commit `7ea8714a`, with a coverage caveat. Its later section covers Schedule and MonthlyPeriodMapper at `b17551fe`. The report also discusses configurable fee and epoch administration risks. This is relevant evidence, not proof that today's source or a modified Aegis release is fully covered.

Engineering assessment: adapting the SeniorPool introduces its config, FIDU, request-token, eligibility and borrower-pool dependencies. Its privileged zapper withdrawal route must also be evaluated against strict monthly-only settlement. Replacing these with Aegis equivalents and reducing the system to one borrower is meaningful contract work. [Callable deals](https://docs.goldfinch.finance/goldfinch/goldfinch-v1/guides/participating-in-callable-deals) are another reference, but the documented initial model uses quarterly call periods and two months' notice; that is not the requested monthly revolving vault.

**Centrifuge: distinguish old open-license code from current BUSL code**

The older [Liquidity Pools repository](https://github.com/centrifuge/liquidity-pools) implements ERC-7540 vaults plus InvestmentManager, PoolManager, escrow, restricted tranche tokens, gateway and messaging adapters. The vault itself delegates fulfillment/accounting; copying its public entry points does not supply a standalone bank settlement engine. The root license and source SPDX labels differ, as noted above. See the [exact vault source](https://github.com/centrifuge/liquidity-pools/blob/e556c1a7a0ec7f6d700b47841eb586f5f4801406/src/ERC7540Vault.sol) and [root license](https://github.com/centrifuge/liquidity-pools/blob/e556c1a7a0ec7f6d700b47841eb586f5f4801406/LICENSE).

The [6 August 2024 Spearbit report](https://github.com/centrifuge/liquidity-pools/blob/main/audits/2024-08-Spearbit.pdf) names baseline `be582c7c` and remediation review `7b367a604bcf3bf7de5afb1bcfd956f922669779`. It records critical/high findings as fixed, with some lower-severity observations acknowledged. The inspected repository head differs from that audited revision.

The [current Centrifuge protocol license](https://github.com/centrifuge/protocol/blob/main/LICENSE) is BUSL-1.1. Do not carry the old repository's licensing conclusion over to current AsyncVault. Engineering assessment: prefer an established Centrifuge deployment if choosing the platform; rebuilding its surrounding infrastructure for a single-bank vault weakens the benefit of reuse.

**Closer fits whose conditions matter**

Pareto/Idle's [IdleCDOEpochVariant](https://github.com/Idle-Labs/idle-tranches/blob/19e7cde8d43ab7ee32fa7bf011920834d3986153/contracts/IdleCDOEpochVariant.sol) has a 30-day default, start/stop epoch operations, borrower fund transfers, withdrawal requests and claims, and configurable early-withdrawal behavior. Eligibility is delegated to `checkCredential(policyId, user)`, suggesting a small adapter to AegisConfig is possible. This inference still needs release-specific implementation validation. The [epoch queue](https://github.com/Idle-Labs/idle-tranches/blob/19e7cde8d43ab7ee32fa7bf011920834d3986153/contracts/IdleCDOEpochQueue.sol) and core strategy also carry UNLICENSED headers; this is not the public-domain Unlicense. The [audit index](https://docs.idle.finance/developers/security/audits) lists credit-vault reviews in August/October 2024 and deposit/withdrawal queue reviews in October/November. Exact reviewed revisions and subsequent changes remain to be checked.

Lagoon has a [BUSL license](https://github.com/hopperlabsxyz/lagoon-v0/blob/main/LICENSE) and a [versioned audit index](https://docs.lagoon.finance/resources/audits) listing Nethermind and Trail of Bits material. In inspected [v0.6.0 settlement entry points](https://github.com/hopperlabsxyz/lagoon-v0/blob/a8e73f5a5276aa4047b901083cbce127d7f7b470/src/v0.6.0/vault/Vault-v0.6.0.sol), the Safe supplies valuation and settles. `settleDeposit` can also settle redemptions; gating only `settleRedeem` would be insufficient. Optional synchronous routes also need examination. A monthly operator procedure is not the same as an enforced monthly-only contract policy.

Maestro's [MIT contracts](https://github.com/maestro-org/maestro-vault-contracts) track idle plus deployed assets and permit custodian P&L reporting. Its [security policy](https://github.com/maestro-org/maestro-vault-contracts/blob/main/SECURITY.md) provides no public audit report. The [queue source](https://github.com/maestro-org/maestro-vault-contracts/blob/0b2edcb404b55a7ad0dba5b102b0e8d8541ec64e/yield-vault/contracts/WithdrawalManager.sol) allows permissionless processing whenever liquidity exists and pushes assets directly to users. It requires monthly gating, live AegisConfig eligibility integration and possibly a pull-claim flow. It should not be described as ERC-7540 merely because it has a method called `requestRedeem`.

Other licensing evidence: [Maple cyclical withdrawal manager](https://github.com/maple-labs/withdrawal-manager-cyclical/blob/main/LICENSE), [Maple audits](https://github.com/maple-labs/maple-core-v2/tree/main/audits), [TrueFi StructuredAssetVault](https://github.com/TrueFi-Protocol/contracts-fluorine/blob/092ffb57f9761faf0a6e4e9c13f386c5b839c58c/contracts/StructuredAssetVault.sol), [TrueFi audit](https://github.com/TrueFi-Protocol/contracts-fluorine/tree/main/audits), [Wildcat license](https://github.com/wildcat-finance/v2-protocol/blob/main/LICENSE.md) and [Wildcat V2 audit](https://code4rena.com/reports/2024-08-wildcat). Clearpool also publishes [credit-vault audit references](https://docs.clearpool.finance/clearpool/security/smart-contracts), but a suitable licensed source release was not established in this pass.

**AegisConfig compatibility**

Local [AegisConfig.sol](../../contracts/AegisConfig.sol) exposes `isWhitelisted(address)`. The new product can query it through a minimal interface without using any stablecoin accounting. The unused IYUSD import does not itself create runtime token coupling.

Important existing behavior: `isWhitelisted` returns true for everyone when the owner disables the global whitelist. The underlying membership mapping is private. If this bank product must remain permissioned, a local adapter can require `whitelistEnabled()` as well as `isWhitelisted(user)`; when the switch is off, that would stop gated actions rather than recover raw membership. The current IAegisConfig interface does not declare the boolean getter, although the contract exposes it.

Eligibility should be specified for depositor, share receiver, owner/controller, delegated operators and payout receiver. Share transfers must not bypass the intended ownership restriction. De-whitelisting while a withdrawal is pending needs an explicit exit/recovery policy. Reusing the whitelist does not automatically mean reusing trustedSigner, operators, vault management, upgrade control or bank-payment authority.

**Requirements that decide whether reuse is worthwhile**

1. **Principal liquidity:** monthly interest alone cannot pay principal redemptions. Agree a bank principal-recall obligation, notice period and settlement amount, or fund a reserve/maturity ladder. This is the critical missing economic input.
2. **Distribution:** choose monthly share-value updates or separate cash coupons. For NAV-style shares, do not admit deposits at a stale price immediately before recognizing the previous month's return: new money would share income earned before it arrived. Async subscriptions settled at a fair NAV, restricted subscription windows, or validated accrual accounting are alternatives.
3. **Calendar:** choose fixed 30-day epochs or actual calendar/business dates, timezone, notice cutoff and late-payment handling. None are interchangeable by changing a label in the UI.
4. **Withdrawal accounting:** decide when price fixes, whether pending shares earn yield, how shortfalls are allocated, whether unfilled requests roll, and whether cancellation is allowed. Reserve claimable USDC so it cannot be lent out again.
5. **Bank receivable:** sending USDC out must create/maintain an accounted receivable rather than appear as a total loss. Repayment must not count principal as profit. Define who attests value and records impairment; a token transfer cannot prove off-chain loan performance.

[ERC-7540](https://eips.ethereum.org/EIPS/eip-7540) is the appropriate interface family to evaluate for request → pending → claimable → claim. It permits async redemption with either synchronous or asynchronous deposits. It does not supply a bank strategy, monthly calendar or valuation policy. It requires pull claims rather than pushing payout automatically, and same-ID requests have shared settlement/pro-rata requirements. A product can choose another interface, but should label it accurately.

**Recommended next step**

Close the principal-recall and yield-distribution decisions before implementation. Then perform one concrete comparison: the exact licensed Pareto/Idle or Accountable release, if available, versus a small independent USDC vault using standard audited primitives and a dedicated monthly settlement controller. If open licensing is non-negotiable, retain Goldfinch and older Centrifuge as source references, but budget for a fresh review of every adapted path.

A proof of concept should exercise deposits around valuation changes, cutoff boundaries, two monthly settlements, partial repayment/default, claim reserves, de-whitelisting and all bypass routes. No contracts were implemented, no candidate test suites were run, and no deployment or audit-to-bytecode equivalence was established during this research.

**Source snapshots inspected**

| Repository | Inspected HEAD (not an audited-release claim) |
| --- | --- |
| Idle-Labs/idle-tranches | `19e7cde8d43ab7ee32fa7bf011920834d3986153` |
| hopperlabsxyz/lagoon-v0 | `a8e73f5a5276aa4047b901083cbce127d7f7b470` |
| centrifuge/liquidity-pools | `e556c1a7a0ec7f6d700b47841eb586f5f4801406` |
| maestro-org/maestro-vault-contracts | `0b2edcb404b55a7ad0dba5b102b0e8d8541ec64e` |
| TrueFi-Protocol/contracts-fluorine | `092ffb57f9761faf0a6e4e9c13f386c5b839c58c` |
| goldfinch-eng/goldfinch-contracts (audit archive) | `162ea40e526911a5955284f76c454f655645ec30` |

Goldfinch current SeniorPool/CallableLoan sources were separately read from `goldfinch-eng/mono/main`; their relationship to the archived audit baselines has not been established.
