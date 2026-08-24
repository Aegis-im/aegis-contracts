// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

/**
 * @dev Local stand-in for the sYUSD vault: a plain ERC-4626 over YUSD with no cooldown,
 * silo, or fees. Yield is simulated exactly like production: transfer YUSD directly to the
 * vault (donation), which raises the share price read via `convertToAssets`.
 */
contract SimSYUSD is ERC4626 {
    constructor(IERC20 yusd) ERC20("Staked YUSD", "sYUSD") ERC4626(yusd) {}
}
