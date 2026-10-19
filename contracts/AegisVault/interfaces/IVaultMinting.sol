// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "../lib/VaultOrderLib.sol";

/**
 * @notice Minimal interface for VaultIncomeRouter to access VaultMinting state
 * @dev Only includes public state variables that are auto-generated getters
 */
interface IVaultMinting {
    /// @notice Get insurance fund address
    function insuranceFundAddress() external view returns (address);

    /// @notice Get income fee in basis points
    function incomeFeeBP() external view returns (uint16);

    /// @notice Get Chainlink USD price for asset
    function assetChainlinkUSDPrice(address asset) external view returns (uint256);

    function quoteMint(address asset, uint256 amount) external view returns (uint256);

    /// @notice Mint Token rewards in exchange for collateral already transferred to this contract
    /// @dev Caller must have FUNDS_MANAGER_ROLE; order.userWallet must equal msg.sender (the router)
    function depositIncome(VaultOrderLib.Order calldata order, bytes calldata signature) external;

    /// @notice Transfer custody-transferrable collateral to a registered custodian wallet
    /// @dev Caller must have COLLATERAL_MANAGER_ROLE; `wallet` must be a registered custodian
    function transferToCustody(address wallet, address asset, uint256 amount) external;

    /// @notice Transfer all unfrozen custody-transferrable collateral to a registered custodian wallet
    /// @dev Caller must have COLLATERAL_MANAGER_ROLE; `wallet` must be a registered custodian
    function forceTransferToCustody(address wallet, address asset) external;

    /// @notice Collateral held at minting that is not custody-transferrable or frozen — redemption liquidity
    function untrackedAvailableAssetBalance(address asset) external view returns (uint256);

    /// @notice Collateral held at minting that may still be moved to a custodian
    function custodyAvailableAssetBalance(address asset) external view returns (uint256);

    /// @notice Whether `asset` is supported collateral — the only kind minting can pay out or move to custody
    function isSupportedAsset(address asset) external view returns (bool);
}

interface IVaultMintingEvents {
  /// @dev Event emitted when Token is minted
  event Mint(address indexed userWallet, address collateralAsset, uint256 collateralAmount, uint256 tokenAmount, uint256 fee);

  /// @dev Event emitted when new RedeemRequest is created
  event CreateRedeemRequest(string requestId, address indexed userWallet, address collateralAsset, uint256 collateralAmount, uint256 tokenAmount);

  /// @dev Event emitted when RedeemRequest is approved and executed by funds manager
  event ApproveRedeemRequest(
    string requestId,
    address indexed manager,
    address indexed userWallet,
    address collateralAsset,
    uint256 collateralAmount,
    uint256 tokenAmount,
    uint256 fee
  );

  /// @dev Event emitted when RedeemRequest is rejected
  event RejectRedeemRequest(string requestId, address manager, address userWallet, uint256 tokenAmount);

  /// @dev Event emitted when expired redeem request is withdrawn by user
  event WithdrawRedeemRequest(string requestId, address userWallet, uint256 tokenAmount);

  /// @dev Event emitted when collateral asset income is deposited
  event DepositIncome(
    string snapshotId,
    address indexed manager,
    address collateralAsset,
    uint256 collateralAmount,
    uint256 tokenAmount,
    uint256 fee,
    uint256 timestamp
  );

  /// @dev Event emitted when collateral asset is transferred to custodian wallet
  event CustodyTransfer(address indexed wallet, address indexed asset, uint256 amount);

  /// @dev Event emitted when all collateral assets forcefully transferred to custodian wallet
  event ForceCustodyTransfer(address indexed wallet, address indexed asset, uint256 amount);

  /// @dev Event emitted when a supported asset is added
  event AssetAdded(address indexed asset, uint32 chainlinkHeartbeat);

  /// @dev Event emitted when a supported asset is removed
  event AssetRemoved(address indexed asset);

  /// @dev Event emitted when a custodian address is added
  event CustodianAddressAdded(address indexed custodian);

  /// @dev Event emitted when a custodian address is removed
  event CustodianAddressRemoved(address indexed custodian);

  /// @dev Event emitted when a VaultRewards contract address is changed
  event SetVaultRewardsAddress(address indexed rewards);

  /// @dev Event emitted when a VaultConfig contract address is changed
  event SetVaultConfigAddress(address indexed config);

  /// @dev Event emitted when a InsuranceFund address is changed
  event SetInsuranceFundAddress(address indexed insuranceFund);

  /// @dev Event emitted when a VaultOracle address is changed
  event SetVaultOracleAddress(address indexed oracle);

  /// @dev Event emitted when cross-chain operator address is changed
  event SetCrossChainOperator(address indexed operator);

  /// @dev Event emitted when a fee percent of income minted Token is changed
  event SetIncomeFeeBP(uint16 percentPB);

  /// @dev Event emitted when mint is paused/unpaused
  event MintPauseChanged(bool paused);

  /// @dev Event emitted when redeem is paused/unpaused
  event RedeemPauseChanged(bool paused);

  /// @dev Event emitted when a fee percent of minted Token is changed
  event SetMintFeeBP(uint16 val);

  /// @dev Event emitted when a fee percent of redeemed Token is changed
  event SetRedeemFeeBP(uint16 val);

  /// @dev Event emitted when asset amount is frozen
  event FreezeFunds(address indexed asset, uint256 amount);

  /// @dev Event emitted when asset amount is unfrozen
  event UnfreezeFunds(address indexed asset, uint256 amount);

  /// @dev Event emitted when mint limit parameters are changed
  event SetMintLimits(uint32 periodDuration, uint256 maxPeriodAmount);

  /// @dev Event emitted when redeem limit parameters are changed
  event SetRedeemLimits(uint32 periodDuration, uint256 maxPeriodAmount);

  /// @dev Event emitted when pre-collateralized mint limit parameters are changed
  event SetPreCollateralizedMintLimits(uint32 periodDuration, uint256 maxPeriodAmountBps);

  /// @dev Event emitted when Chainlink FeedRegistry address is changed
  event SetFeedRegistryAddress(address registry);

  /// @dev Event emitted when Chainlink asset feed heartbeat is changed
  event SetChainlinkAssetHeartbeat(address indexed asset, uint32 chainlinkHeartbeat);

  /// @dev Event emitted when Token is minted for cross-chain transfer
  event CrossChainMint(address indexed to, uint256 amount);

  /// @dev Event emitted when Token is burned for cross-chain transfer
  event CrossChainBurn(address indexed from, uint256 amount);

  /// @dev Event emitted when cross-chain operations are paused/unpaused
  event CrossChainPauseChanged(bool paused);
}

interface IVaultMintingErrors {
  error ZeroAddress();
  error InvalidAddress();
  error InvalidAssetAddress(address asset);
  error InvalidCustodianAddress(address custodian);
  error InvalidOrder();
  error NotEnoughFunds();
  error InvalidPercentBP(uint256 value);
  error InvalidRedeemRequest();
  error NotAssetsProvided();
  error MintPaused();
  error RedeemPaused();
  error InvalidAmount();
  error LimitReached();
  error NotWhitelisted();
  error PriceSlippage();
  error InvalidNonce();
  error NotAuthorized();
  error CrossChainPaused();
}
