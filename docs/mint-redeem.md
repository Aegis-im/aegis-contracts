# Aegis Minting Protocol Documentation

## Overview

The Aegis Minting Protocol allows users to mint YUSD stablecoins using supported collateral assets, and to redeem YUSD back for collateral. This document outlines the API endpoints and smart contract interactions required to perform these operations.

## Contract Information

**Contract Address**: 0xA30644CA67E0A93805c443Df4A6E1856d8Bd815B  
**Network**: Ethereum Mainnet

## Authentication

All API requests require authentication using a bearer token:

```
-H 'authorization: Bearer <Token>'
```

Replace `<Token>` with your valid authentication token.

## Minting YUSD

Minting is a two-step process:

1. Request minting parameters from the Aegis API
2. Execute the mint transaction on the Aegis smart contract

### Step 1: Request Minting Parameters

Make a request to the Aegis API to prepare the minting order:

```
curl 'https://api.aegis.im/api/minting/mint' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'authorization: Bearer <Token>' \
  -H 'content-type: application/json' \
  --data-raw '{"collateral_asset":"0xdAC17F958D2ee523a2206206994597C13D831ec7","collateral_amount":"5000953","slippage":50,"signature":"0x2a461f92f0df4522cddd0a40909e07ac3d17a7779c706af505bc90493429d04e5e2fc7a7b26c61d9fd01daf553da7a3de357e0ec009c9fabed112bf48d51c7e81b"}'
```

**Parameters:**
- `collateral_asset`: Address of the collateral token (e.g., USDT)
- `collateral_amount`: Amount of collateral in the smallest units (e.g., for USDT, multiply by 10^6)
- `slippage`: Maximum acceptable price slippage in basis points (1 = 0.01%)
- `signature`: Your signed approval for the minting operation

**Response:**
```json
{"data":{"order":{"order_type":0,"user_wallet":"0xdA5a6F9FeEc7308b95F1B68b9ca0754590A9A285","collateral_asset":"0xdAC17F958D2ee523a2206206994597C13D831ec7","collateral_amount":"4997999","yusd_amount":"4996219712356000000","slippage_adjusted_amount":"4971238613794220000","expiry":1743029805,"nonce":1743029505,"additional_data":"0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000"},"price":"0.999644","signature":"0x6785d009d2e215cb35d5f2bc43adff4f8852d29cddaa9645c1a13874fd977ad81fdb1cef4b0218cf6419c4a00fdf21d39976de6567fadb196c2463efa77a7cda1b"},"status":"success"}
```

### Step 2: Execute Mint Transaction

Use the response data to call the `mint` method on the Aegis smart contract. Pass the `order` object and `signature` from the API response as parameters to the contract method.

## Redeeming YUSD

Redeeming is also a two-step process:

1. Request redemption parameters from the Aegis API
2. Execute the redemption transaction on the Aegis smart contract

### Step 1: Request Redemption Parameters

```
curl 'https://api.aegis.im/api/minting/request-redeem' \
  -H 'accept: application/json, text/plain, */*' \
  -H 'authorization: Bearer <Token>' \
  -H 'content-type: application/json' \
  --data-raw '{"collateral_asset":"0xdAC17F958D2ee523a2206206994597C13D831ec7","yusd_amount":"10000000000000000000","slippage":50,"signature":"0x9c977b232b750fb15e1f92994e6b443d93e97e87e0f41b5b8ecc0e3a786920ef5469fe5e2796c0a9c4c2789448e002064cc758e7223f70aa4bf462165ec247611b"}'
```

**Parameters:**
- `collateral_asset`: Address of the collateral token you wish to receive
- `yusd_amount`: Amount of YUSD to redeem (in wei, 18 decimals)
- `slippage`: Maximum acceptable price slippage in basis points (1 = 0.01%)
- `signature`: Your signed approval for the redemption operation

**Response:**
```json
{"data":{"order":{"order_type":1,"user_wallet":"0xdA5a6F9FeEc7308b95F1B68b9ca0754590A9A285","collateral_asset":"0xdAC17F958D2ee523a2206206994597C13D831ec7","collateral_amount":"10003380","yusd_amount":"10000000000000000000","slippage_adjusted_amount":"9953363","expiry":1743634100,"nonce":1743029300,"additional_data":"0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000014644c736779386a324931726c394d797151766545000000000000000000000000"},"price":"0.999662","signature":"0xb7a962c3725864ad62398651908676f3c45f07fa501aa356cd597fc12e1514d278677ba8fe44e1922ebd1db6c0f0ba90a65a31e5942edb4664ac9afab7a089751b"},"status":"success"}
```

### Step 2: Execute Redemption Transaction

Use the response data to call the `requestRedeem` method on the Aegis smart contract. Pass the `order` object and `signature` from the API response as parameters to the contract method.

## Important Notes

1. **Approvals**: Before minting, you must approve the Aegis contract to spend your collateral tokens.
2. **Gas Fees**: All transactions on the Ethereum network require gas fees.
3. **Expiry**: All orders have an expiration timestamp. Make sure to submit your transaction before this time.
4. **Slippage**: The slippage parameter protects you from price movements between your request and execution.
5. **Request IDs**: For redemptions, the system generates a unique request ID that you can use to track the status of your redemption.

## Supported Collateral Assets

To check if an asset is supported, call the `isSupportedAsset` method on the contract. Currently YUSD supports USDT, USDC and DAI.
