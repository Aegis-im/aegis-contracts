// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IAegisRewardsEvents, IAegisRewardsErrors } from "./IAegisRewards.sol";
import { IAegisConfig } from "./IAegisConfig.sol";
import { IOFT } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";

/**
 * @title IAegisRewardsV2
 * @notice Interface for the refactored rewards contract
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

    /// @notice Configuration for a supported chain
    struct ChainConfig {
        uint32 dstEid;
        address rewardsContract;
        bool configured;
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    function getDomainSeparator() external view returns (bytes32);

    function totalReservedRewards() external view returns (uint256);

    function availableBalanceForDeposits() external view returns (uint256);

    function getUserRewards(bytes32 snapshotId, address user) external view returns (UserRewardData memory);

    function getChainDistribution(bytes32 snapshotId, uint32 chainId) external view returns (ChainDistribution memory);

    function getSupportedChains() external view returns (uint32[] memory);

    function isMainChain() external view returns (bool);

    function getChainConfig(uint32 chainId) external view returns (ChainConfig memory);

    function quoteBridging(bytes32 snapshotId, uint32 chainId, bytes calldata extraOptions) external view returns (MessagingFee memory);

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    function depositRewards(bytes calldata requestId, uint256 amount) external;

    // ============================================
    // STAKING FUNCTIONS
    // ============================================

    function sendToStaking(bytes32 snapshotId, uint256 amount) external;

    // ============================================
    // ON-CHAIN USER REWARDS
    // ============================================

    function setUserRewards(
        bytes32 snapshotId,
        address[] calldata users,
        uint256[] calldata amounts,
        uint256 claimDuration
    ) external;

    function claimOnChainRewards(bytes32 snapshotId) external;

    // ============================================
    // CROSS-CHAIN DISTRIBUTION
    // ============================================

    function configureChain(uint32 chainId, uint32 dstEid, address rewardsContract, bool add) external;

    function setChainDistribution(
        bytes32 snapshotId,
        uint32[] calldata chainIds,
        address[] calldata rewardsContracts,
        uint256[] calldata amounts
    ) external;

    function bridgeToChain(bytes32 snapshotId, uint32 chainId, bytes calldata extraOptions) external payable;

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

    function setOFTAdapter(IOFT _oftAdapter) external;
}

/**
 * @title IAegisRewardsV2Events
 * @notice Events specific to AegisRewardsV2
 */
interface IAegisRewardsV2Events is IAegisRewardsEvents {
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
    event ChainConfigured(uint32 indexed chainId, uint32 dstEid, address rewardsContract, bool added);

    /// @dev Event emitted when OFT adapter is set
    event SetOFTAdapter(address indexed oftAdapter);
}

/**
 * @title IAegisRewardsV2Errors
 * @notice Errors specific to AegisRewardsV2
 */
interface IAegisRewardsV2Errors is IAegisRewardsErrors {
    error AlreadyClaimed();
    error AlreadyFinalized();
    error InvalidChain();
    error AlreadyBridged();
    error NotMainChain();
    error SnapshotNotFinalized();
    error UserRewardsNotSet();
    error ChainAlreadyConfigured();
    error InvalidSnapshotId();
    error OFTAdapterNotSet();
}
