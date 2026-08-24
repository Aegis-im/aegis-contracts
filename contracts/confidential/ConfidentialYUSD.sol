// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {AegisConfidentialWrapper} from "./AegisConfidentialWrapper.sol";
import {IBlacklistSource} from "./interfaces/IBlacklistSource.sol";

/// @dev Confidential YUSD: ERC-7984 wrapper over canonical YUSD.
contract ConfidentialYUSD is AegisConfidentialWrapper {
    constructor(
        IERC20 yusd,
        address auditor_,
        address owner_
    )
        AegisConfidentialWrapper(
            yusd,
            IBlacklistSource(address(yusd)),
            auditor_,
            owner_,
            "Confidential YUSD",
            "cYUSD",
            ""
        )
    {}
}
