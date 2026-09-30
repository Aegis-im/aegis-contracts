// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { IERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";

import { FeedRegistryInterface } from "@chainlink/contracts/src/v0.8/interfaces/FeedRegistryInterface.sol";
import { Denominations } from "@chainlink/contracts/src/v0.8/Denominations.sol";

import { VaultOrderLib } from "./lib/VaultOrderLib.sol";

import { IVaultMintingEvents, IVaultMintingErrors } from "./interfaces/IVaultMinting.sol";
import { IVaultRewards } from "./interfaces/IVaultRewards.sol";
import { IVaultConfig } from "./interfaces/IVaultConfig.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { IVaultToken } from "./interfaces/IVaultToken.sol";

contract VaultMinting is IVaultMintingEvents, IVaultMintingErrors, AccessControlDefaultAdminRules, ReentrancyGuard {
  using EnumerableSet for EnumerableSet.AddressSet;
  using EnumerableMap for EnumerableMap.AddressToUintMap;
  using VaultOrderLib for VaultOrderLib.Order;
  using SafeERC20 for IERC20;
  using SafeERC20 for IVaultToken;

  enum RedeemRequestStatus {
    PENDING,
    APPROVED,
    REJECTED,
    WITHDRAWN
  }

  struct RedeemRequest {
    RedeemRequestStatus status;
    VaultOrderLib.Order order;
    uint256 timestamp;
  }

  struct MintRedeemLimit {
    uint32 periodDuration;
    uint32 currentPeriodStartTime;
    uint256 maxPeriodAmount;
    uint256 currentPeriodTotalAmount;
  }

  error RewardsNotConfigured();
  error InvalidPrice();
  mapping(address => AggregatorV3Interface) public assetPriceFeeds;
  uint32 public oracleHeartbeat;
  event AssetPriceFeedSet(address indexed asset, address indexed feed);
  event OracleHeartbeatSet(uint32 heartbeat);

  uint16 constant MAX_BPS = 10_000;

  /// @dev role enabling to update various settings
  bytes32 private constant SETTINGS_MANAGER_ROLE = keccak256("SETTINGS_MANAGER_ROLE");

  /// @dev role enabling to deposit income/redeem and withdraw redeem
  bytes32 private constant FUNDS_MANAGER_ROLE = keccak256("FUNDS_MANAGER_ROLE");

  /// @dev role enabling to transfer collateral to custody wallets
  bytes32 private constant COLLATERAL_MANAGER_ROLE = keccak256("COLLATERAL_MANAGER_ROLE");

  /// @dev EIP712 domain
  bytes32 private constant EIP712_DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

  /// @dev EIP712 name
  bytes32 private immutable EIP712_NAME;
    string public domainName;

  /// @dev holds EIP712 revision
  bytes32 private constant EIP712_REVISION = keccak256("1");

  /// @dev Token stablecoin
  IVaultToken public immutable token;

  /// @dev VaultRewards contract
  IVaultRewards public aegisRewards;

  /// @dev VaultConfig contract
  IVaultConfig public aegisConfig;

  /// @dev VaultOracle contract providing Token/USD price
  AggregatorV3Interface public aegisOracle;

  /// @dev InsuranceFund address
  address public insuranceFundAddress;

  /// @dev Percent of Token rewards that will be transferred to InsuranceFund address. Default: 5%
  uint16 public incomeFeeBP = 500;

  /// @dev Mint pause state
  bool public mintPaused;

  /// @dev Redeem pause state
  bool public redeemPaused;

  /// @dev Cross-chain operations pause state
  bool public crossChainPaused;

  /// @dev Percent of Token that will be taken as a fee from mint amount
  uint16 public mintFeeBP;

  /// @dev Percent of Token that will be taken as a fee from redeem amount
  uint16 public redeemFeeBP;

  /// @dev Asset funds that were frozen and cannot be transfered to custody
  mapping(address => uint256) public assetFrozenFunds;

  /// @dev Mint limiting parameter
  MintRedeemLimit public mintLimit;

  /// @dev Redeem limiting parameters
  MintRedeemLimit public redeemLimit;

  /// @dev Tracks total amount of users locked Token for redeem requests
  uint256 public totalRedeemLockedToken;

  /// @dev Asset heartbeat of Chainlink feed in seconds
  mapping(address => uint32) public chainlinkAssetHeartbeat;

  /// @dev Chainlink FeedRegistry
  FeedRegistryInterface private _feedRegistry;

  /// @dev Supported assets
  EnumerableSet.AddressSet private _supportedAssets;

  /// @dev Custodian addresses
  EnumerableSet.AddressSet private _custodianAddresses;

  mapping(address => uint256) private _custodyTransferrableAssetFunds;

  /// @dev Map of redeem request id to RedeemRequest struct
  mapping(bytes32 => RedeemRequest) private _redeemRequests;

  /// @dev holds computable chain id
  uint256 private immutable _chainId;

  /// @dev holds computable domain separator
  bytes32 private immutable _domainSeparator;

  /// @dev user order deduplication
  mapping(address => mapping(uint256 => uint256)) private _orderBitmaps;

  /// @dev Single cross-chain operator address
  address private _crossChainOperatorAddress;

  modifier onlyWhitelisted(address sender) {
    if (address(aegisConfig) == address(0) || !aegisConfig.isWhitelisted(sender)) {
      revert NotWhitelisted();
    }
    _;
  }

  modifier onlySupportedAsset(address asset) {
    if (!_supportedAssets.contains(asset)) {
      revert InvalidAssetAddress(asset);
    }
    _;
  }

  modifier onlyCustodianAddress(address wallet) {
    if (!_custodianAddresses.contains(wallet)) {
      revert InvalidCustodianAddress(wallet);
    }
    _;
  }

  modifier whenRedeemUnpaused() {
    if (redeemPaused) {
      revert RedeemPaused();
    }
    _;
  }

  modifier onlyCrossChainOperator() {
    if (msg.sender != _crossChainOperatorAddress) {
      revert NotAuthorized();
    }
    _;
  }

  modifier whenCrossChainUnpaused() {
    if (crossChainPaused) {
      revert CrossChainPaused();
    }
    _;
  }

  constructor(
        string memory domainName_,
    IVaultToken _token,
    IVaultConfig _aegisConfig,
    IVaultRewards _aegisRewards,
    AggregatorV3Interface _aegisOracle,
    FeedRegistryInterface _fdRegistry,
    address _insuranceFundAddress,
    address[] memory _assets,
    uint32[] memory _chainlinkAssetHeartbeats,
    address[] memory _custodians,
    address _admin,
    uint48 adminDelay_,
    uint32 oracleHeartbeat_
  ) AccessControlDefaultAdminRules(adminDelay_, _admin) {
    if (address(_token) == address(0)) revert ZeroAddress();
    if (address(_aegisConfig) == address(0)) revert ZeroAddress();
    if (_assets.length == 0) revert NotAssetsProvided();
    require(_assets.length == _chainlinkAssetHeartbeats.length);

    require(_token.decimals() == 18, "Token must have 18 decimals");
    require(oracleHeartbeat_ > 0, "Invalid heartbeat");
    oracleHeartbeat = oracleHeartbeat_;
    token = _token;
    mintLimit.currentPeriodStartTime = uint32(block.timestamp);
    redeemLimit.currentPeriodStartTime = uint32(block.timestamp);
    _setVaultRewardsAddress(_aegisRewards);
    _setVaultConfigAddress(_aegisConfig);
    _setFeedRegistryAddress(_fdRegistry);
    _setVaultOracleAddress(_aegisOracle);
    _setInsuranceFundAddress(_insuranceFundAddress);

    for (uint256 i = 0; i < _assets.length; i++) {
      _addSupportedAsset(_assets[i], _chainlinkAssetHeartbeats[i]);
    }

    for (uint256 i = 0; i < _custodians.length; i++) {
      _addCustodianAddress(_custodians[i]);
    }

    domainName = domainName_;
    EIP712_NAME = keccak256(bytes(domainName_));
    _chainId = block.chainid;
    _domainSeparator = _computeDomainSeparator();
  }

  /// @dev Returns custody transferrable asset funds minus durty funds
  function custodyAvailableAssetBalance(address asset) public view returns (uint256) {
    return _custodyAvailableAssetBalance(asset);
  }

  /// @dev Returns asset balance minus custody transferrable and durty funds
  function untrackedAvailableAssetBalance(address asset) public view returns (uint256) {
    return _untrackedAvailableAssetBalance(asset);
  }

  /// @dev Returns RedeemRequest by id
  function getRedeemRequest(string calldata requestId) public view returns (RedeemRequest memory) {
    return _redeemRequests[keccak256(abi.encode(requestId))];
  }

  /// @dev Retuns asset/USD price from Chainlink feed
  function assetChainlinkUSDPrice(address asset) public view returns (uint256) {
    (uint256 price, ) = _getAssetUSDPriceChainlink(asset);
    return price;
  }

  /// @dev Returns asset/Token price from VaultOracle
  function assetVaultOracleTokenPrice(address asset) public view returns (uint256) {
    (uint256 price, ) = _getAssetTokenPriceOracle(asset);
    return price;
  }

  /**
   * @dev Mints Token from assets
   * @param order Struct containing order details
   * @param signature Signature of trusted signer
   */
  function mint(
    VaultOrderLib.Order calldata order,
    bytes calldata signature
  ) external nonReentrant onlyWhitelisted(order.userWallet) onlySupportedAsset(order.collateralAsset) {
    if (mintPaused) {
      revert MintPaused();
    }
    if (order.orderType != VaultOrderLib.OrderType.MINT) {
      revert InvalidOrder();
    }

    _checkMintRedeemLimit(mintLimit, order.tokenAmount);
    order.verify(getDomainSeparator(), aegisConfig.trustedSigner(), signature);
    _deduplicateOrder(order.userWallet, order.nonce);

    uint256 balanceBefore = IERC20(order.collateralAsset).balanceOf(address(this));
    IERC20(order.collateralAsset).safeTransferFrom(order.userWallet, address(this), order.collateralAmount);
    uint256 balanceAfter = IERC20(order.collateralAsset).balanceOf(address(this));
    uint256 received = balanceAfter - balanceBefore;

    uint256 tokenAmount = _calculateMinTokenAmount(order.collateralAsset, received, order.tokenAmount);
    if (tokenAmount < order.slippageAdjustedAmount) {
      revert PriceSlippage();
    }

    // Take a fee, if it's applicable
    (uint256 mintAmount, uint256 fee) = _calculateInsuranceFundFeeFromAmount(tokenAmount, mintFeeBP);
    if (fee > 0) {
      token.mint(insuranceFundAddress, fee);
    }

    token.mint(order.userWallet, mintAmount);
    _custodyTransferrableAssetFunds[order.collateralAsset] += received;

    emit Mint(_msgSender(), order.collateralAsset, received, mintAmount, fee);
  }

  /**
   * @dev Creates new RedeemRequest and locks user's Token tokens
   * @param order Struct containing order details
   * @param signature Signature of trusted signer
   */
  function requestRedeem(
    VaultOrderLib.Order calldata order,
    bytes calldata signature
  ) external nonReentrant onlyWhitelisted(order.userWallet) whenRedeemUnpaused onlySupportedAsset(order.collateralAsset) {
    if (order.orderType != VaultOrderLib.OrderType.REDEEM) {
      revert InvalidOrder();
    }

    _checkMintRedeemLimit(redeemLimit, order.tokenAmount);
    order.verify(getDomainSeparator(), aegisConfig.trustedSigner(), signature);

    _deduplicateOrder(order.userWallet, order.nonce);
    uint256 collateralAmount = _calculateRedeemMinCollateralAmount(order.collateralAsset, order.collateralAmount, order.tokenAmount);
    // Revert transaction when smallest amount is less than order minAmount
    if (collateralAmount < order.slippageAdjustedAmount) {
      revert PriceSlippage();
    }

    string memory requestId = abi.decode(order.additionalData, (string));
    RedeemRequest memory request = _redeemRequests[keccak256(abi.encode(requestId))];
    if (request.timestamp != 0) {
      revert InvalidRedeemRequest();
    }

    _redeemRequests[keccak256(abi.encode(requestId))] = RedeemRequest(RedeemRequestStatus.PENDING, order, block.timestamp);

    // Lock Token
    token.safeTransferFrom(order.userWallet, address(this), order.tokenAmount);
    totalRedeemLockedToken += order.tokenAmount;

    emit CreateRedeemRequest(requestId, _msgSender(), order.collateralAsset, order.collateralAmount, order.tokenAmount);
  }

  /**
   * @dev Approves pending RedeemRequest.
   * @dev Burns locked Token and transfers collateral amount to request order benefactor
   * @param requestId Id of RedeemRequest to approve
   * @param amount Max collateral amount that will be transferred to user
   */
  function approveRedeemRequest(string calldata requestId, uint256 amount) external nonReentrant onlyRole(FUNDS_MANAGER_ROLE) whenRedeemUnpaused {
    RedeemRequest storage request = _redeemRequests[keccak256(abi.encode(requestId))];
    if (request.timestamp == 0 || request.status != RedeemRequestStatus.PENDING) {
      revert InvalidRedeemRequest();
    }
    if (amount == 0 || amount > request.order.collateralAmount) {
      revert InvalidAmount();
    }

    (uint256 burnAmount, uint256 fee) = _calculateInsuranceFundFeeFromAmount(request.order.tokenAmount, redeemFeeBP);
    uint256 collateralAmount = _calculateRedeemMinCollateralAmount(request.order.collateralAsset, amount, burnAmount);

    /*
     * Reject if:
     * - asset is no longer supported
     * - smallest amount is less than order minAmount
     * - order expired
     */
    if (
      !_supportedAssets.contains(request.order.collateralAsset) ||
      collateralAmount < request.order.slippageAdjustedAmount ||
      request.order.expiry < block.timestamp
    ) {
      _rejectRedeemRequest(requestId, request);
      return;
    }

    // Take a fee, if it's applicable
    if (fee > 0) {
      token.safeTransfer(insuranceFundAddress, fee);
    }

    uint256 availableAssetFunds = _untrackedAvailableAssetBalance(request.order.collateralAsset);
    if (availableAssetFunds < collateralAmount) {
      revert NotEnoughFunds();
    }

    request.status = RedeemRequestStatus.APPROVED;
    totalRedeemLockedToken -= request.order.tokenAmount;

    IERC20(request.order.collateralAsset).safeTransfer(request.order.userWallet, collateralAmount);
    token.burn(burnAmount);

    emit ApproveRedeemRequest(requestId, _msgSender(), request.order.userWallet, request.order.collateralAsset, collateralAmount, burnAmount, fee);
  }

  /**
   * @dev Rejects pending RedeemRequest and unlocks user's Token
   * @param requestId Id of RedeemRequest to reject
   */
  function rejectRedeemRequest(string calldata requestId) external nonReentrant onlyRole(FUNDS_MANAGER_ROLE) whenRedeemUnpaused {
    RedeemRequest storage request = _redeemRequests[keccak256(abi.encode(requestId))];
    if (request.timestamp == 0 || request.status != RedeemRequestStatus.PENDING) {
      revert InvalidRedeemRequest();
    }

    _rejectRedeemRequest(requestId, request);
  }

  /**
   * @dev Withdraws expired RedeemRequest locked Token funds to user
   * @param requestId Id of RedeemRequest to withdraw
   */
  function withdrawRedeemRequest(string calldata requestId) public nonReentrant whenRedeemUnpaused {
    RedeemRequest storage request = _redeemRequests[keccak256(abi.encode(requestId))];
    if (request.timestamp == 0 || request.status != RedeemRequestStatus.PENDING || request.order.expiry > block.timestamp) {
      revert InvalidRedeemRequest();
    }

    request.status = RedeemRequestStatus.WITHDRAWN;

    // Unlock Token
    totalRedeemLockedToken -= request.order.tokenAmount;
    token.safeTransfer(request.order.userWallet, request.order.tokenAmount);

    emit WithdrawRedeemRequest(requestId, request.order.userWallet, request.order.tokenAmount);
  }

  /**
   * @dev Mints Token for cross-chain transfer
   * @param to Address to mint Token to
   * @param amount Amount of Token to mint
   */
  function mintForCrossChain(address to, uint256 amount) 
    external 
    nonReentrant 
    onlyCrossChainOperator 
    whenCrossChainUnpaused 
  {
    token.mint(to, amount);
    emit CrossChainMint(to, amount);
  }

  /**
   * @dev Burns Token for cross-chain transfer
   * @param from Address to burn Token from
   * @param amount Amount of Token to burn
   */
  function burnForCrossChain(address from, uint256 amount) 
    external 
    nonReentrant 
    onlyCrossChainOperator 
    whenCrossChainUnpaused 
  {
    token.burnFrom(from, amount);
    emit CrossChainBurn(from, amount);
  }



  /**
   * @dev Mints Token rewards in exchange for collateral asset income
   * @param order Struct containing order details
   * @param signature Signature of trusted signer
   */
  function depositIncome(
    VaultOrderLib.Order calldata order,
    bytes calldata signature
  ) external nonReentrant onlyRole(FUNDS_MANAGER_ROLE) onlySupportedAsset(order.collateralAsset) {
    if (address(aegisRewards) == address(0)) revert RewardsNotConfigured();
    if (order.orderType != VaultOrderLib.OrderType.DEPOSIT_INCOME) {
      revert InvalidOrder();
    }
    order.verify(getDomainSeparator(), aegisConfig.trustedSigner(), signature);
    _deduplicateOrder(order.userWallet, order.nonce);

    uint256 availableAssetFunds = _untrackedAvailableAssetBalance(order.collateralAsset);
    if (availableAssetFunds < order.collateralAmount) {
      revert NotEnoughFunds();
    }

    uint256 tokenAmount = _calculateMinTokenAmount(order.collateralAsset, order.collateralAmount, order.tokenAmount);

    _custodyTransferrableAssetFunds[order.collateralAsset] += order.collateralAmount;

    // Transfer percent of Token rewards to insurance fund
    (uint256 mintAmount, uint256 fee) = _calculateInsuranceFundFeeFromAmount(tokenAmount, incomeFeeBP);
    if (fee > 0) {
      token.mint(insuranceFundAddress, fee);
    }

    // Mint Token rewards to VaultRewards contract
    token.mint(address(aegisRewards), mintAmount);
    aegisRewards.depositRewards(order.additionalData, mintAmount);

    emit DepositIncome(
      abi.decode(order.additionalData, (string)),
      _msgSender(),
      order.collateralAsset,
      order.collateralAmount,
      mintAmount,
      fee,
      block.timestamp
    );
  }

  /**
   * @dev Transfers provided amount of asset to custodian wallet
   * @param wallet Custodian address
   * @param asset Asset address to transfer
   * @param amount Asset amount to transfer
   */
  function transferToCustody(
    address wallet,
    address asset,
    uint256 amount
  ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) onlySupportedAsset(asset) onlyCustodianAddress(wallet) {
    uint256 availableBalance = _custodyAvailableAssetBalance(asset);
    if (availableBalance < amount) {
      revert NotEnoughFunds();
    }

    _custodyTransferrableAssetFunds[asset] -= amount;
    IERC20(asset).safeTransfer(wallet, amount);

    emit CustodyTransfer(wallet, asset, amount);
  }

  /**
   * @dev Forcefully transfers all asset funds except frozen
   * @param wallet Custodian address
   * @param asset Asset address to transfer
   */
  function forceTransferToCustody(
    address wallet,
    address asset
  ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) onlySupportedAsset(asset) onlyCustodianAddress(wallet) {
    uint256 availableBalance = _custodyAvailableAssetBalance(asset);
    if (availableBalance == 0) {
      revert NotEnoughFunds();
    }

    _custodyTransferrableAssetFunds[asset] -= availableBalance;
    IERC20(asset).safeTransfer(wallet, availableBalance);

    emit ForceCustodyTransfer(wallet, asset, availableBalance);
  }

  /// @dev Sets new VaultRewards address
  function setVaultRewardsAddress(IVaultRewards _aegisRewards) external onlyRole(SETTINGS_MANAGER_ROLE) {
    _setVaultRewardsAddress(_aegisRewards);
  }

  /// @dev Sets new VaultConfig address
  function setVaultConfigAddress(IVaultConfig _config) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setVaultConfigAddress(_config);
  }

  /// @dev Sets new InsuranceFund address
  function setInsuranceFundAddress(address _insuranceFundAddress) external onlyRole(SETTINGS_MANAGER_ROLE) {
    if (_insuranceFundAddress == address(this)) {
      revert InvalidAddress();
    }
    _setInsuranceFundAddress(_insuranceFundAddress);
  }

  /// @dev Sets new FeedRegistry address
  function setFeedRegistryAddress(FeedRegistryInterface _registry) external onlyRole(SETTINGS_MANAGER_ROLE) {
    _setFeedRegistryAddress(_registry);
  }

  /// @dev Sets new VaultOracle address
  function setVaultOracleAddress(AggregatorV3Interface _aegisOracle) external onlyRole(SETTINGS_MANAGER_ROLE) {
    _setVaultOracleAddress(_aegisOracle);
  }

  /// @dev Sets cross-chain operator address
  function setCrossChainOperator(address _operator) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setCrossChainOperator(_operator);
  }

  /// @dev Sets percent in basis points of Token that will be taken as a fee on depositIncome
  function setIncomeFeeBP(uint16 value) external onlyRole(SETTINGS_MANAGER_ROLE) {
    // No more than 50%
    if (value > MAX_BPS / 2) {
      revert InvalidPercentBP(value);
    }
    incomeFeeBP = value;
    emit SetIncomeFeeBP(value);
  }

  /// @dev Switches mint pause state
  function setMintPaused(bool paused) external onlyRole(SETTINGS_MANAGER_ROLE) {
    mintPaused = paused;
    emit MintPauseChanged(paused);
  }

  /// @dev Swtiches redeem pause state
  function setRedeemPaused(bool paused) external onlyRole(SETTINGS_MANAGER_ROLE) {
    redeemPaused = paused;
    emit RedeemPauseChanged(paused);
  }

  /// @dev Switches cross-chain operations pause state
  function setCrossChainPaused(bool paused) external onlyRole(SETTINGS_MANAGER_ROLE) {
    crossChainPaused = paused;
    emit CrossChainPauseChanged(paused);
  }

  /// @dev Sets percent in basis points of Token that will be taken as a fee on mint
  function setMintFeeBP(uint16 value) external onlyRole(SETTINGS_MANAGER_ROLE) {
    // No more than 50%
    if (value > MAX_BPS / 2) {
      revert InvalidPercentBP(value);
    }
    mintFeeBP = value;
    emit SetMintFeeBP(value);
  }

  /// @dev Sets percent in basis points of Token that will be taken as a fee on redeem
  function setRedeemFeeBP(uint16 value) external onlyRole(SETTINGS_MANAGER_ROLE) {
    // No more than 50%
    if (value > MAX_BPS / 2) {
      revert InvalidPercentBP(value);
    }
    redeemFeeBP = value;
    emit SetRedeemFeeBP(value);
  }

  /// @dev Sets mint limit period duration and maximum amount
  function setMintLimits(uint32 periodDuration, uint256 maxPeriodAmount) external onlyRole(SETTINGS_MANAGER_ROLE) {
    mintLimit.periodDuration = periodDuration;
    mintLimit.maxPeriodAmount = maxPeriodAmount;
    emit SetMintLimits(periodDuration, maxPeriodAmount);
  }

  /// @dev Sets redeem limit period duration and maximum amount
  function setRedeemLimits(uint32 periodDuration, uint256 maxPeriodAmount) external onlyRole(SETTINGS_MANAGER_ROLE) {
    redeemLimit.periodDuration = periodDuration;
    redeemLimit.maxPeriodAmount = maxPeriodAmount;
    emit SetRedeemLimits(periodDuration, maxPeriodAmount);
  }

  /// @dev Sets Chainlink feed heartbeat for asset
  function setChainlinkAssetHeartbeat(address asset, uint32 heartbeat) external onlyRole(SETTINGS_MANAGER_ROLE) onlySupportedAsset(asset) {
    chainlinkAssetHeartbeat[asset] = heartbeat;
    emit SetChainlinkAssetHeartbeat(asset, heartbeat);
  }

  /// @dev Adds an asset to supporetd assets list
  function addSupportedAsset(address asset, uint32 hearbeat) public onlyRole(DEFAULT_ADMIN_ROLE) {
    _addSupportedAsset(asset, hearbeat);
  }

  /// @dev Removes an asset from supported assets list
  function removeSupportedAsset(address asset) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!_supportedAssets.remove(asset)) {
      revert InvalidAssetAddress(asset);
    }
    chainlinkAssetHeartbeat[asset] = 0;
    emit AssetRemoved(asset);
  }

  /// @dev Checks if an asset is supported
  function isSupportedAsset(address asset) public view returns (bool) {
    return _supportedAssets.contains(asset);
  }

  /// @dev Adds custodian to custodians address list
  function addCustodianAddress(address custodian) public onlyRole(DEFAULT_ADMIN_ROLE) {
    _addCustodianAddress(custodian);
  }

  /// @dev Removes custodian from custodians address list
  function removeCustodianAddress(address custodian) external onlyRole(DEFAULT_ADMIN_ROLE) {
    if (!_custodianAddresses.remove(custodian)) {
      revert InvalidCustodianAddress(custodian);
    }
    emit CustodianAddressRemoved(custodian);
  }



  /// @dev Freeze asset funds and prevent them from transferring to custodians or users
  function freezeFunds(address asset, uint256 amount) external onlyRole(FUNDS_MANAGER_ROLE) onlySupportedAsset(asset) {
    if (assetFrozenFunds[asset] + amount > IERC20(asset).balanceOf(address(this))) {
      revert InvalidAmount();
    }

    assetFrozenFunds[asset] += amount;

    emit FreezeFunds(asset, amount);
  }

  /// @dev Unfreeze asset funds and allow them for transferring to custodians or users
  function unfreezeFunds(address asset, uint256 amount) external onlyRole(FUNDS_MANAGER_ROLE) onlySupportedAsset(asset) {
    if (amount > assetFrozenFunds[asset]) {
      revert InvalidAmount();
    }

    assetFrozenFunds[asset] -= amount;

    emit UnfreezeFunds(asset, amount);
  }

  /// @dev Return cached value if chainId matches cache, otherwise recomputes separator
  /// @return The domain separator at current chain
  function getDomainSeparator() public view returns (bytes32) {
    if (block.chainid == _chainId) {
      return _domainSeparator;
    }
    return _computeDomainSeparator();
  }

  /// @dev verify validity of nonce by checking its presence
  function verifyNonce(address sender, uint256 nonce) public view returns (uint256, uint256, uint256) {
    if (nonce == 0) revert InvalidNonce();
    uint256 invalidatorSlot = nonce >> 8;
    uint256 invalidatorBit = 1 << uint8(nonce);
    uint256 invalidator = _orderBitmaps[sender][invalidatorSlot];
    if (invalidator & invalidatorBit != 0) revert InvalidNonce();

    return (invalidatorSlot, invalidator, invalidatorBit);
  }

  /// @dev deduplication of user order
  function _deduplicateOrder(address sender, uint256 nonce) private {
    (uint256 invalidatorSlot, uint256 invalidator, uint256 invalidatorBit) = verifyNonce(sender, nonce);
    _orderBitmaps[sender][invalidatorSlot] = invalidator | invalidatorBit;
  }

  function _addSupportedAsset(address asset, uint32 heartbeat) internal {
    if (asset == address(0) || asset == address(token) || !_supportedAssets.add(asset)) {
      revert InvalidAssetAddress(asset);
    }
    require(IERC20Metadata(asset).decimals() <= 18, "Unsupported decimals");
    chainlinkAssetHeartbeat[asset] = heartbeat;
    emit AssetAdded(asset, heartbeat);
  }

  function _addCustodianAddress(address custodian) internal {
    if (custodian == address(0) || custodian == address(token) || !_custodianAddresses.add(custodian)) {
      revert InvalidCustodianAddress(custodian);
    }
    emit CustodianAddressAdded(custodian);
  }

  function _setCrossChainOperator(address _operator) internal {
    _crossChainOperatorAddress = _operator;
    emit SetCrossChainOperator(_crossChainOperatorAddress);
  }

  function _setInsuranceFundAddress(address _insuranceFundAddress) internal {
    insuranceFundAddress = _insuranceFundAddress;
    emit SetInsuranceFundAddress(insuranceFundAddress);
  }

  function _setVaultRewardsAddress(IVaultRewards _aegisRewards) internal {
    if (address(_aegisRewards) != address(0) && address(_aegisRewards).code.length == 0) revert InvalidAddress();
    aegisRewards = _aegisRewards;
    emit SetVaultRewardsAddress(address(aegisRewards));
  }

  function _setVaultOracleAddress(AggregatorV3Interface _aegisOracle) internal {
    aegisOracle = _aegisOracle;
    emit SetVaultOracleAddress(address(aegisOracle));
  }

  function _setVaultConfigAddress(IVaultConfig _config) internal {
    if (address(_config) != address(0) && !IERC165(address(_config)).supportsInterface(type(IVaultConfig).interfaceId)) {
      revert InvalidAddress();
    }

    aegisConfig = _config;
    emit SetVaultConfigAddress(address(_config));
  }

  function _setFeedRegistryAddress(FeedRegistryInterface _registry) internal {
    _feedRegistry = _registry;
    emit SetFeedRegistryAddress(address(_registry));
  }

  function _rejectRedeemRequest(string calldata requestId, RedeemRequest storage request) internal {
    request.status = RedeemRequestStatus.REJECTED;

    // Unlock Token
    totalRedeemLockedToken -= request.order.tokenAmount;
    token.safeTransfer(request.order.userWallet, request.order.tokenAmount);

    emit RejectRedeemRequest(requestId, _msgSender(), request.order.userWallet, request.order.tokenAmount);
  }

  function _custodyAvailableAssetBalance(address _asset) internal view returns (uint256) {
    uint256 custodyTransferrableFunds = _custodyTransferrableAssetFunds[_asset];
    uint256 balance = IERC20(_asset).balanceOf(address(this));
    if (balance < custodyTransferrableFunds || custodyTransferrableFunds < assetFrozenFunds[_asset]) {
      return 0;
    }

    return custodyTransferrableFunds - assetFrozenFunds[_asset];
  }

  function _untrackedAvailableAssetBalance(address _asset) internal view returns (uint256) {
    uint256 balance = IERC20(_asset).balanceOf(address(this));
    if (balance < _custodyTransferrableAssetFunds[_asset] + assetFrozenFunds[_asset]) {
      return 0;
    }

    return balance - _custodyTransferrableAssetFunds[_asset] - assetFrozenFunds[_asset];
  }

  function _calculateInsuranceFundFeeFromAmount(uint256 amount, uint16 feeBP) internal view returns (uint256, uint256) {
    if (insuranceFundAddress == address(0) || feeBP == 0) {
      return (amount, 0);
    }

    uint256 fee = (amount * feeBP) / MAX_BPS;

    return (amount - fee, fee);
  }

  /// @notice Gross token quote before mint fees. Prices are validated, never treated as zero.
  function quoteMint(address asset, uint256 amount) public view onlySupportedAsset(asset) returns (uint256) {
    (uint256 price, uint8 precision) = _getAssetTokenPriceOracle(asset);
    return Math.mulDiv(amount, price * 10 ** (18 - IERC20Metadata(asset).decimals()), 10 ** precision);
  }

  function quoteRedeem(address asset, uint256 amount) public view onlySupportedAsset(asset) returns (uint256) {
    (uint256 price, uint8 precision) = _getAssetTokenPriceOracle(asset);
    return Math.mulDiv(amount, 10 ** precision, price * 10 ** (18 - IERC20Metadata(asset).decimals()));
  }

  function _calculateMinTokenAmount(address asset, uint256 amount, uint256 signedAmount) internal view returns (uint256) {
    return Math.min(signedAmount, quoteMint(asset, amount));
  }

  function _calculateRedeemMinCollateralAmount(address asset, uint256 collateralAmount, uint256 tokenAmount) internal view returns (uint256) {
    return Math.min(collateralAmount, quoteRedeem(asset, tokenAmount));
  }

  function _checkMintRedeemLimit(MintRedeemLimit storage limits, uint256 tokenAmount) internal {
    if (limits.periodDuration == 0 || limits.maxPeriodAmount == 0) {
      return;
    }
    uint256 currentPeriodEndTime = limits.currentPeriodStartTime + limits.periodDuration;
    if (
      (currentPeriodEndTime >= block.timestamp && limits.currentPeriodTotalAmount + tokenAmount > limits.maxPeriodAmount) ||
      (currentPeriodEndTime < block.timestamp && tokenAmount > limits.maxPeriodAmount)
    ) {
      revert LimitReached();
    }
    // Start new mint period
    if (currentPeriodEndTime <= block.timestamp) {
      limits.currentPeriodStartTime = uint32(block.timestamp);
      limits.currentPeriodTotalAmount = 0;
    }

    limits.currentPeriodTotalAmount += tokenAmount;
  }

  function setAssetPriceFeed(address asset, AggregatorV3Interface feed) external onlyRole(SETTINGS_MANAGER_ROLE) onlySupportedAsset(asset) {
    if (address(feed) != address(0) && address(feed).code.length == 0) revert InvalidAddress();
    assetPriceFeeds[asset] = feed;
    emit AssetPriceFeedSet(asset, address(feed));
  }

  function setOracleHeartbeat(uint32 heartbeat) external onlyRole(SETTINGS_MANAGER_ROLE) {
    require(heartbeat > 0, "Invalid heartbeat");
    oracleHeartbeat = heartbeat;
    emit OracleHeartbeatSet(heartbeat);
  }

  function _validatedPrice(int256 answer, uint256 updatedAt, uint80 round, uint80 answeredRound, uint32 heartbeat, uint8 precision) internal view returns (uint256) {
    if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > heartbeat || answeredRound < round || precision > 18) revert InvalidPrice();
    // Normalize every feed to 18 decimals, including registry feeds with differing precision.
    return uint256(answer) * 10 ** (18 - precision);
  }

  function _getAssetUSDPriceChainlink(address asset) internal view returns (uint256, uint8) {
    AggregatorV3Interface feed = assetPriceFeeds[asset];
    if (address(feed) != address(0)) {
      (uint80 round, int256 answer, , uint256 updatedAt, uint80 answeredRound) = feed.latestRoundData();
      return (_validatedPrice(answer, updatedAt, round, answeredRound, chainlinkAssetHeartbeat[asset], feed.decimals()), 18);
    }
    if (address(_feedRegistry) == address(0)) revert InvalidPrice();
    (uint80 round, int256 answer, , uint256 updatedAt, uint80 answeredRound) = _feedRegistry.latestRoundData(asset, Denominations.USD);
    return (_validatedPrice(answer, updatedAt, round, answeredRound, chainlinkAssetHeartbeat[asset], _feedRegistry.decimals(asset, Denominations.USD)), 18);
  }

  function _getAssetTokenPriceOracle(address asset) internal view returns (uint256, uint8) {
    if (address(aegisOracle) == address(0)) revert InvalidPrice();
    (uint80 round, int256 answer, , uint256 updatedAt, uint80 answeredRound) = aegisOracle.latestRoundData();
    uint256 tokenPrice = _validatedPrice(answer, updatedAt, round, answeredRound, oracleHeartbeat, aegisOracle.decimals());
    (uint256 assetPrice, ) = _getAssetUSDPriceChainlink(asset);
    uint256 price = Math.mulDiv(assetPrice, 1e18, tokenPrice);
    if (price == 0) revert InvalidPrice();
    return (price, 18);
  }

  function _computeDomainSeparator() internal view returns (bytes32) {
    return keccak256(abi.encode(EIP712_DOMAIN, EIP712_NAME, EIP712_REVISION, block.chainid, address(this)));
  }
}
