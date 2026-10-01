# Amina deployment and validation

Deployment: Sepolia, chain 11155111. Configuration: `config/AegisVault/amina.sepolia.json`. Contract deployment evidence recorded September 28–29, 2026. The single-form UI revision was checked on September 30, 2026.

| Component | Address |
| --- | --- |
| Amina Deposit USDG (`adUSDG`) | `0xfE0ccc9942E98C963Fe6b4e5194EB6e3Baa4cb64` |
| Amina USDG (`ausdg`, staking proxy) | `0x493B44344E17566076E55Bd8498D089C2129118E` |
| Minting | `0x0360D1d760d06C97e5c9E74d45D9d31c25aB4AeB` |
| Config | `0x539e46827c37A3ef11c7cE521CC56B4d59E602e3` |
| Base-token USD oracle | `0x37755eD2403936945D9a26b6CC34F1dae4aC6938` |
| Test USDC reference oracle | `0xCFA67e9Da72af570e7f8344B7738D6BdF698BD20` |
| Base-token OFT adapter | `0xAF12b0Ae5A72D7b8A8eC675f3E76E2Db56143565` |
| Staking OFT adapter | `0xB02FC8fA9fB1cA333c2e8028Ba6Eb6C0B1cDB3Af` |

The existing test administrator/custodian is `0x84fE172c15bb030BAA0dD497D30DD436c6b750E9`. The new deployment has its own config; it does not modify the existing shared config. Rewards and income router remain undeployed. The staking cooldown is 30 days; the instant exit fee is 50 basis points. Remote bridge peers are not configured.

## Executed checks

| Claim | Canonical surface and falsifier | Result |
| --- | --- | --- |
| Generalized contracts compile | `npx hardhat compile`, final source tree | Exit 0. |
| Configurable identities, signed mint/redeem, custody, fee-correct ERC-4626 exits, cooldown, late rewards, signed claims, permits, limits and OFT transport | `npx hardhat test test/aegis-vault/vault.spec.ts test/aegis-vault/oft.spec.ts` | Exit 0; 15 tests. OFT uses real adapter/OFT code with a local endpoint harness. |
| Deployed code, constructor inputs, proxy implementation, roles, prices and component wiring | `npx hardhat run scripts/aegis-vault/check.ts --network sepolia` | Exit 0; assertions against Sepolia. Creation bytecode and arguments compared to compiled artifacts; staking implementation runtime compared exactly. |
| Live mint → stake → custody → immediate exit → funded bank redemption → yield funding, with rewards absent | `VAULT_GAS_PRICE_WEI=auto npx hardhat run scripts/aegis-vault/smoke.ts --network sepolia` | Exit 0; 13 confirmed transactions and balance/status assertions. |
| Frontend production build | `yarn build` in `aegis-app` | Exit 0 against the final app source and deployed addresses. Existing dependency/bundle-size warnings remain. |
| Amina action controls, combined deposit, interrupted-deposit recovery, exits, wallet/chain/eligibility gates and Earn tab | `CI=true yarn test --watchAll=false --runInBand --watchman=false --runTestsByPath src/pages/BankYield/AegisVault.test.tsx src/pages/Yield/CreditYieldTab.test.tsx` in `aegis-app` | Exit 0; 16 tests. Wallet hook is mocked in component tests. |
| Actual frontend ABI/metadata, ethers-v5 live reads and signed HTTP quotes | `node scripts/aegis-vault/check-ui.cjs` | Exit 0; compares app ABIs to artifacts and addresses to deployment record, checks live identities/share value, verifies quote signatures, rejects an untrusted origin and income-order signing. |
| Explorer source verification | `npx hardhat run scripts/aegis-vault/verify.ts --network sepolia` | Exit 0; all 11 entries verified on Etherscan, including proxy implementation, proxy, ProxyAdmin and silo. The script uses the installed upgrades package's exact precompiled proxy artifacts. |
| Legacy infrastructure regression run | Existing deployment/token/minting/redeem/rewards/config/staking/silo/V3 tests | Exit 5: 259 passing, 5 failing in `test/15_aegis_chainlink_oracle_v3.spec.ts`. Four call obsolete `updateYUSDPrice`; one expects an outdated description. `git diff --exit-code` confirms this legacy source/test pair is unchanged. This is not a green full regression suite. |
| Browser visual/live-wallet interaction | Computer-use browser discovery | Unavailable: tool returned “No browser is available”. No browser-wallet end-to-end result is claimed. |

Deployment, transaction hashes, proxy addresses and machine-readable evidence are in `deployments/sepolia/AegisVault.amina*.json`. The live smoke check left **0.9 ausdg** in the administrator's wallet and **0.91 adUSDG** backing the staking vault. This deliberately funded test yield is not a promised return.

## Single Deposit / Withdraw form (September 30)

Canonical frontend: `../aegis-app/src/pages/BankYield`, reached through the Aegis x AMINA Earn tab. This revision hides the synthetic intermediary from the investor flow and composes the existing deployed contracts. No contract deployment or live testnet mutation was required for this revision. The earlier 16-test UI result above applies to the prior UI and is superseded by the following results.

| Claim | Canonical surface and executable falsifier | Verdict |
| --- | --- | --- |
| Production app packages the new form and transaction runner | `yarn build` in `aegis-app`; emitted JS bundles referenced by `build/asset-manifest.json` asserted to contain the new form and flow markers | Verified: exit 0. Dependency and bundle-size warnings remain. Production source maps are disabled, so a first source-map probe found no maps; the asset-manifest/bundle assertion passed instead. |
| Deposit/Withdraw controls, USDC estimates, recovery controls, cooldown/bank status, gates, and Earn integration | `CI=true yarn test --watchAll=false --runInBand --watchman=false --runTestsByPath src/pages/BankYield/AegisVault.test.tsx src/pages/Yield/CreditYieldTab.test.tsx` in `aegis-app` | Exit 0; 26 tests. Component behavior covered with the wallet hook mocked; browser wallet interaction remains provisional. |
| The shipped transaction runner produces the expected on-chain effects | `npx hardhat test test/aegis-vault/ui-flow.spec.ts` in `aegis-contracts`; loads the actual sibling app's `flow.ts` using its ethers-v5 dependency against real local deployments | Verified: exit 0; 14 tests. Includes net receipt amounts with the investor also receiving fees, preserved unrelated balances, confirmation rejection, wallet changes between steps, receipt recovery at mint/stake/exit/claim/request/unlock, quote failure after exit, cooldown continuation, expired/rejected request renewal, funded USDC payout, and failing closed if storage loses a broadcast hash. |
| Changed files meet app lint rules | `./node_modules/.bin/eslint src/pages/BankYield/{flow.ts,useAegisVault.ts,index.tsx,model.ts,AegisVault.test.tsx}` in `aegis-app` | Verified: exit 0 after correcting JSX indentation. |
| App type checking with a compiler supporting the installed dependency declarations | `node ../aegis-contracts/node_modules/typescript/bin/tsc --noEmit --pretty false` in `aegis-app` (TypeScript 5.8.3) | Exit 0. The app's standalone TypeScript 4.9 checker exited 2 because installed `ox`/`viem` declarations use newer syntax. Its configured compiler was not upgraded in this UI change. |
| Browser layout and real connected-wallet clicks | Not exercised for this revision | Provisional; no browser/live-wallet end-to-end result is claimed. |

Source and emitted-bundle hashes, test counts and limitations are recorded in `deployments/sepolia/AegisVault.amina.ui-flow-validation.json`. Local contract tests are deliberately separate from the earlier Sepolia smoke evidence. Browser recovery limitations are described in `README.md`.

## Operational limits

- The local quote service listens on `127.0.0.1:8788`. It is a development process, not an installed operating-system daemon. A hosted app needs `REACT_APP_AEGIS_VAULT_QUOTE_URL` pointing to an authenticated quote service.
- The manual Sepolia price feeds expire after their seven-day heartbeat. Price updates are operator responsibilities. The base-token oracle is not an oracle for the staking share; staking's current exchange rate is read from ERC-4626.
- No live remote-chain transfer was attempted; OFT routes still need remote contracts, peers and security configuration.
- The earlier credit vault is retired from active source/tests/scripts and the app. Its source and tooling remain under `docs/rwa-yield/archive/credit-vault`; historical deployment records remain under `deployments/sepolia/archive`. Existing on-chain credit-vault balances are not migrated by this change.
