// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {AegisConfidentialWrapper} from "./AegisConfidentialWrapper.sol";

/**
 * @dev One-transaction on-ramp: YUSD -> sYUSD (ERC-4626 deposit) -> csYUSD (confidential wrap).
 *
 * The plaintext amounts here are public by design: privacy starts once the minted csYUSD
 * balance handle exists. Shares that do not fit the wrapper rate (sub-rate dust) are sent
 * to the receiver as plain sYUSD instead of being stranded.
 *
 * The reverse path (csYUSD -> YUSD) is intentionally not provided: it would chain an async
 * decryption with the production cooldown state machine, which is out of PoC scope.
 */
contract StakeAndWrapRouter {
    using SafeERC20 for IERC20;

    IERC20 public immutable yusd;
    IERC4626 public immutable sYusd;
    AegisConfidentialWrapper public immutable csYusd;

    constructor(IERC20 yusd_, IERC4626 sYusd_, AegisConfidentialWrapper csYusd_) {
        yusd = yusd_;
        sYusd = sYusd_;
        csYusd = csYusd_;
        yusd_.forceApprove(address(sYusd_), type(uint256).max);
        IERC20(address(sYusd_)).forceApprove(address(csYusd_), type(uint256).max);
    }

    /// @dev Stakes `yusdAmount` of the caller's YUSD and wraps the resulting shares to `to`.
    function stakeAndWrap(uint256 yusdAmount, address to) external returns (uint256 shares) {
        yusd.safeTransferFrom(msg.sender, address(this), yusdAmount);
        shares = sYusd.deposit(yusdAmount, address(this));

        uint256 dust = shares % csYusd.rate();
        csYusd.wrap(to, shares - dust);
        if (dust > 0) {
            IERC20(address(sYusd)).safeTransfer(to, dust);
        }
    }
}
