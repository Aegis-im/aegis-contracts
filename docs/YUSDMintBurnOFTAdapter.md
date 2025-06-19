# YUSDMintBurnOFTAdapter Documentation

## Overview

`YUSDMintBurnOFTAdapter` is a LayerZero MintBurn OFT Adapter that enables cross-chain functionality for existing YUSD tokens. It directly interfaces with YUSD's built-in mint/burn functions to provide seamless token transfers across different blockchain networks.

## Architecture

```
┌─────────────────────────┐    ┌────────────────────────────────┐
│   YUSD Token            │◄───│ YUSDMintBurnOFTAdapter         │
│   (Existing)            │    │                                │
│   - mint()              │    │ - Implements IMintableBurnable │
│   - burnFrom()          │    │ - LayerZero Integration        │
│   - minter role         │    │ - Self-referencing design      │
└─────────────────────────┘    └────────────────────────────────┘
         │                                   │
         │                                   │
         ▼                                   ▼
┌─────────────────────────┐    ┌────────────────────────────────┐
│ Built-in Mint/Burn      │    │ Cross-Chain Message            │
│ Functions               │    │ Handling                       │
└─────────────────────────┘    └────────────────────────────────┘
```

## Contract Details

### Inheritance
- `MintBurnOFTAdapter` - LayerZero's base adapter for mint/burn operations
- `IMintableBurnable` - Interface for mint/burn functionality
- `Ownable` - Access control for administrative functions

### Key Components

#### 1. Interface Definition
```solidity
interface IYUSD {
    function mint(address account, uint256 value) external;
    function burnFrom(address account, uint256 value) external;
}
```

#### 2. State Variables
```solidity
IYUSD public immutable yusdToken;  // Reference to the YUSD token contract
```

#### 3. Events
```solidity
event YUSDCrossChainTransfer(
    address indexed from,
    address indexed to,
    uint256 amount,
    uint32 chainId
);
```

#### 4. Custom Errors
```solidity
error UnauthorizedCaller();
```

## Constructor

```solidity
constructor(
    address _yusdToken,
    address _lzEndpoint,
    address _owner
)
```

### Parameters
- `_yusdToken` - Address of the existing YUSD token contract
- `_lzEndpoint` - Address of the LayerZero endpoint for the current network
- `_owner` - Address that will own the adapter contract

### Implementation Details
```solidity
MintBurnOFTAdapter(_yusdToken, IMintableBurnable(address(this)), _lzEndpoint, _owner)
```

The constructor uses `address(this)` as the minter/burner, creating a self-referencing design where the adapter itself implements the `IMintableBurnable` interface.

## Security Features

### onlySelf Modifier
```solidity
modifier onlySelf() {
    if (msg.sender != address(this)) {
        revert UnauthorizedCaller();
    }
    _;
}
```

**Purpose**: Ensures that only the adapter contract itself can call the `mint()` and `burn()` functions.

**Security Guarantee**: Prevents external actors from directly calling mint/burn functions while allowing LayerZero's internal flow to work correctly.

## Core Functions

### 1. burn()
```solidity
function burn(address _from, uint256 _amount) external override onlySelf returns (bool)
```

**Purpose**: Burns tokens from a user's balance during cross-chain sending.

**Flow**:
1. Called internally by LayerZero's `_debit()` flow
2. `onlySelf` modifier ensures only the adapter can call this
3. Calls `yusdToken.burnFrom(_from, _amount)` to burn tokens
4. Returns `true` on success

### 2. mint()
```solidity
function mint(address _to, uint256 _amount) external override onlySelf returns (bool)
```

**Purpose**: Mints tokens to a recipient during cross-chain receiving.

**Flow**:
1. Called internally by LayerZero's `_credit()` flow
2. `onlySelf` modifier ensures only the adapter can call this
3. Calls `yusdToken.mint(_to, _amount)` to mint tokens
4. Returns `true` on success

### 3. _debit() - Override
```solidity
function _debit(
    address _from,
    uint256 _amountLD,
    uint256 _minAmountLD,
    uint32 _dstEid
) internal override returns (uint256 amountSentLD, uint256 amountReceivedLD)
```

**Purpose**: Handles token burning when sending cross-chain transfers.

**Implementation**:
1. Calls `super._debit()` to execute the base burn logic
2. Emits `YUSDCrossChainTransfer` event for tracking
3. Returns the amounts sent and received

### 4. _credit() - Override
```solidity
function _credit(
    address _to,
    uint256 _amountLD,
    uint32 _srcEid
) internal override returns (uint256 amountReceivedLD)
```

**Purpose**: Handles token minting when receiving cross-chain transfers.

**Implementation**:
1. Calls `super._credit()` to execute the base mint logic
2. Emits `YUSDCrossChainTransfer` event for tracking
3. Returns the amount received

## Cross-Chain Transfer Flow

### Sending Tokens (Source Chain)
```
1. User approves YUSDMintBurnOFTAdapter to spend tokens
2. User calls adapter.send() with transfer parameters
3. LayerZero calls _debit() internally
4. _debit() calls super._debit()
5. super._debit() calls this.burn()
6. onlySelf modifier passes (msg.sender == address(this))
7. yusdToken.burnFrom() burns user's tokens
8. LayerZero sends cross-chain message
9. YUSDCrossChainTransfer event emitted
```

### Receiving Tokens (Destination Chain)
```
1. LayerZero receives cross-chain message
2. LayerZero calls _credit() internally
3. _credit() calls super._credit()
4. super._credit() calls this.mint()
5. onlySelf modifier passes (msg.sender == address(this))
6. yusdToken.mint() mints tokens to recipient
7. YUSDCrossChainTransfer event emitted
```

## Deployment Process

### 1. Deploy Adapter
```javascript
const adapter = await YUSDMintBurnOFTAdapter.deploy(
    yusdTokenAddress,     // Existing YUSD token
    lzEndpointAddress,    // LayerZero endpoint
    ownerAddress          // Contract owner
)
```

### 2. Set Permissions
```javascript
// Set adapter as minter in YUSD token
await yusdToken.setMinter(adapterAddress)
```

### 3. Configure Peers
```javascript
// Set peer connections between chains
await adapter.setPeer(
    destinationEid,
    ethers.zeroPadValue(destinationAdapterAddress, 32)
)
```

## Usage Examples

### Basic Cross-Chain Transfer
```javascript
// 1. Approve tokens
await yusd.approve(adapterAddress, amount)

// 2. Prepare send parameters
const sendParam = {
    dstEid: destinationChainId,
    to: ethers.zeroPadValue(recipientAddress, 32),
    amountLD: amount,
    minAmountLD: amount,
    extraOptions: '0x',
    composeMsg: '0x',
    oftCmd: '0x'
}

// 3. Get fee quote
const msgFee = await adapter.quoteSend(sendParam, false)

// 4. Execute transfer
await adapter.send(
    sendParam,
    msgFee,
    senderAddress,
    { value: msgFee.nativeFee }
)
```

### Event Monitoring
```javascript
// Monitor cross-chain transfers
adapter.on('YUSDCrossChainTransfer', (from, to, amount, chainId) => {
    if (from === ethers.ZeroAddress) {
        console.log(`Received ${amount} YUSD from chain ${chainId}`)
    } else {
        console.log(`Sent ${amount} YUSD to chain ${chainId}`)
    }
})
```

## Security Considerations

### 1. Minter Role Protection
- Only the adapter should be set as minter in YUSD token
- Ensures only cross-chain operations can mint tokens

### 2. Self-Reference Security
- `onlySelf` modifier prevents external mint/burn calls
- Only LayerZero's internal flow can trigger mint/burn

### 3. YUSD Token Security
- Preserves YUSD's existing blacklist functionality
- Maintains YUSD's access control mechanisms

### 4. LayerZero Security
- Inherits LayerZero's cross-chain message verification
- Benefits from LayerZero's DVN (Decentralized Verifier Network) security

## Error Handling

### Custom Errors
- `UnauthorizedCaller()` - Thrown when non-adapter address tries to call mint/burn

### Common Issues
1. **Permission denied**: Adapter not set as minter in YUSD
2. **Peer not configured**: Missing peer connections between chains
3. **Insufficient allowance**: User hasn't approved adapter to spend tokens
4. **Insufficient gas**: Not enough native tokens for LayerZero fees

## Gas Optimization

### Efficient Design
- Direct YUSD integration (no intermediate contracts)
- Custom errors instead of string messages
- Minimal state variables (only immutable YUSD reference)

### Gas Costs
- **Deployment**: ~2.5M gas (single contract)
- **Cross-chain send**: ~150-200k gas + LayerZero fees
- **Cross-chain receive**: ~100-150k gas

## Integration Requirements

### YUSD Token Requirements
- Must have `mint(address, uint256)` function
- Must have `burnFrom(address, uint256)` function (via ERC20Burnable)
- Must support minter role system

### LayerZero Requirements
- Valid LayerZero endpoint for each network
- Proper peer configuration between adapters
- Sufficient native tokens for cross-chain fees

## Verification Commands

```javascript
// Check adapter is minter
await yusd.minter() // Should return adapter address

// Check token reference
await adapter.yusdToken() // Should return YUSD address
await adapter.innerToken() // Should return YUSD address

// Check peer connections
await adapter.peers(destinationEid) // Should return destination adapter

// Check LayerZero endpoint
await adapter.endpoint() // Should return LayerZero endpoint
```

## Best Practices

1. **Always verify minter role** before using adapter
2. **Monitor events** for cross-chain transfer tracking
3. **Set appropriate slippage protection** with minAmountLD
4. **Test on testnets** before mainnet deployment
5. **Keep sufficient native tokens** for LayerZero fees
6. **Use consistent peer configurations** across all networks

This adapter provides a robust, secure, and efficient solution for YUSD cross-chain transfers while maintaining compatibility with existing YUSD token deployments. 