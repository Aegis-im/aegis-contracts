// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IYUSD } from "./interfaces/IYUSD.sol";

/**
 * @title sYUSD
 * @dev Staked YUSD (sYUSD) - an interest-bearing token that represents YUSD staked in the protocol.
 * The token's value increases over time relative to YUSD, reflecting staking rewards.
 * Implements ERC4626 Tokenized Vault Standard.
 * 
 * @dev Staking Mechanics:
 * - Users deposit YUSD and receive sYUSD shares in return
 * - The exchange rate between YUSD and sYUSD can increase over time as rewards are added
 * - The value of sYUSD (relative to YUSD) never decreases, making it a yield-bearing asset
 * 
 * @dev Lockup System:
 * - All deposits are subject to a lockup period (default: 7 days)
 * - Users cannot withdraw their shares until the lockup period expires
 * - Multiple deposits create separate locked share entries with independent expiry times
 * - Expired lockups must be processed via updateUnlockedShares before withdrawal
 * 
 * @dev Security Features:
 * - Based on OpenZeppelin's ERC4626, ERC20Permit, AccessControl, and ReentrancyGuard
 * - Admin role is required for changing critical parameters
 * - Rescue function for recovering non-YUSD tokens sent to the contract accidentally
 * - Safeguards against withdrawing locked shares
 * - DoS protection with maxIterations parameter in updateUnlockedShares
 * 
 * @dev Integration Notes:
 * - Fully compatible with ERC4626 interfaces for better composability
 * - Implements maxWithdraw and maxDeposit to properly communicate withdrawal limitations
 * - Uses ERC20Permit for gasless approvals
 */
contract sYUSD is ERC4626, ERC20Permit, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // Constants for roles
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    // Lockup period in seconds (7 days by default)
    uint256 public lockupPeriod = 7 days;

    // Default max iterations for locked shares processing
    uint256 public constant DEFAULT_MAX_ITERATIONS = 100;
    
    // Struct to track locked shares
    struct LockedShares {
        uint256 amount;
        uint256 expiryTimestamp;
    }
    
    // Mapping of user address to array of locked share entries
    mapping(address => LockedShares[]) public userLockedShares;
    
    // Mapping to track unlocked shares per user
    mapping(address => uint256) public unlockedShares;

    error InsufficientUnlockedShares(uint256 requested, uint256 available);
    error ZeroAddress(string paramName);
    error InvalidToken();
    
    event LockupPeriodUpdated(uint256 newLockupPeriod);
    event UnlockedSharesUpdated(address indexed user, uint256 processed, uint256 remaining);

    /**
     * @dev Constructor to initialize the sYUSD token
     * @param _yusd Address of the YUSD token
     * @param admin Address of the admin
     */
    constructor(
        address _yusd,
        address admin
    ) ERC4626(IERC20(_yusd)) ERC20("Staked YUSD", "sYUSD") ERC20Permit("Staked YUSD") {
        if (_yusd == address(0)) revert ZeroAddress("YUSD");
        if (admin == address(0)) revert ZeroAddress("Admin");
        
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
    }

    /**
     * @dev Override decimals function to resolve conflict between ERC20 and ERC4626
     */
    function decimals() public view virtual override(ERC4626, ERC20) returns (uint8) {
        return super.decimals();
    }

    /**
     * @dev Allows admin to set the lockup period
     * @param _lockupPeriod New lockup period in seconds
     */
    function setLockupPeriod(uint256 _lockupPeriod) external onlyRole(ADMIN_ROLE) {
        lockupPeriod = _lockupPeriod;
        emit LockupPeriodUpdated(_lockupPeriod);
    }
    
    /**
     * @dev Backward compatibility for existing function calls
     * @param user Address of the user whose unlocked shares will be updated
     */
    function updateUnlockedShares(address user) public {
        updateUnlockedSharesWithLimit(user, DEFAULT_MAX_ITERATIONS);
    }
    
    /**
     * @dev Alternative name for updateUnlockedShares to avoid ambiguity in tests
     * @param user Address of the user whose unlocked shares will be updated
     * @param maxIterations Maximum number of locked share entries to process
     */
    function updateUnlockedSharesWithLimit(address user, uint256 maxIterations) public {
        if (maxIterations == 0 || maxIterations > DEFAULT_MAX_ITERATIONS) {
            maxIterations = DEFAULT_MAX_ITERATIONS;
        }
        
        LockedShares[] storage userLocks = userLockedShares[user];
        uint256 processedCount = 0;
        
        for (uint256 i = 0; i < userLocks.length && processedCount < maxIterations; i++) {
            if (block.timestamp >= userLocks[i].expiryTimestamp && userLocks[i].amount > 0) {
                unlockedShares[user] += userLocks[i].amount;
                userLocks[i].amount = 0;
            }
            processedCount++;
        }
        
        // Cache the original length before cleanup
        uint256 originalLength = userLocks.length;
        
        // Clean up empty entries with the same maxIterations constraint
        _cleanupLockedShares(user, maxIterations);
        
        emit UnlockedSharesUpdated(user, processedCount, originalLength > processedCount ? originalLength - processedCount : 0);
    }
    
    /**
     * @dev Removes empty entries from the locked shares array
     * @dev Storage optimization function that compacts the locked shares array
     * @dev Uses an efficient algorithm:
     *   1. Replaces empty entry with the last entry in the array
     *   2. Removes the last entry (pop operation)
     *   3. Repeats until all empty entries are removed
     * @dev This prevents the array from growing indefinitely with empty entries
     * @dev Called internally by updateUnlockedShares to maintain storage efficiency
     * @param user Address of the user whose locked shares array will be cleaned up
     * @param maxIterations Maximum number of operations to prevent DoS attacks
     * @return The number of remaining entries to process (0 if complete)
     */
    function _cleanupLockedShares(address user, uint256 maxIterations) internal returns (uint256) {
        LockedShares[] storage userLocks = userLockedShares[user];
        uint256 i = 0;
        uint256 operations = 0;
        
        while (i < userLocks.length && operations < maxIterations) {
            if (userLocks[i].amount == 0) {
                // Replace with the last element and pop
                if (i < userLocks.length - 1) {
                    userLocks[i] = userLocks[userLocks.length - 1];
                }
                userLocks.pop();
            } else {
                i++;
            }
            operations++;
        }
        
        return userLocks.length; // Return the number of remaining entries
    }

    /**
     * @dev Override of _deposit to add shares to locked tracking
     * @dev Extends the standard ERC4626 _deposit function to implement lockup functionality
     * @dev Each deposit creates a new entry in the user's locked shares array with a timestamp
     * @dev The shares will be locked until the lockupPeriod has passed from the deposit time
     * @param caller The address that initiated the deposit
     * @param receiver The address that will receive the shares
     * @param assets The amount of underlying asset tokens being deposited
     * @param shares The amount of vault shares being minted
     * @inheritdoc ERC4626
     */
    function _deposit(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        super._deposit(caller, receiver, assets, shares);
        
        // Add new locked shares entry
        userLockedShares[receiver].push(LockedShares({
            amount: shares,
            expiryTimestamp: block.timestamp + lockupPeriod
        }));
    }

    /**
     * @dev Override of _withdraw to ensure only unlocked shares can be withdrawn
     * @dev Extends the standard ERC4626 _withdraw function to enforce lockup periods
     * @dev Before withdrawal, it checks if the user has sufficient unlocked shares
     * @dev First updates the user's unlocked shares by checking for expired lockup periods
     * @dev If insufficient unlocked shares are available, the transaction will revert
     * @param caller The address that initiated the withdrawal
     * @param receiver The address that will receive the assets
     * @param owner The address that owns the shares being burned
     * @param assets The amount of underlying asset tokens being withdrawn
     * @param shares The amount of vault shares being burned
     * @inheritdoc ERC4626
     */
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        // First update the unlocked shares with maximum possible iterations
        updateUnlockedSharesWithLimit(owner, DEFAULT_MAX_ITERATIONS);
        
        // Ensure user has enough unlocked shares
        if (unlockedShares[owner] < shares) {
            revert InsufficientUnlockedShares(shares, unlockedShares[owner]);
        }
        
        // Reduce unlocked shares
        unlockedShares[owner] -= shares;
        
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /**
     * @dev Override of maxDeposit to enforce deposit limits
     * @dev Returns the maximum amount of assets that can be deposited
     * @dev In this implementation, there is no upper limit on deposits
     * @dev Could be overridden in future versions to implement deposit caps
     * @dev Required by the ERC4626 standard for proper integration with other protocols
     * @return The maximum amount of assets that can be deposited
     */
    function maxDeposit(address) public view virtual override returns (uint256) {
        return type(uint256).max;
    }

    /**
     * @dev Override of maxWithdraw to return only unlocked shares value
     * @dev Calculates the maximum amount of assets that can be withdrawn by the owner
     * @dev Takes into account both already unlocked shares and shares with expired lockup periods
     * @dev This is important for ERC4626 compatibility, as it affects other interface functions
     * @dev The returned value represents assets (not shares) that can be withdrawn
     * @param owner The address whose maximum withdrawable assets is being calculated
     * @return The maximum amount of assets that can be withdrawn by the owner
     */
    function maxWithdraw(address owner) public view virtual override returns (uint256) {
        // Calculate current unlocked amount (without state changes)
        uint256 currentUnlocked = unlockedShares[owner];
        LockedShares[] storage userLocks = userLockedShares[owner];
        
        for (uint256 i = 0; i < userLocks.length; i++) {
            if (block.timestamp >= userLocks[i].expiryTimestamp) {
                currentUnlocked += userLocks[i].amount;
            }
        }
        
        // Convert unlocked shares to assets
        return convertToAssets(currentUnlocked);
    }
    
    /**
     * @dev Override of maxRedeem to return only unlocked shares
     * @dev Calculates the maximum amount of shares that can be redeemed by the owner
     * @dev Takes into account both already unlocked shares and shares with expired lockup periods
     * @dev This is important for ERC4626 compatibility and prevents attempts to redeem locked shares
     * @dev The returned value represents shares (not assets) that can be redeemed
     * @param owner The address whose maximum redeemable shares is being calculated
     * @return The maximum amount of shares that can be redeemed by the owner
     */
    function maxRedeem(address owner) public view virtual override returns (uint256) {
        // Calculate current unlocked amount (without state changes)
        uint256 currentUnlocked = unlockedShares[owner];
        LockedShares[] storage userLocks = userLockedShares[owner];
        
        for (uint256 i = 0; i < userLocks.length; i++) {
            if (block.timestamp >= userLocks[i].expiryTimestamp) {
                currentUnlocked += userLocks[i].amount;
            }
        }
        
        // Return unlocked shares directly (no conversion needed)
        return currentUnlocked;
    }
    
    /**
     * @dev Gets the total locked and unlocked shares for a user
     * @dev Performs a calculation similar to updateUnlockedShares but without state changes
     * @dev Provides a real-time view of the user's share positions broken down by lock status
     * @dev Automatically considers expired lockups as unlocked, even if updateUnlockedShares hasn't been called
     * @param user Address of the user
     * @return Total locked shares, total unlocked shares
     */
    function getUserSharesStatus(address user) external view returns (uint256, uint256) {
        uint256 lockedShares = 0;
        uint256 currentUnlocked = unlockedShares[user];
        
        LockedShares[] storage userLocks = userLockedShares[user];
        for (uint256 i = 0; i < userLocks.length; i++) {
            if (block.timestamp < userLocks[i].expiryTimestamp) {
                lockedShares += userLocks[i].amount;
            } else {
                currentUnlocked += userLocks[i].amount;
            }
        }
        
        return (lockedShares, currentUnlocked);
    }

    /**
     * @notice Allows admin to rescue ERC20 tokens accidentally sent to this contract
     * @dev This function can only be called by an account with DEFAULT_ADMIN_ROLE
     * @dev The underlying asset (YUSD) cannot be rescued to prevent manipulation
     * @dev Uses nonReentrant modifier to prevent potential reentrancy attacks
     * @dev Verifies the token is not the underlying asset before transfer
     * @param token Address of the ERC20 token to rescue
     * @param amount Amount of tokens to rescue
     * @param to Address to send the rescued tokens to
     */
    function rescueTokens(address token, uint256 amount, address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(token) == asset()) revert InvalidToken();
        IERC20(token).safeTransfer(to, amount);
    }
} 