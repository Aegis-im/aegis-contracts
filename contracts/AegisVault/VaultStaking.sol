// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { VaultStakingSilo } from "./VaultStakingSilo.sol";

/// @notice Configurable staking vault derived from the existing staking infrastructure.
/// Standard ERC-4626 exits are immediate and include the configured fee in previews.
/// The optional cooldown path escrows base tokens in a silo and has no exit fee.
contract VaultStaking is ERC4626Upgradeable, ERC20PermitUpgradeable, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    uint24 public constant MAX_COOLDOWN_DURATION = 90 days;
    uint24 public cooldownDuration;
    uint16 public instantUnstakingFeeBP;
    address public insuranceFund;
    VaultStakingSilo public silo;
    struct Cooldown { uint256 cooldownEnd; uint256 underlyingAmount; }
    mapping(address => Cooldown) public cooldowns;
    event CooldownStarted(address indexed owner, uint256 assets, uint256 shares, uint256 cooldownEnd);
    event Unstaked(address indexed owner, address indexed receiver, uint256 assets);
    event ExitFeePaid(address indexed owner, uint256 fee);
    event CooldownDurationUpdated(uint24 duration);
    event InstantUnstakingFeeUpdated(uint16 feeBP);
    event InsuranceFundUpdated(address fund);
    error InvalidSettings();
    error CooldownNotEnded();
    error InvalidAmount();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address token, address admin, string memory name_, string memory symbol_, uint24 cooldown_, uint16 feeBP_, address fund_) external initializer {
        if (token == address(0) || admin == address(0) || fund_ == address(0) || cooldown_ > MAX_COOLDOWN_DURATION || feeBP_ >= 10000) revert InvalidSettings();
        __ERC20_init(name_, symbol_);
        __ERC4626_init(IERC20(token));
        __ERC20Permit_init(name_);
        __AccessControl_init();
        __ReentrancyGuard_init();
        silo = new VaultStakingSilo(address(this), token);
        cooldownDuration = cooldown_;
        instantUnstakingFeeBP = feeBP_;
        insuranceFund = fund_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    function decimals() public view override(ERC4626Upgradeable, ERC20Upgradeable) returns (uint8) { return super.decimals(); }
    function setCooldownDuration(uint24 value) external onlyRole(ADMIN_ROLE) {
        if (value > MAX_COOLDOWN_DURATION) revert InvalidSettings();
        cooldownDuration = value;
        emit CooldownDurationUpdated(value);
    }
    function setInstantUnstakingFee(uint16 value) external onlyRole(ADMIN_ROLE) {
        if (value >= 10000) revert InvalidSettings();
        instantUnstakingFeeBP = value;
        emit InstantUnstakingFeeUpdated(value);
    }
    function setInsuranceFund(address value) external onlyRole(ADMIN_ROLE) {
        if (value == address(0) || value == address(this) || value == address(silo)) revert InvalidSettings();
        insuranceFund = value;
        emit InsuranceFundUpdated(value);
    }
    function _feeBP() internal view returns (uint256) { return cooldownDuration == 0 ? 0 : instantUnstakingFeeBP; }
    function _gross(uint256 net) internal view returns (uint256) { return Math.mulDiv(net, 10000, 10000 - _feeBP(), Math.Rounding.Ceil); }
    function _net(uint256 gross) internal view returns (uint256) { return Math.mulDiv(gross, 10000 - _feeBP(), 10000); }

    function previewWithdraw(uint256 assets) public view override returns (uint256) { return super.previewWithdraw(_gross(assets)); }
    function previewRedeem(uint256 shares) public view override returns (uint256) { return _net(super.previewRedeem(shares)); }
    function maxWithdraw(address owner) public view override returns (uint256) { return previewRedeem(balanceOf(owner)); }

    function deposit(uint256 assets, address receiver) public override nonReentrant returns (uint256) { return super.deposit(assets, receiver); }
    function mint(uint256 shares, address receiver) public override nonReentrant returns (uint256) { return super.mint(shares, receiver); }
    function withdraw(uint256 assets, address receiver, address owner) public override nonReentrant returns (uint256 shares) {
        uint256 maximum = maxWithdraw(owner);
        if (assets > maximum) revert ERC4626ExceededMaxWithdraw(owner, assets, maximum);
        uint256 gross = _gross(assets);
        shares = super.previewWithdraw(gross);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
        _payFee(owner, gross - assets);
    }
    function redeem(uint256 shares, address receiver, address owner) public override nonReentrant returns (uint256 assets) {
        uint256 maximum = maxRedeem(owner);
        if (shares > maximum) revert ERC4626ExceededMaxRedeem(owner, shares, maximum);
        uint256 gross = super.previewRedeem(shares);
        assets = _net(gross);
        _withdraw(_msgSender(), receiver, owner, assets, shares);
        _payFee(owner, gross - assets);
    }
    function _payFee(address owner, uint256 fee) internal {
        if (fee > 0) { IERC20(asset()).safeTransfer(insuranceFund, fee); emit ExitFeePaid(owner, fee); }
    }
    function cooldownAssets(uint256 assets, address owner) external nonReentrant returns (uint256 shares) {
        if (msg.sender != owner || assets == 0 || cooldownDuration == 0) revert InvalidAmount();
        shares = super.previewWithdraw(assets);
        _withdraw(msg.sender, address(silo), owner, assets, shares);
        _recordCooldown(owner, assets, shares);
    }
    function cooldownShares(uint256 shares, address owner) external nonReentrant returns (uint256 assets) {
        if (msg.sender != owner || shares == 0 || cooldownDuration == 0) revert InvalidAmount();
        assets = super.previewRedeem(shares);
        _withdraw(msg.sender, address(silo), owner, assets, shares);
        _recordCooldown(owner, assets, shares);
    }
    function _recordCooldown(address owner, uint256 assets, uint256 shares) internal {
        Cooldown storage c = cooldowns[owner];
        c.cooldownEnd = block.timestamp + cooldownDuration;
        c.underlyingAmount += assets;
        emit CooldownStarted(owner, assets, shares, c.cooldownEnd);
    }
    function unstake(address receiver) external nonReentrant {
        Cooldown storage c = cooldowns[msg.sender];
        if (block.timestamp < c.cooldownEnd && cooldownDuration != 0) revert CooldownNotEnded();
        uint256 assets = c.underlyingAmount;
        if (receiver == address(0) || assets == 0) revert InvalidAmount();
        delete cooldowns[msg.sender];
        silo.withdraw(receiver, assets);
        emit Unstaked(msg.sender, receiver, assets);
    }
    function rescueTokens(address token, uint256 amount, address receiver) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == asset() || token == address(0) || receiver == address(0)) revert InvalidSettings();
        IERC20(token).safeTransfer(receiver, amount);
    }
}
