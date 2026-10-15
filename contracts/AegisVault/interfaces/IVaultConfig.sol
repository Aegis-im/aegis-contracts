// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.26;

interface IVaultConfig {
  function trustedSigner() external view returns (address);

  function isWhitelisted(address addr) external view returns (bool);
}

interface IVaultConfigEvents {
  /// @dev Event emitted when one address whitelist status is changed
  event WhitelistAddress(address addr, bool whitelisted);

  /// @dev Event emitted when multiple address whitelist statuses are changed
  event WhitelistAddressBatch(address[] addrs, bool[] whitelisted);

  /// @dev Event emitted when a trusted signer is changed
  event SetTrustedSigner(address indexed signer);

  /// @dev Event emitted when whitelist functionality is enabled
  event WhitelistEnabled();

  /// @dev Event emitted when whitelist functionality is disabled
  event WhitelistDisabled();

  /// @dev Event emitted when operator is set/unset
  event SetOperator(address indexed operator, bool allowed);
}

interface IVaultConfigErrors {
  error InvalidArguments();
  error ZeroAddress();
  error AccessForbidden();
}
