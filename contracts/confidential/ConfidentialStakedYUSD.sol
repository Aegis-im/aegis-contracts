// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {AegisConfidentialWrapper} from "./AegisConfidentialWrapper.sol";
import {IBlacklistSource} from "./interfaces/IBlacklistSource.sol";

/**
 * @dev Confidential staked YUSD: ERC-7984 wrapper over sYUSD vault shares.
 *
 * Holds no yield logic: one csYUSD unit is permanently `rate()` sYUSD share-wei. Value
 * accrues through the public sYUSD share price (`convertToAssets`), so yield reaches
 * confidential holders with zero confidential-layer mechanics and zero backend changes.
 *
 * The blacklist source is canonical YUSD (sYUSD has no blacklist of its own): one policy
 * source governs both the plain and the staked confidential wrappers.
 */
contract ConfidentialStakedYUSD is AegisConfidentialWrapper {
    constructor(
        IERC20 sYusd,
        IBlacklistSource yusd,
        address auditor_,
        address owner_
    )
        AegisConfidentialWrapper(
            sYusd,
            yusd,
            auditor_,
            owner_,
            "Confidential Staked YUSD",
            "csYUSD",
            ""
        )
    {}
}
