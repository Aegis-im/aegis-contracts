// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IVaultRewards {
  function claimRewards(bytes32[] memory ids, uint256[] memory amounts, bytes memory signature) external;

  function depositRewards(bytes calldata requestId, uint256 amount) external;
}

interface IVaultRewardsEvents {
  /// @dev Event emitted when Token rewards is deposited to the contract
  event DepositRewards(bytes32 id, uint256 amount, uint256 timestamp);

  /// @dev Event emitted when rewards with id are finalized
  event FinalizeRewards(bytes32 id, uint256 expiry);

  /// @dev Event emitted when expired rewards withdrawn
  event WithdrawExpiredRewards(bytes32 id, address to, uint256 amount);

  /// @dev Event emitted when user claims rewards
  event ClaimRewards(address indexed wallet, bytes32[] ids, uint256 totalAmount);

  /// @dev Event emitted when VaultConfig contract address is changed
  event SetVaultConfigAddress(address indexed config);

  /// @dev Event emitted when VaultMinting contract address is changed
  event SetVaultMintingAddress(address indexed minting);

  /// @dev Event emitted when VaultIncomeRouter contract address is changed
  event SetVaultIncomeRouterAddress(address indexed incomeRouter);

  /// @dev Event emitted when ERC20 tokens are rescued from contract
  event RescueAssets(address indexed token, address indexed to, uint256 amount);
}

interface IVaultRewardsErrors {
  error ZeroAddress();
  error InvalidAddress();
  error ZeroRewards();
  error UnknownRewards();
  error InsufficientContractBalance();
  error NoTokensToRescue();
}
