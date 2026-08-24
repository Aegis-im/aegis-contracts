// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

/// @dev Minimal read interface for the canonical YUSD blacklist.
interface IBlacklistSource {
    function isBlackListed(address account) external view returns (bool);
}
