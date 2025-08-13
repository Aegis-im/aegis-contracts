# YUSD OFT Contract Verification Guide

## Flattened Contract

The YUSD OFT contract has been successfully flattened and cleaned up for verification purposes.

### Files Created:
- `YUSDOFT-flattened-clean.sol` - The cleaned flattened contract ready for verification

### Contract Details:
- **Contract Name**: YUSDOFT
- **Solidity Version**: ^0.8.20 (compatible with 0.8.26)
- **License**: LZBL-1.2 AND MIT AND UNLICENSED
- **Total Lines**: 4,843 lines (after cleanup)

### Verification Steps:

#### Option 1: Manual Verification via Block Explorer
1. Go to your block explorer (Etherscan, BSCScan, etc.)
2. Navigate to your deployed contract address
3. Click on "Contract" tab
4. Click "Verify and Publish"
5. Select:
   - Compiler Type: Solidity (Single file)
   - Compiler Version: v0.8.26 (or compatible)
   - Open Source License Type: Other (Multiple licenses)
6. Copy and paste the contents of `YUSDOFT-flattened-clean.sol`
7. Add constructor arguments if required
8. Submit for verification

#### Option 2: Using Hardhat Verify
```bash
npx hardhat verify --network <network-name> <contract-address> <constructor-args>
```

### Constructor Arguments:
The YUSDOFT contract constructor takes:
- `_lzEndpoint`: LayerZero endpoint address
- `_delegate`: Delegate address (usually the deployer/owner)

### Notes:
- The flattened contract includes all dependencies from LayerZero OFT, OpenZeppelin contracts, and custom interfaces
- All duplicate pragma statements have been removed and standardized to `^0.8.20`
- The contract maintains all original functionality including blacklist features and LayerZero OFT capabilities

### Cleanup:
After successful verification, you can remove the temporary files:
```bash
rm YUSDOFT-flattened.sol
rm cleanup-flattened.js
``` 