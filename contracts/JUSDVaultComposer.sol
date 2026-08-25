// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import { VaultComposerSync } from "@layerzerolabs/ovault-evm/contracts/VaultComposerSync.sol";

contract JUSDVaultComposer is VaultComposerSync {
    constructor(
        address _vault,
        address _assetOFT,
        address _shareOFT
    ) VaultComposerSync(_vault, _assetOFT, _shareOFT) {}
}
