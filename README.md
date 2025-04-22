# Aegis Protocol Smart Contracts

This repository contains smart contracts for the Aegis protocol.

## Prerequisites

Before running tests, ensure you have the following installed:

- [Node.js](https://nodejs.org/) (v16 or higher)
- [Yarn](https://yarnpkg.com/) or [npm](https://www.npmjs.com/)
- [Git](https://git-scm.com/)

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/your-repo/aegis-contracts.git
   cd aegis-contracts
   ```

2. Install dependencies:
   ```bash
   yarn install
   ```

3. Create a `.env` file based on the example (if not already present):
   ```bash
   cp .env.example .env
   ```

## Running Tests

### Run All Tests

To run all tests in the test suite:

```bash
yarn test
```

### Run Specific Test Files for sYUSD

To run specific test files, use the following command:

```bash
npx hardhat test test/StYUSD.test.js
```

### Run Tests with Coverage

To generate a test coverage report:

```bash
npx hardhat coverage
```

The coverage report will be available in the `coverage/` directory.

## Troubleshooting Common Errors

### Ethers v6 Compatibility Issues

If you encounter errors related to ethers API changes like:

```
TypeError: Cannot read properties of undefined (reading 'AddressZero')
```

This is due to the ethers library upgrade from v5 to v6. The API has changed in several ways:

1. `ethers.constants.AddressZero` → `ethers.ZeroAddress`
2. `ethers.utils.parseEther()` → `ethers.parseEther()`
3. `ethers.constants.MaxUint256` → `ethers.MaxUint256`
4. `ethers.utils.keccak256()` → `ethers.keccak256()`
5. `ethers.utils.toUtf8Bytes()` → `ethers.toUtf8Bytes()`

Also, contract deployment and interaction patterns have changed:
- `contract.deployed()` → `contract.waitForDeployment()`
- `contract.address` → `await contract.getAddress()`

To fix these issues in test files:
- Search for any usage of the old API
- Replace with the corresponding new API methods
- For JavaScript files, no type changes are needed
- For TypeScript files, you may need to update type imports as well

### Contract Interface Changes

If tests are failing with errors like:

```
TypeError: sYusd.connect(...).stake is not a function
```

This indicates that the contract interface has changed. The current contract implementation might not include certain functions that the tests are trying to call. To fix:

1. Review the current contract implementation in `contracts/sYUSD.sol`
2. Update tests to use the functions that exist in the contract
3. For ERC4626 implementations, use standard functions like:
   - Use `deposit()` instead of custom `stake()`
   - Use `withdraw()` instead of custom `unstake()`
   - Use `previewDeposit()` or `convertToShares()` for exchange calculations

## Available Test Files

The test directory contains the following test files:

- `1_deploy_contracts.spec.ts` - Tests for contract deployments
- `2_yusd.spec.ts` - Tests for the YUSD token functionality
- `3_aegis_minting_admin.spec.ts` - Tests for AegisMinting admin functions
- `4_aegis_minting.spec.ts` - Tests for AegisMinting core functionality
- `5_aegis_minting_mint.spec.ts` - Tests for AegisMinting mint operations
- `6_aegis_minting_redeem.spec.ts` - Tests for AegisMinting redeem operations
- `7_aegis_rewards.spec.ts` - Tests for the AegisRewards contract
- `8_aegis_oracle.spec.ts` - Tests for the AegisOracle contract
- `9_aegis_config.spec.ts` - Tests for the AegisConfig contract
- `StYUSD.test.js` - Tests for the sYUSD (Staked YUSD) token

## Troubleshooting

If you encounter issues running tests:

1. Make sure your Node.js version is compatible (v16+)
2. Try deleting `node_modules`, `cache`, and `artifacts` directories and reinstalling dependencies
3. Verify that your `.env` file contains the necessary values
4. Check the Solidity compiler version in `hardhat.config.ts` matches the pragma in your contracts

## Linting and Formatting

To check for linting errors:

```bash
npx eslint .
```

To format your code:

```bash
npx prettier --write "**/*.{js,ts,sol}"
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
