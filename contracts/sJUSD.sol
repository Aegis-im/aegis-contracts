// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IYUSD } from "./interfaces/IYUSD.sol";
import { sJUSDSilo } from "./sJUSDSilo.sol";

/**
 * @title sJUSDUpgradeable
 * @dev Staked JUSD (sJUSD) - an interest-bearing token that represents JUSD staked in the protocol.
 * The token's value increases over time relative to YUSD, reflecting staking rewards.
 * Implements ERC4626 Tokenized Vault Standard.
 * 
 * @dev Staking Mechanics:
 * - Users deposit JUSD and receive sJUSD shares in return
 * - The exchange rate between JUSD and sJUSD can increase over time as rewards are added
 * - The value of sJUSD (relative to JUSD) never decreases, making it a yield-bearing asset
 * 
 * @dev Unstaking Process:
 * - 2-step withdrawal process: cooldown, then unstake
 * - Cooldown initiates an unstaking period based on the cooldown duration
 * - Users cannot withdraw their shares until the cooldown period expires
 * - When cooldown duration is set to 0, direct withdrawals are allowed without cooldown
 * 
 * @dev Upgrade Features:
 * - Uses TransparentUpgradeableProxy pattern
 * - The admin role can upgrade the implementation contract
 * - TimelockController is set as the proxy admin to provide time-delayed governance
 * 
 * @dev Security Features:
 * - Based on OpenZeppelin's upgradeable contracts
 * - Admin role is required for changing critical parameters
 * - Rescue function for recovering non-YUSD tokens sent to the contract accidentally
 * - Safeguards against withdrawing during cooldown period
 * 
 * @dev Integration Notes:
 * - Fully compatible with ERC4626 interfaces for better composability
 * - Implements maxWithdraw and maxDeposit to properly communicate withdrawal limitations
 * - Uses ERC20Permit for gasless approvals
 */
contract sJUSD is 
    Initializable, 
    ERC4626Upgradeable, 
    ERC20PermitUpgradeable, 
    AccessControlUpgradeable, 
    ReentrancyGuardUpgradeable
{
    using SafeERC20 for IERC20;
    
    // Constants for roles
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    // Maximum cooldown duration (90 days)
    uint24 public constant MAX_COOLDOWN_DURATION = 90 days;
    
    // Cooldown duration in seconds (7 days by default)
    // When set to 0, cooldown is disabled and direct withdrawals are allowed
    uint24 public cooldownDuration;

    sJUSDSilo public silo;
    
    // Struct to track user cooldown status
    struct Cooldown {
        uint104 cooldownEnd;
        uint152 underlyingAmount;
    }
    
    // Mapping of user address to cooldown status
    mapping(address => Cooldown) public cooldowns;

    // ===== NEW STORAGE VARIABLES (added in upgrade) =====
    // Instant unstaking fee in basis points (0.5% = 50 bps)
    uint16 public INSTANT_UNSTAKING_FEE;
    
    // Insurance fund address
    address public INSURANCE_FUND;

    error InsufficientShares(uint256 requested, uint256 available);
    error CooldownNotEnded();
    error ZeroAddress(string paramName);
    error ZeroAmount();
    error InvalidToken();
    error ExpectedCooldownOn();
    error ExpectedCooldownOff();
    error DurationExceedsMax();
    error DurationNotChanged();
    error InvalidFee();
    error FeeNotChanged();
    error InsuranceFundNotSet();
    error InsuranceFundNotChanged();
    
    event CooldownDurationUpdated(uint24 previousDuration, uint24 newDuration);
    event CooldownStarted(address indexed user, uint256 assets, uint256 shares, uint256 cooldownEnd);
    event Unstaked(address indexed user, address indexed receiver, uint256 assets);
    event InstantUnstakingFeeUpdated(uint16 previousFee, uint16 newFee);
    event InsuranceFundUpdated(address previousFund, address newFund);
    event InstantUnstaking(address indexed user, address indexed receiver, uint256 assets, uint256 fee);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // Modifiers to check cooldown mode
    modifier ensureCooldownOff() {
        if (cooldownDuration > 0) revert ExpectedCooldownOff();
        _;
    }

    modifier ensureCooldownOn() {
        if (cooldownDuration == 0) revert ExpectedCooldownOn();
        _;
    }

    /**
     * @dev Initializer function
     * @param _jusd Address of the JUSD token
     * @param admin Address of the admin
     */
    function initialize(
        address _jusd,
        address admin
    ) public initializer {
        if (_jusd == address(0)) revert ZeroAddress("JUSD");
        if (admin == address(0)) revert ZeroAddress("Admin");

        __ERC20_init("Staked JUSD", "sJUSD");
        __ERC4626_init(IERC20(_jusd));
        __ERC20Permit_init("Staked JUSD");
        __AccessControl_init();
        __ReentrancyGuard_init();

        silo = new sJUSDSilo(address(this), _jusd);
        
        cooldownDuration = 7 days; // Default value

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @dev Override decimals function to resolve conflict between ERC20 and ERC4626
     */
    function decimals() public view virtual override(ERC4626Upgradeable, ERC20Upgradeable) returns (uint8) {
        return super.decimals();
    }

    /**
     * @dev Allows admin to set the cooldown duration
     * @param newDuration New cooldown duration in seconds
     */
    function setCooldownDuration(uint24 newDuration) external onlyRole(ADMIN_ROLE) {
        _setCooldownDuration(newDuration);
    }

    /**
     * @dev Allows admin to set the instant unstaking fee
     * @param newFee New instant unstaking fee in basis points (max 10000 = 100%)
     */
    function setInstantUnstakingFee(uint16 newFee) external onlyRole(ADMIN_ROLE) {
        if (newFee > 10000) revert InvalidFee(); // Max 100%
        if (INSTANT_UNSTAKING_FEE == newFee) revert FeeNotChanged();
        
        uint16 previousFee = INSTANT_UNSTAKING_FEE;
        INSTANT_UNSTAKING_FEE = newFee;
        
        emit InstantUnstakingFeeUpdated(previousFee, newFee);
    }

    /**
     * @dev Allows admin to set the insurance fund address
     * @param newInsuranceFund New insurance fund address
     */
    function setInsuranceFund(address newInsuranceFund) external onlyRole(ADMIN_ROLE) {
        if (newInsuranceFund == address(0)) revert ZeroAddress("insuranceFund");
        if (INSURANCE_FUND == newInsuranceFund) revert InsuranceFundNotChanged();
        
        address previousFund = INSURANCE_FUND;
        INSURANCE_FUND = newInsuranceFund;
        
        emit InsuranceFundUpdated(previousFund, newInsuranceFund);
    }

    /**
     * @dev Initialize new variables added in upgrade (call once after upgrade)
     * @param initialFee Initial instant unstaking fee in basis points (default: 50 = 0.5%)
     * @param initialInsuranceFund Initial insurance fund address
     */
    function initializeV2(uint16 initialFee, address initialInsuranceFund) external onlyRole(ADMIN_ROLE) {
        // Only allow initialization if variables are still at default values
        if (INSTANT_UNSTAKING_FEE != 0 || INSURANCE_FUND != address(0)) {
            revert("Already initialized");
        }
        
        if (initialFee > 10000) revert InvalidFee(); // Max 100%
        if (initialInsuranceFund == address(0)) revert ZeroAddress("insuranceFund");
        
        INSTANT_UNSTAKING_FEE = initialFee;
        INSURANCE_FUND = initialInsuranceFund;
        
        emit InstantUnstakingFeeUpdated(0, initialFee);
        emit InsuranceFundUpdated(address(0), initialInsuranceFund);
    }

    /**
     * @dev Override of withdraw with instant unstaking support
     * @dev When cooldown is enabled, charges INSTANT_UNSTAKING_FEE and transfers fee to INSURANCE_FUND
     * @dev When cooldown is disabled, works as normal withdrawal
     * @inheritdoc ERC4626Upgradeable
     */
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public virtual override returns (uint256) {
        if (cooldownDuration == 0) {
            // Normal withdrawal when cooldown is disabled
            return super.withdraw(assets, receiver, owner);
        } else {
            // Instant unstaking with fee when cooldown is enabled
            return _instantUnstakeAssets(assets, receiver, owner);
        }
    }

    /**
     * @dev Override of redeem with instant unstaking support
     * @dev When cooldown is enabled, charges INSTANT_UNSTAKING_FEE and transfers fee to INSURANCE_FUND
     * @dev When cooldown is disabled, works as normal redemption
     * @inheritdoc ERC4626Upgradeable
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    ) public virtual override returns (uint256) {
        if (cooldownDuration == 0) {
            // Normal redemption when cooldown is disabled
            return super.redeem(shares, receiver, owner);
        } else {
            // Instant unstaking with fee when cooldown is enabled
            return _instantUnstakeShares(shares, receiver, owner);
        }
    }

    /**
     * @dev Step 1: Cooldown assets to initiate the unstaking process
     * @param assets Amount of assets to unstake
     * @param owner Address of the owner
     * @return shares Amount of shares burned
     */
    function cooldownAssets(uint256 assets, address owner) external ensureCooldownOn returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (owner != msg.sender) revert("Only owner can initiate cooldown");
        
        cooldowns[owner].cooldownEnd = uint104(block.timestamp) + cooldownDuration;
        cooldowns[owner].underlyingAmount += uint152(assets);

        shares = super.withdraw(assets, address(silo), owner);
        
        emit CooldownStarted(owner, assets, shares, cooldowns[owner].cooldownEnd);
        
        return shares;
    }

    /**
     * @dev Step 1: Cooldown shares to initiate the unstaking process
     * @param shares Amount of shares to unstake
     * @param owner Address of the owner
     * @return assets Amount of underlying assets
     */
    function cooldownShares(uint256 shares, address owner) external ensureCooldownOn returns (uint256 assets) {        
        if (shares == 0) revert ZeroAmount();
        if (owner != msg.sender) revert("Only owner can initiate cooldown");
        
        assets = super.redeem(shares, address(silo), owner);

        cooldowns[owner].cooldownEnd = uint104(block.timestamp) + cooldownDuration;
        cooldowns[owner].underlyingAmount += uint152(assets);
        
        emit CooldownStarted(owner, assets, shares, cooldowns[owner].cooldownEnd);
        
        return assets;
    }

    /**
     * @dev Step 2: Unstake after cooldown period has ended
     * @param receiver Address to receive the assets
     */
    function unstake(address receiver) external nonReentrant {        
        if (receiver == address(0)) revert ZeroAddress("receiver");
        
        Cooldown storage cooldown = cooldowns[msg.sender];
        uint256 assets = cooldown.underlyingAmount;
        
        if (block.timestamp >= cooldown.cooldownEnd || cooldownDuration == 0) {
            cooldown.cooldownEnd = 0;
            cooldown.underlyingAmount = 0;

            silo.withdraw(receiver, assets);
        } else {
            revert CooldownNotEnded();
        }
        
        emit Unstaked(msg.sender, receiver, assets);
    }

    /**
     * @dev Gets the cooldown status for a user
     * @param user Address of the user
     * @return cooldownEnd Timestamp when cooldown ends
     * @return underlyingAmount Amount of underlying assets in cooldown
     */
    function getUserCooldownStatus(address user) external view returns (uint256 cooldownEnd, uint256 underlyingAmount) {
        Cooldown storage cooldown = cooldowns[user];
        return (cooldown.cooldownEnd, cooldown.underlyingAmount);
    }

    /**
     * @dev Internal function to set cooldown duration with validation
     */
    function _setCooldownDuration(uint24 newDuration) internal {
        uint24 previousDuration = cooldownDuration;
        if (previousDuration == newDuration) revert DurationNotChanged();
        if (newDuration > MAX_COOLDOWN_DURATION) revert DurationExceedsMax();

        cooldownDuration = newDuration;
        emit CooldownDurationUpdated(previousDuration, newDuration);
    }

    /**
     * @dev Internal function for instant unstaking by assets with fee
     * @param assets Amount of assets to withdraw
     * @param receiver Address to receive the assets (minus fee)
     * @param owner Address of the owner of shares
     * @return shares Amount of shares burned
     */
    function _instantUnstakeAssets(uint256 assets, address receiver, address owner) internal returns (uint256 shares) {
        if (INSURANCE_FUND == address(0)) revert InsuranceFundNotSet();
        
        // Calculate fee and net assets
        uint256 fee = (assets * INSTANT_UNSTAKING_FEE) / 10000;
        uint256 netAssets = assets - fee;
        
        // Perform the withdrawal to get the total assets
        shares = super.withdraw(assets, address(this), owner);
        
        // Transfer fee to insurance fund
        if (fee > 0) {
            IERC20(asset()).safeTransfer(INSURANCE_FUND, fee);
        }
        
        // Transfer remaining assets to receiver
        IERC20(asset()).safeTransfer(receiver, netAssets);
        
        emit InstantUnstaking(owner, receiver, netAssets, fee);
        
        return shares;
    }

    /**
     * @dev Internal function for instant unstaking by shares with fee
     * @param shares Amount of shares to redeem
     * @param receiver Address to receive the assets (minus fee)
     * @param owner Address of the owner of shares
     * @return assets Amount of net assets transferred to receiver (after fee)
     */
    function _instantUnstakeShares(uint256 shares, address receiver, address owner) internal returns (uint256 assets) {
        if (INSURANCE_FUND == address(0)) revert InsuranceFundNotSet();
        
        // Perform the redemption to get total assets
        uint256 totalAssets = super.redeem(shares, address(this), owner);
        
        // Calculate fee and net assets
        uint256 fee = (totalAssets * INSTANT_UNSTAKING_FEE) / 10000;
        assets = totalAssets - fee;
        
        // Transfer fee to insurance fund
        if (fee > 0) {
            IERC20(asset()).safeTransfer(INSURANCE_FUND, fee);
        }
        
        // Transfer remaining assets to receiver
        IERC20(asset()).safeTransfer(receiver, assets);
        
        emit InstantUnstaking(owner, receiver, assets, fee);
        
        return assets;
    }

    /**
     * @notice Allows admin to rescue ERC20 tokens accidentally sent to this contract
     * @dev This function can only be called by an account with DEFAULT_ADMIN_ROLE
     * @dev The underlying asset (JUSD) cannot be rescued to prevent manipulation
     * @dev Uses nonReentrant modifier to prevent potential reentrancy attacks
     * @dev Verifies the token is not the underlying asset before transfer
     * @param token Address of the ERC20 token to rescue
     * @param amount Amount of tokens to rescue
     * @param to Address to send the rescued tokens to
     */
    function rescueTokens(address token, uint256 amount, address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (token == address(0)) revert ZeroAddress("token");
        if (to == address(0)) revert ZeroAddress("to");
        if (amount == 0) revert ZeroAmount();
        if (token == asset()) revert InvalidToken();
        
        IERC20(token).safeTransfer(to, amount);
    }
}
