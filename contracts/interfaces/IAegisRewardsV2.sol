// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IAegisRewardsEvents, IAegisRewardsErrors } from "./IAegisRewards.sol";
import { IAegisConfig } from "./IAegisConfig.sol";

/**
 * @title IAegisRewardsV2
 * @notice Interface for the refactored rewards contract with daily updates
 */
interface IAegisRewardsV2 {
    /// @notice On-chain user rewards data for a snapshot
    struct UserRewardData {
        uint256 amount;
        bool claimed;
    }

    /// @notice Distribution data for cross-chain rewards
    struct ChainDistribution {
        uint32 chainId;
        address rewardsContract;
        uint256 amount;
        bool bridged;
    }

    /// @notice Daily update data
    struct DailyUpdate {
        uint256 timestamp;
        uint256 totalDeposited;
        uint256 stakingShare;
        uint256 usersShare;
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    function getDomainSeparator() external view returns (bytes32);

    function totalReservedRewards() external view returns (uint256);

    function availableBalanceForDeposits() external view returns (uint256);

    function getUserRewards(bytes32 snapshotId, address user) external view returns (UserRewardData memory);

    function getDailyUpdate(bytes32 snapshotId, uint256 day) external view returns (DailyUpdate memory);

    function getCurrentDay(bytes32 snapshotId) external view returns (uint256);

    function getChainDistribution(bytes32 snapshotId, uint32 chainId) external view returns (ChainDistribution memory);

    function getSupportedChains() external view returns (uint32[] memory);

    function isMainChain() external view returns (bool);

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    function depositRewards(bytes calldata requestId, uint256 amount) external;

    // ============================================
    // DAILY UPDATE FUNCTIONS
    // ============================================

    function updateDailyRewards(
        bytes32 snapshotId,
        uint256 stakingBalance,
        uint256 totalEligibleBalance
    ) external;

    function sendToStaking(bytes32 snapshotId, uint256 amount) external;

    // ============================================
    // ON-CHAIN USER REWARDS
    // ============================================

    function setUserRewards(
        bytes32 snapshotId,
        address[] calldata users,
        uint256[] calldata amounts
    ) external;

    function claimOnChainRewards(bytes32 snapshotId) external;

    // ============================================
    // CROSS-CHAIN DISTRIBUTION
    // ============================================

    function configureChain(uint32 chainId, address rewardsContract, bool add) external;

    function setChainDistribution(
        bytes32 snapshotId,
        uint32[] calldata chainIds,
        address[] calldata rewardsContracts,
        uint256[] calldata amounts
    ) external;

    function markAsBridged(bytes32 snapshotId, uint32 chainId) external;

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    function finalizeRewards(bytes32 id, uint256 claimDuration) external;

    function withdrawExpiredRewards(bytes32 id, address to) external;

    function rescueRewards(bytes32 snapshotId, address user, address to) external;

    function setAegisConfigAddress(IAegisConfig _aegisConfig) external;

    function setAegisMintingAddress(address _aegisMinting) external;

    function setAegisIncomeRouterAddress(address _aegisIncomeRouter) external;

    function setStakingContract(address _stakingContract) external;
}

/**
 * @title IAegisRewardsV2Events
 * @notice Events specific to AegisRewardsV2
 */
interface IAegisRewardsV2Events is IAegisRewardsEvents {
    /// @dev Event emitted when daily rewards update is performed
    event DailyRewardsUpdate(
        bytes32 indexed id,
        uint256 day,
        uint256 totalDeposited,
        uint256 stakingShare,
        uint256 usersShare,
        uint256 timestamp
    );

    /// @dev Event emitted when user rewards are set on-chain
    event SetUserRewards(bytes32 indexed id, address indexed user, uint256 amount);

    /// @dev Event emitted when rewards are distributed to a chain
    event CrossChainDistribution(
        bytes32 indexed id,
        uint32 indexed chainId,
        address rewardsContract,
        uint256 amount
    );

    /// @dev Event emitted when rewards are rescued
    event RescueRewards(bytes32 indexed id, address indexed user, address indexed to, uint256 amount);

    /// @dev Event emitted when staking contract is set
    event SetStakingContract(address indexed stakingContract);

    /// @dev Event emitted when chain is added/removed for distribution
    event ChainConfigured(uint32 indexed chainId, address rewardsContract, bool added);
}

/**
 * @title IAegisRewardsV2Errors
 * @notice Errors specific to AegisRewardsV2
 */
interface IAegisRewardsV2Errors is IAegisRewardsErrors {
    error AlreadyClaimed();
    error InvalidChain();
    error AlreadyBridged();
    error NotMainChain();
    error SnapshotNotFinalized();
    error UserRewardsNotSet();
    error ChainAlreadyConfigured();
    error InvalidSnapshotId();
}
