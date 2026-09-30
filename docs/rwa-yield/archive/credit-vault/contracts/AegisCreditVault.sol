// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ICreditVaultEligibility {
  function whitelistEnabled() external view returns (bool);
  function isWhitelisted(address account) external view returns (bool);
}

/// @notice Synchronous ERC-4626 subscriptions and ERC-7540 asynchronous redemptions.
/// @dev Six-decimal exact-transfer USDC only. NAV is trusted manager accounting, not an oracle.
///      Pending shares earn/lose value until fulfillment; funded claims are excluded from active NAV.
contract AegisCreditVault is ERC4626, AccessControl, Pausable, ReentrancyGuard {
  using SafeERC20 for IERC20;
  bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
  bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
  uint256 public constant REDEMPTION_COOLDOWN = 30 days;
  ICreditVaultEligibility public aegisConfig;
  mapping(address => bool) public isBlackListed;
  address public immutable counterparty;
  uint256 public liquidAssets;
  uint256 public reportedExternalAssets;
  uint256 public claimReserves;
  uint256 public lastReportAt;

  struct Redemption {
    uint256 pendingShares;
    uint256 claimableShares;
    uint256 claimableAssets;
    uint256 readyAt;
  }
  mapping(address => Redemption) public redemptions;
  mapping(address => mapping(address => bool)) public isOperator;

  error Blacklisted(address account);
  error InvalidConfiguration();
  error Ineligible();
  error InvalidAmount();
  error InsufficientLiquidity();
  error PendingRequestExists();
  error TooEarly();
  error Unauthorized();
  error AsyncPreview();
  error UnsupportedAsset();

  event SetConfig(address indexed newConfig, address indexed oldConfig);
  event AddedBlackList(address user);
  event RemovedBlackList(address user);

  event RedeemRequest(address indexed controller, address indexed owner, uint256 indexed requestId, address sender, uint256 shares);
  event OperatorSet(address indexed controller, address indexed operator, bool approved);
  event RedeemFulfilled(address indexed controller, uint256 shares, uint256 assets);
  event NAVReported(uint256 previousNAV, uint256 newNAV);
  event ExternalAssetsReported(uint256 previousValue, uint256 newValue);
  event CounterpartyFunded(uint256 assets);
  event LiquidityReturned(uint256 assets);

  constructor(address asset_, address config_, address counterparty_, address admin_, address manager_)
    ERC20("Aegis Credit Yield", "acUSDC") ERC4626(IERC20(asset_))
  {
    if (asset_ == address(0) || config_ == address(0) || counterparty_ == address(0) ||
      admin_ == address(0) || manager_ == address(0)) revert InvalidConfiguration();
    if (IERC20Metadata(asset_).decimals() != 6) revert UnsupportedAsset();
    _setConfig(config_);
    counterparty = counterparty_;
    _grantRole(DEFAULT_ADMIN_ROLE, admin_);
    _grantRole(GUARDIAN_ROLE, admin_);
    _grantRole(MANAGER_ROLE, manager_);
  }

  function setConfig(address config_) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setConfig(config_);
  }
  function _setConfig(address config_) private {
    if (config_ == address(0) || config_.code.length == 0) revert InvalidConfiguration();
    ICreditVaultEligibility next = ICreditVaultEligibility(config_);
    next.whitelistEnabled();
    next.isWhitelisted(address(this));
    emit SetConfig(config_, address(aegisConfig));
    aegisConfig = next;
  }
  function getBlackListStatus(address account) external view returns (bool) { return isBlackListed[account]; }
  function addBlackList(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    isBlackListed[account] = true;
    emit AddedBlackList(account);
  }
  function removeBlackList(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
    isBlackListed[account] = false;
    emit RemovedBlackList(account);
  }
  function _checkBlacklist(address from, address to) private view {
    if (isBlackListed[from]) revert Blacklisted(from);
    if (isBlackListed[to]) revert Blacklisted(to);
  }

  function share() external view returns (address) { return address(this); }
  function supportsInterface(bytes4 id) public view override returns (bool) {
    return id == 0xe3bc4e65 || id == 0x2f0a18c5 || id == 0x620ee8e4 || super.supportsInterface(id);
  }
  /// @notice Admission uses only the local blacklist; shared config membership is not enforced.
  function isEligible(address account) public view returns (bool) {
    return account != address(0) && account != address(this) && !isBlackListed[account];
  }
  function totalAssets() public view override returns (uint256) { return liquidAssets + reportedExternalAssets; }
  function _decimalsOffset() internal pure override returns (uint8) { return 12; }
  function maxDeposit(address receiver) public view override returns (uint256) {
    if (paused() || !isEligible(receiver) || (totalSupply() != 0 && totalAssets() == 0)) return 0;
    return type(uint256).max;
  }
  function maxMint(address receiver) public view override returns (uint256) { return maxDeposit(receiver); }
  function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) {
    return super.deposit(assets, receiver);
  }
  function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) {
    return super.mint(shares, receiver);
  }
  // Operator overloads: assets are pulled from the controller, using its USDC approval to the vault.
  function deposit(uint256 assets, address receiver, address controller) external nonReentrant returns (uint256 shares) {
    _authorize(controller);
    if (assets > maxDeposit(receiver)) revert ERC4626ExceededMaxDeposit(receiver, assets, maxDeposit(receiver));
    shares = previewDeposit(assets);
    _deposit(controller, receiver, assets, shares);
  }
  function mint(uint256 shares, address receiver, address controller) external nonReentrant returns (uint256 assets) {
    _authorize(controller);
    if (shares > maxMint(receiver)) revert ERC4626ExceededMaxMint(receiver, shares, maxMint(receiver));
    assets = previewMint(shares);
    _deposit(controller, receiver, assets, shares);
  }
  function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override whenNotPaused {
    _checkBlacklist(caller, receiver);
    if (!isEligible(caller) || !isEligible(receiver)) revert Ineligible();
    if (assets == 0 || shares == 0) revert InvalidAmount();
    _receive(caller, assets);
    liquidAssets += assets;
    _mint(receiver, shares);
    emit Deposit(caller, receiver, assets, shares);
  }

  function setOperator(address operator, bool approved) external returns (bool) {
    isOperator[msg.sender][operator] = approved;
    emit OperatorSet(msg.sender, operator, approved);
    return true;
  }
  /// @dev Request ID is always zero. One pending request per controller prevents cooldown resets/griefing.
  function requestRedeem(uint256 shares, address controller, address owner) external nonReentrant whenNotPaused returns (uint256) {
    _checkBlacklist(owner, controller);
    _checkBlacklist(owner, address(this));
    if (!isEligible(owner) || !isEligible(controller)) revert Ineligible();
    if (shares == 0) revert InvalidAmount();
    if (controller != owner) _authorize(controller);
    if (msg.sender != owner && !isOperator[owner][msg.sender]) _spendAllowance(owner, msg.sender, shares);
    Redemption storage r = redemptions[controller];
    if (r.pendingShares != 0) revert PendingRequestExists();
    r.pendingShares = shares;
    r.readyAt = block.timestamp + REDEMPTION_COOLDOWN;
    // Direct internal update avoids admitting ordinary transfers into the escrow address.
    super._update(owner, address(this), shares);
    emit RedeemRequest(controller, owner, 0, msg.sender, shares);
    return 0;
  }
  function pendingRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
    return requestId == 0 ? redemptions[controller].pendingShares : 0;
  }
  function claimableRedeemRequest(uint256 requestId, address controller) external view returns (uint256) {
    return requestId == 0 ? redemptions[controller].claimableShares : 0;
  }
  /// @notice Anyone may fund a matured request. Cooldown alone never promises available liquidity.
  function fulfillRedeem(address controller) external nonReentrant whenNotPaused {
    _checkBlacklist(controller, address(this));
    Redemption storage r = redemptions[controller];
    uint256 shares = r.pendingShares;
    if (shares == 0) revert InvalidAmount();
    if (block.timestamp < r.readyAt) revert TooEarly();
    uint256 assets = totalAssets() == 0 ? 0 : convertToAssets(shares);
    if (assets > liquidAssets) revert InsufficientLiquidity();
    r.pendingShares = 0;
    r.readyAt = 0;
    r.claimableShares += shares;
    r.claimableAssets += assets;
    liquidAssets -= assets;
    claimReserves += assets;
    _burn(address(this), shares);
    emit RedeemFulfilled(controller, shares, assets);
  }
  function maxRedeem(address controller) public view override returns (uint256) { return redemptions[controller].claimableShares; }
  function maxWithdraw(address controller) public view override returns (uint256) { return redemptions[controller].claimableAssets; }
  function previewRedeem(uint256) public pure override returns (uint256) { revert AsyncPreview(); }
  function previewWithdraw(uint256) public pure override returns (uint256) { revert AsyncPreview(); }
  function redeem(uint256 shares, address receiver, address controller) public override nonReentrant returns (uint256 assets) {
    _authorize(controller);
    Redemption storage r = redemptions[controller];
    if (shares == 0 || shares > r.claimableShares) revert InvalidAmount();
    assets = Math.mulDiv(shares, r.claimableAssets, r.claimableShares);
    _claim(r, controller, receiver, shares, assets);
  }
  function withdraw(uint256 assets, address receiver, address controller) public override nonReentrant returns (uint256 shares) {
    _authorize(controller);
    Redemption storage r = redemptions[controller];
    if (assets == 0 || assets > r.claimableAssets) revert InvalidAmount();
    shares = Math.mulDiv(assets, r.claimableShares, r.claimableAssets, Math.Rounding.Ceil);
    // If rounding consumes the last share, only a full cash claim may consume it.
    if (shares == r.claimableShares && assets != r.claimableAssets) revert InvalidAmount();
    _claim(r, controller, receiver, shares, assets);
  }
  function _claim(Redemption storage r, address controller, address receiver, uint256 shares, uint256 assets) private {
    _checkBlacklist(controller, receiver);
    if (receiver == address(0) || receiver == address(this)) revert Ineligible();
    // Non-blacklisted controllers may recover funded cash, including while paused.
    if (receiver != controller && !isEligible(receiver)) revert Ineligible();
    r.claimableShares -= shares;
    r.claimableAssets -= assets;
    claimReserves -= assets;
    if (assets != 0) IERC20(asset()).safeTransfer(receiver, assets);
    emit Withdraw(msg.sender, receiver, controller, assets, shares);
  }

  /// @notice Report only the counterparty portfolio value in USDC units, excluding vault cash and claim reserves.
  /// @dev Funding/returns change external book value too; reconcile them before submitting a valuation.
  function reportExternalAssets(uint256 value) external onlyRole(MANAGER_ROLE) nonReentrant {
    // Preserve room for both active cash and ERC-4626's virtual asset.
    if (value >= type(uint256).max - liquidAssets) revert InvalidAmount();
    uint256 previous = reportedExternalAssets;
    reportedExternalAssets = value;
    lastReportAt = block.timestamp;
    emit ExternalAssetsReported(previous, value);
  }

  /// @notice Legacy total-NAV reporting. Prefer reportExternalAssets to avoid dependence on changing cash balances.
  /// @notice Report total active NAV in USDC units, excluding funded claim reserves.
  /// @dev Must include existing cash. Reports affect deposits and pending exits immediately.
  function reportNAV(uint256 nav) external onlyRole(MANAGER_ROLE) nonReentrant {
    if (nav < liquidAssets || nav == type(uint256).max) revert InvalidAmount();
    uint256 previous = totalAssets();
    reportedExternalAssets = nav - liquidAssets;
    lastReportAt = block.timestamp;
    emit NAVReported(previous, nav);
  }
  function fundCounterparty(uint256 assets) external onlyRole(MANAGER_ROLE) nonReentrant whenNotPaused {
    if (assets == 0) revert InvalidAmount();
    if (assets > liquidAssets) revert InsufficientLiquidity();
    liquidAssets -= assets;
    reportedExternalAssets += assets;
    IERC20(asset()).safeTransfer(counterparty, assets);
    emit CounterpartyFunded(assets);
  }
  /// @notice Convert reported external value back to cash without counting it twice as yield.
  /// @dev Report accrued yield before returning cash. Return cannot exceed external book value.
  function returnLiquidity(uint256 assets) external nonReentrant {
    if (msg.sender != counterparty && !hasRole(MANAGER_ROLE, msg.sender)) revert Unauthorized();
    if (assets == 0 || assets > reportedExternalAssets) revert InvalidAmount();
    reportedExternalAssets -= assets;
    liquidAssets += assets;
    _receive(msg.sender, assets);
    emit LiquidityReturned(assets);
  }
  function pause() external onlyRole(GUARDIAN_ROLE) { _pause(); }
  function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) { _unpause(); }
  function _authorize(address controller) private view {
    if (msg.sender != controller && !isOperator[controller][msg.sender]) revert Unauthorized();
  }
  function _update(address from, address to, uint256 value) internal override {
    _checkBlacklist(from, to);
    if (from != address(0) && to != address(0)) {
      _requireNotPaused();
      if (to == address(this)) revert Ineligible();
    }
    super._update(from, to, value);
  }
  function _receive(address from, uint256 assets) private {
    IERC20 token = IERC20(asset());
    uint256 beforeBalance = token.balanceOf(address(this));
    token.safeTransferFrom(from, address(this), assets);
    if (token.balanceOf(address(this)) != beforeBalance + assets) revert UnsupportedAsset();
  }
}
