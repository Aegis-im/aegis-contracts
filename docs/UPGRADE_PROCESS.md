# Upgrade Process for Aegis Protocol Contracts

This document describes the upgrade process for upgradeable contracts in the Aegis Protocol.

## Overview

The Aegis Protocol uses **OpenZeppelin's Transparent Proxy Pattern** for upgradeable contracts, specifically for:
- **sYUSD** (Staked YUSD) - [contracts/sYUSD.sol](../contracts/sYUSD.sol)
- **sJUSD** (Staked JUSD) - [contracts/sJUSD.sol](../contracts/sJUSD.sol)

Upgrades are controlled by a **TimelockController** which enforces a time delay before execution, providing governance transparency and safety.

## Architecture

### Proxy Pattern
```
User → TransparentUpgradeableProxy → Implementation Contract (sYUSD/sJUSD)
                ↓
          ProxyAdmin (owned by Multisig)
```

**Current Setup**:
- ProxyAdmin is directly owned by the **Multisig** wallet
- No TimelockController is deployed
- Upgrades are executed immediately by the Multisig

**Future Enhancement**:
- A TimelockController can be deployed and set as the ProxyAdmin owner
- This would add a time delay before upgrades execute, providing more transparency

### Key Roles

#### ProxyAdmin
- **Owner**: Multisig wallet `0x4Fe78eF65BD8EDDED480efaB030BA680646503c8`
- Can call `upgrade(proxy, implementation)` to upgrade contracts
- Can call `changeProxyAdmin(proxy, newAdmin)` to transfer ownership

#### Proxy Contract Roles
- **ADMIN_ROLE**: Can modify contract parameters (fee, cooldown, insurance fund)
- **DEFAULT_ADMIN_ROLE**: Can grant/revoke roles and perform emergency rescues

## Upgrade Process Steps

### 1. Prepare the New Implementation

Deploy and validate the new implementation contract using Hardhat's upgrades plugin:

```javascript
const { ethers, upgrades } = require('hardhat');

// Get the contract factory for the new implementation
const sYUSD = await ethers.getContractFactory('sYUSD');

// Prepare the upgrade (validates storage layout and deploys new implementation)
const newImplementationAddress = await upgrades.prepareUpgrade(
  proxyAddress,
  sYUSD,
  {
    kind: 'transparent',
    unsafeAllow: ['constructor', 'delegatecall']
  }
);

console.log('New implementation deployed at:', newImplementationAddress);
```

**Storage Layout Validation**: The `prepareUpgrade` function automatically validates that the new implementation is upgrade-safe and maintains storage layout compatibility.

### 2. Execute the Upgrade via Multisig

Since the ProxyAdmin is owned by the Multisig, the upgrade is executed directly:

```javascript
const { ethers, upgrades } = require('hardhat');

// Connect as multisig or via Gnosis Safe transaction builder
const sYUSD = await ethers.getContractFactory('sYUSD');

// Perform the upgrade (requires multisig signatures)
await upgrades.upgradeProxy(proxyAddress, sYUSD, {
  kind: 'transparent',
  unsafeAllow: ['constructor', 'delegatecall']
});

console.log('Upgrade completed successfully');
```

**Using Gnosis Safe UI**:
1. Go to Gnosis Safe web interface
2. Create a new transaction
3. Set contract address to `ProxyAdmin` address
4. Call `upgrade(address proxy, address implementation)`
5. Parameters:
   - `proxy`: Address of sYUSD/sJUSD proxy
   - `implementation`: Address from step 1
6. Submit and collect required signatures
7. Execute transaction

**Environment Variables Required**:
- `PROXY_ADDRESS`: Address of the sYUSD/sJUSD proxy contract

**Run Command**:
```bash
PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-sYUSD.js --network mainnet
```

**Alternative Script with Initialization**:
```bash
PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-sYUSD-with-init.js --network mainnet
```

### 3. Verify the Upgrade

After execution:

1. **Verify Implementation Address**:
```javascript
const newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
console.log('New implementation:', newImpl);
```

2. **Test New Functionality**: Call new/modified functions to verify behavior

3. **Run Post-Upgrade Initialization** (if needed):
```javascript
const proxy = await ethers.getContractAt('sYUSD', proxyAddress);
await proxy.initializeV2(initialFee, initialInsuranceFund);
```

## Safety Checks

### Before Deploying New Implementation

1. **Validate Storage Layout**: The `prepareUpgrade` function automatically validates storage compatibility
   ```javascript
   // This will revert if storage layout is incompatible
   await upgrades.prepareUpgrade(proxyAddress, NewImplementation, {
     kind: 'transparent'
   });
   ```

2. **Check ProxyAdmin Owner**:
   ```javascript
   const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
   const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddress);
   const owner = await proxyAdmin.owner();

   console.log('ProxyAdmin owner:', owner);
   // Should be: 0x4Fe78eF65BD8EDDED480efaB030BA680646503c8 (Multisig)
   ```

3. **Verify Multisig Signers**: Ensure sufficient signers are available for the upgrade

### Before Executing Upgrade

1. **Test on Testnet First**: Always test the full upgrade process on a testnet before mainnet

2. **Review Implementation Code**: Conduct thorough code review and audit if needed

3. **Prepare Rollback Plan**: Document how to revert to previous implementation if needed

4. **Check Current State**: Verify proxy is functioning correctly before upgrade
   ```javascript
   const proxy = await ethers.getContractAt('sYUSD', proxyAddress);
   const currentImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
   console.log('Current implementation:', currentImpl);
   ```

5. **Backup Critical Data**: Take snapshots of important on-chain state

## Emergency Procedures

### Revert to Previous Implementation

If issues are discovered after upgrade, the Multisig can revert to the previous implementation:

```javascript
const { ethers, upgrades } = require('hardhat');

// Get the previous implementation address (from deployment records)
const previousImplementationAddress = '0x...';

// Get ProxyAdmin
const proxyAdminAddress = await upgrades.erc1967.getAdminAddress(proxyAddress);
const proxyAdmin = await ethers.getContractAt('ProxyAdmin', proxyAdminAddress);

// Revert to previous implementation
await proxyAdmin.upgrade(proxyAddress, previousImplementationAddress);
```

⚠️ **Important**: This only works if storage layout is still compatible

### Pause Operations During Upgrade

If the contract has pause functionality, consider pausing before upgrade:

```javascript
const proxy = await ethers.getContractAt('sYUSD', proxyAddress);

// Check roles before pausing
const ADMIN_ROLE = await proxy.ADMIN_ROLE();
const hasAdminRole = await proxy.hasRole(ADMIN_ROLE, multisigAddress);

// Pause if needed (implementation specific)
// Note: sYUSD/sJUSD don't have pause, but this is for reference
```

## Additional Scripts

### Deploy Upgradeable Contract
- **sYUSD**: [scripts/deploy-sYUSD-upgradeable.js](../scripts/deploy-sYUSD-upgradeable.js)
- **sJUSD**: [scripts/jusd/deploy-sJUSD-upgradeable.js](../scripts/jusd/deploy-sJUSD-upgradeable.js)

### Upgrade with Initialization
- [scripts/upgrade-sYUSD-with-init.js](../scripts/upgrade-sYUSD-with-init.js)

### Testing Upgrades Locally
- [scripts/deploy-and-upgrade.js](../scripts/deploy-and-upgrade.js)

## References

- OpenZeppelin Upgrades Plugins: https://docs.openzeppelin.com/upgrades-plugins
- TimelockController: https://docs.openzeppelin.com/contracts/api/governance#TimelockController
- Transparent Proxy Pattern: https://docs.openzeppelin.com/contracts/api/proxy#TransparentUpgradeableProxy
- Writing Upgradeable Contracts: https://docs.openzeppelin.com/upgrades-plugins/writing-upgradeable

## Wallet Addresses

Based on [owners.csv](../owners.csv):

- **Multisig**: `0x4Fe78eF65BD8EDDED480efaB030BA680646503c8`
  - Has DEFAULT_ADMIN_ROLE, ADMIN_ROLE on proxies
  - Has PROPOSER_ROLE, EXECUTOR_ROLE on TimelockController

- **Alex Maslennikov**: `0x32Bd61608702AA0dCc7C205404B05CEa2221b3ce`, `0x0b241d2f1a060feae6968f7ced3221d4ab29d865`
  - Operational roles (FUNDS_MANAGER_ROLE, COLLATERAL_MANAGER_ROLE)
  - Should NOT have upgrade permissions

- **Server Trusted Signer**: `0x4a09579f3f07C474436eCbe6c4D4fF4111795650`
  - For price oracle updates, signature verification
  - Should NOT have upgrade permissions
