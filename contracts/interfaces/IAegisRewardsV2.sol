// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IOFT } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";

/**
 * @title IAegisRewardsV2
 * @notice Interface for the refactored rewards contract
 */
interface IAegisRewardsV2 {
    /// @notice Configuration for a supported chain
    struct ChainConfig {
        uint32 dstEid;
        address rewardsContract;
        bool configured;
    }

    /// @notice Bridge operation for performDailyOperations
    struct BridgeOperation {
        uint32 chainId;
        uint256 amount;
        uint256 nativeFee;
        bytes extraOptions;
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    function availableBalanceForDeposits() external view returns (uint256);

    function getSupportedChains() external view returns (uint32[] memory);

    function isMainChain() external view returns (bool);

    function getChainConfig(uint32 chainId) external view returns (ChainConfig memory);

    function getMerkleRoot() external view returns (bytes32);

    function getCumulativeClaimed(address user) external view returns (uint256);

    function getMerklePoolBalance() external view returns (uint256);

    function quoteBridging(uint32 chainId, uint256 amount, bytes calldata extraOptions) external view returns (MessagingFee memory);

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    function depositRewards(bytes calldata requestId, uint256 amount) external;

    // ============================================
    // STAKING FUNCTIONS
    // ============================================

    function sendToStaking(uint256 amount) external;

    // ============================================
    // MERKLE REWARDS
    // ============================================

    function setMerkleRoot(bytes32 merkleRoot) external;

    function claimMerkleRewards(address account, uint256 cumulativeAmount, bytes32[] calldata proof) external;

    function rescueMerkleRewards(address account, address claimer, address to, uint256 cumulativeAmount, bytes32[] calldata proof) external;

    // ============================================
    // CROSS-CHAIN DISTRIBUTION
    // ============================================

    function configureChain(uint32 chainId, uint32 dstEid, address rewardsContract, bool add) external;

    function bridgeToChain(uint32 chainId, uint256 amount, bytes calldata extraOptions) external payable;

    function performDailyOperations(bytes32 merkleRoot, BridgeOperation[] calldata bridges) external payable;

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    function rescueAssets(IERC20 token) external;

    function rescueETH() external;

    function setStakingContract(address _stakingContract) external;

    function setOFTAdapter(IOFT _oftAdapter) external;
}
