// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IYUSD } from "./interfaces/IYUSD.sol";

/**
 * @title StYUSD
 * @dev Staked YUSD (StYUSD) - an interest-bearing token that represents YUSD staked in the protocol.
 * The token's value increases over time relative to YUSD, reflecting staking rewards.
 * Implements ERC4626 Tokenized Vault Standard.
 */
contract StYUSD is ERC4626, ERC20Permit, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // Constants for roles
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    
    // Lockup period in seconds (7 days by default)
    uint256 public lockupPeriod = 7 days;
    
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

    /**
     * @dev Constructor to initialize the StYUSD token
     * @param _yusd Address of the YUSD token
     * @param admin Address of the admin
     */
    constructor(
        address _yusd,
        address admin
    ) ERC4626(IERC20(_yusd)) ERC20("Staked YUSD", "stYUSD") ERC20Permit("Staked YUSD") {
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
     * @dev Updates the unlocked shares for a user by checking expired lockups
     * @param user Address of the user
     */
    function updateUnlockedShares(address user) public {
        LockedShares[] storage userLocks = userLockedShares[user];
        
        for (uint256 i = 0; i < userLocks.length; i++) {
            if (block.timestamp >= userLocks[i].expiryTimestamp && userLocks[i].amount > 0) {
                unlockedShares[user] += userLocks[i].amount;
                userLocks[i].amount = 0;
            }
        }
        
        // Clean up empty entries
        _cleanupLockedShares(user);
    }
    
    /**
     * @dev Removes empty entries from the locked shares array
     * @param user Address of the user
     */
    function _cleanupLockedShares(address user) internal {
        LockedShares[] storage userLocks = userLockedShares[user];
        uint256 i = 0;
        
        while (i < userLocks.length) {
            if (userLocks[i].amount == 0) {
                // Replace with the last element and pop
                userLocks[i] = userLocks[userLocks.length - 1];
                userLocks.pop();
            } else {
                i++;
            }
        }
    }

    /**
     * @dev Override of _deposit to add shares to locked tracking
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
     */
    function _withdraw(
        address caller,
        address receiver,
        address owner,
        uint256 assets,
        uint256 shares
    ) internal virtual override {
        // First update the unlocked shares
        updateUnlockedShares(owner);
        
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
     */
    function maxDeposit(address) public view virtual override returns (uint256) {
        return type(uint256).max;
    }

    /**
     * @dev Override of maxWithdraw to return only unlocked shares value
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
     * @dev Gets the total locked and unlocked shares for a user
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

    function rescueTokens(address token, uint256 amount, address to) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(token) == asset()) revert InvalidToken();
        IERC20(token).safeTransfer(to, amount);
    }
} 