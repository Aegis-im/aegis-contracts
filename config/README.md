# Network Configuration

This directory contains centralized network configuration for the Aegis smart contracts project.

## Files

- `networks.json` - Main configuration file containing network settings and contract addresses

## Structure

```json
{
  "networks": {
    "networkName": {
      "chainId": 1,
      "rpcUrl": "https://...",
      "gasPrice": 1000000000,
      "endpointId": 30101,
      "description": "Network description",
      "explorer": "https://...",
      "contracts": {
        "yusdAddress": "0x...",
        "adminAddress": "0x...",
        "elevatedMinterBurner": "0x...",
        "oftAdapterAddress": "0x..."
      },
      "layerzero": {
        "targetEid": 30102,
        "targetNetworkName": "otherNetwork"
      }
    }
  },
  "common": {
    "solidity": {
      "version": "0.8.26",
      "optimizer": {
        "enabled": true,
        "runs": 200
      }
    }
  }
}
```

## Security

⚠️ **IMPORTANT**: This JSON file should NOT contain sensitive information:
- Private keys
- API keys
- Passwords
- Any other secrets

Sensitive data should remain in `.env` files:
- `PRIVATE_KEY`
- `ALCHEMY_API_KEY`
- `ETHERSCAN_API_KEY`

## Migration from .env files

The system automatically sets legacy environment variables for backward compatibility with existing scripts. These are marked as DEPRECATED in the code:

- `YUSD_ADDRESS`
- `LZ_ENDPOINT`
- `ADMIN_ADDRESS`
- `OFT_ADAPTER_ADDRESS`
- `TIMELOCK_ADDRESS`
- `TARGET_EID`
- `TARGET_NETWORK_NAME`
- `NETWORK_EXPLORER`

## Usage

1. Update contract addresses in `networks.json` after deployment
2. Use `hardhat.config.ts` export to access configuration in scripts:

```typescript
import { networksConfig } from '../hardhat.config'

const networkConfig = networksConfig.networks[hre.network.name]
const yusdAddress = networkConfig.contracts.yusdAddress
```

## Future Improvements

- Consider updating legacy scripts to use the new config system directly
- Remove deprecated environment variable compatibility layer
- Add validation schema for the JSON configuration 