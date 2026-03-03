// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import { IOFT, SendParam } from "@layerzerolabs/oft-evm/contracts/interfaces/IOFT.sol";
import { MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OAppSender.sol";

import { IYUSD } from "./interfaces/IYUSD.sol";
import { IAegisRewardsEvents, IAegisRewardsErrors } from "./interfaces/IAegisRewards.sol";

/**
 * @title AegisRewardsV2
 * @notice Rewards contract with cumulative Merkle distribution
 *         and cross-chain support via LayerZero OFT bridging
 */
contract AegisRewardsV2 is IAegisRewardsEvents, IAegisRewardsErrors, AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IYUSD;
    using SafeERC20 for IERC20;

    struct Reward {
        uint256 amount;
        uint256 expiry;
        bool finalized;
    }

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

    /// @dev role enabling to finalize and withdraw expired rewards
    bytes32 private constant REWARDS_MANAGER_ROLE = keccak256("REWARDS_MANAGER_ROLE");

    /// @dev role for cross-chain distribution
    bytes32 private constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    /// @notice YUSD token contract
    IYUSD public immutable yusd;

    /// @notice AegisMinting contract address
    address public aegisMinting;

    /// @notice AegisIncomeRouter contract address
    address public aegisIncomeRouter;

    /// @notice Staking contract address (for cross-chain distribution)
    address public stakingContract;

    /// @notice OFT adapter for cross-chain bridging
    IOFT public oftAdapter;

    /// @dev Flag to indicate if this is the main chain (ETH)
    bool public immutable isMainChain;

    /// @dev Map of reward ids to rewards amounts
    mapping(bytes32 => Reward) private _rewards;

    /// @dev Total amount of YUSD reserved for rewards (prevent double spending)
    uint256 private _totalReservedRewards;

    /// @dev On-chain user rewards storage: snapshotId => user => UserRewardData
    mapping(bytes32 => mapping(address => UserRewardData)) private _userRewards;

    /// @dev Cross-chain distribution: snapshotId => chainId => ChainDistribution
    mapping(bytes32 => mapping(uint32 => ChainDistribution)) private _chainDistributions;

    /// @dev List of supported chain IDs for distribution
    uint32[] private _supportedChains;

    /// @dev Chain configurations: chainId => ChainConfig
    mapping(uint32 => ChainConfig) private _chainConfigs;

    /// @dev Current cumulative Merkle root (covers all user rewards across all time)
    bytes32 private _currentMerkleRoot;

    /// @dev Cumulative amount already claimed per user via Merkle
    mapping(address => uint256) private _cumulativeClaimed;

    /// @dev Total YUSD reserved for unclaimed Merkle rewards
    uint256 private _merklePoolBalance;

    // ============================================
    // EVENTS
    // ============================================

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

    /// @dev Event emitted when cumulative Merkle root is updated
    event SetMerkleRoot(bytes32 merkleRoot);

    /// @dev Event emitted when funds are moved to the Merkle pool
    event FundMerklePool(bytes32 indexed snapshotId, uint256 amount);

    /// @dev Event emitted when user claims via cumulative Merkle proof
    event ClaimMerkleRewards(address indexed wallet, uint256 amount);

    /// @dev Event emitted when admin rescues Merkle rewards for a user
    event RescueMerkleRewards(address indexed user, address indexed to, uint256 amount);

    // ============================================
    // ERRORS
    // ============================================

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
    error MerkleRootNotSet();
    error InvalidMerkleProof();
    error NothingToClaim();

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(
        IYUSD _yusd,
        address _admin,
        bool _isMainChain
    ) AccessControlDefaultAdminRules(3 days, _admin) {
        if (address(_yusd) == address(0)) revert ZeroAddress();

        yusd = _yusd;
        isMainChain = _isMainChain;
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /// @dev Returns reward amount for provided id
    function rewardById(string calldata id) public view returns (Reward memory) {
        return _rewards[_stringToBytes32(id)];
    }

    /// @dev Returns total reserved rewards amount
    function totalReservedRewards() public view returns (uint256) {
        return _totalReservedRewards;
    }

    /// @dev Returns available balance for new deposits
    function availableBalanceForDeposits() public view returns (uint256) {
        return yusd.balanceOf(address(this)) - _totalReservedRewards;
    }

    /// @dev Returns user rewards for a snapshot
    function getUserRewards(bytes32 snapshotId, address user) public view returns (UserRewardData memory) {
        return _userRewards[snapshotId][user];
    }

    /// @dev Returns chain distribution for a snapshot
    function getChainDistribution(bytes32 snapshotId, uint32 chainId) public view returns (ChainDistribution memory) {
        return _chainDistributions[snapshotId][chainId];
    }

    /// @dev Returns list of supported chains
    function getSupportedChains() public view returns (uint32[] memory) {
        return _supportedChains;
    }

    /// @dev Returns chain configuration
    function getChainConfig(uint32 chainId) public view returns (ChainConfig memory) {
        return _chainConfigs[chainId];
    }

    /// @dev Returns the current cumulative Merkle root
    function getMerkleRoot() public view returns (bytes32) {
        return _currentMerkleRoot;
    }

    /// @dev Returns cumulative amount already claimed by a user via Merkle
    function getCumulativeClaimed(address user) public view returns (uint256) {
        return _cumulativeClaimed[user];
    }

    /// @dev Returns total YUSD reserved for unclaimed Merkle rewards
    function getMerklePoolBalance() public view returns (uint256) {
        return _merklePoolBalance;
    }

    /// @dev Returns fee quote for bridging rewards to a chain
    function quoteBridging(
        bytes32 snapshotId,
        uint32 chainId,
        bytes calldata extraOptions
    ) public view returns (MessagingFee memory) {
        if (address(oftAdapter) == address(0)) revert OFTAdapterNotSet();

        ChainConfig storage config = _chainConfigs[chainId];
        if (!config.configured) revert InvalidChain();

        ChainDistribution storage dist = _chainDistributions[snapshotId][chainId];
        if (dist.chainId == 0) revert InvalidChain();

        SendParam memory sendParam = SendParam({
            dstEid: config.dstEid,
            to: bytes32(uint256(uint160(dist.rewardsContract))),
            amountLD: dist.amount,
            minAmountLD: dist.amount,
            extraOptions: extraOptions,
            composeMsg: "",
            oftCmd: ""
        });

        return oftAdapter.quoteSend(sendParam, false);
    }

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    /// @dev Adds minted YUSD rewards from AegisMintingContract or AegisIncomeRouter
    /// @notice In V2, rewards are deposited to the CURRENT week snapshot
    function depositRewards(bytes calldata requestId, uint256 amount) external {
        require(_msgSender() == aegisMinting || _msgSender() == aegisIncomeRouter, "Unauthorized");

        bytes32 id = _stringToBytes32(abi.decode(requestId, (string)));
        if (_rewards[id].finalized) revert AlreadyFinalized();
        _rewards[id].amount += amount;
        _totalReservedRewards += amount;

        emit DepositRewards(id, amount, block.timestamp);
    }

    // ============================================
    // STAKING FUNCTIONS
    // ============================================

    /**
     * @notice Send staking rewards to staking contract
     * @param snapshotId The snapshot identifier
     * @param amount Amount to send to staking
     */
    function sendToStaking(bytes32 snapshotId, uint256 amount) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (stakingContract == address(0)) revert ZeroAddress();
        if (amount > _rewards[snapshotId].amount) revert InsufficientContractBalance();

        _rewards[snapshotId].amount -= amount;
        _totalReservedRewards -= amount;
        yusd.safeTransfer(stakingContract, amount);
    }

    // ============================================
    // ON-CHAIN USER REWARDS
    // ============================================

    /**
     * @notice Set user rewards on-chain and finalize the snapshot
     * @dev Allows storing rewards data on-chain so backend is not required for claiming.
     *      Automatically finalizes the snapshot so users can claim immediately.
     * @param snapshotId The snapshot identifier
     * @param users Array of user addresses
     * @param amounts Array of reward amounts
     * @param claimDuration Duration in seconds for the claim window (0 = no expiry)
     */
    function setUserRewards(
        bytes32 snapshotId,
        address[] calldata users,
        uint256[] calldata amounts,
        uint256 claimDuration
    ) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (snapshotId == bytes32(0)) revert InvalidSnapshotId();
        if (_rewards[snapshotId].finalized) revert AlreadyFinalized();
        if (users.length != amounts.length) revert InvalidAddress();
        if (users.length == 0) revert InvalidAddress();

        for (uint256 i = 0; i < users.length; i++) {
            if (users[i] == address(0)) revert ZeroAddress();
            _userRewards[snapshotId][users[i]] = UserRewardData({
                amount: amounts[i],
                claimed: false
            });
            emit SetUserRewards(snapshotId, users[i], amounts[i]);
        }

        _rewards[snapshotId].finalized = true;
        if (claimDuration > 0) {
            _rewards[snapshotId].expiry = block.timestamp + claimDuration;
        }
        emit FinalizeRewards(snapshotId, _rewards[snapshotId].expiry);
    }

    /**
     * @notice Claim rewards using on-chain stored data
     * @param snapshotId The snapshot identifier
     */
    function claimOnChainRewards(bytes32 snapshotId) external nonReentrant {
        if (!_rewards[snapshotId].finalized) revert SnapshotNotFinalized();

        UserRewardData storage userData = _userRewards[snapshotId][_msgSender()];
        if (userData.amount == 0) revert UserRewardsNotSet();
        if (userData.claimed) revert AlreadyClaimed();

        // Check expiry
        if (_rewards[snapshotId].expiry > 0 && _rewards[snapshotId].expiry < block.timestamp) {
            revert UnknownRewards();
        }

        uint256 amount = userData.amount;
        userData.claimed = true;
        _rewards[snapshotId].amount -= amount;
        _totalReservedRewards -= amount;

        yusd.safeTransfer(_msgSender(), amount);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = snapshotId;
        emit ClaimRewards(_msgSender(), ids, amount);
    }

    // ============================================
    // CUMULATIVE MERKLE REWARDS
    // ============================================

    /**
     * @notice Set the cumulative Merkle root
     * @dev Each leaf is (address, cumulativeTotalRewards). Updated periodically
     *      as new rewards are computed. O(1) gas regardless of user count.
     * @param merkleRoot The new cumulative Merkle root
     */
    function setMerkleRoot(
        bytes32 merkleRoot
    ) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (merkleRoot == bytes32(0)) revert ZeroRewards();

        _currentMerkleRoot = merkleRoot;

        emit SetMerkleRoot(merkleRoot);
    }

    /**
     * @notice Move funds from a snapshot pool into the Merkle reward pool
     * @dev Transfers reserved balance from a per-snapshot pool to the cumulative
     *      Merkle pool. Total reserved rewards stays unchanged.
     * @param snapshotId The snapshot to draw from
     * @param amount Amount to move
     */
    function fundMerklePool(
        bytes32 snapshotId,
        uint256 amount
    ) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (amount == 0) revert ZeroRewards();
        if (amount > _rewards[snapshotId].amount) revert InsufficientContractBalance();

        _rewards[snapshotId].amount -= amount;
        _merklePoolBalance += amount;
        // _totalReservedRewards unchanged — funds move between pools

        emit FundMerklePool(snapshotId, amount);
    }

    /**
     * @notice Claim rewards using a cumulative Merkle proof
     * @dev User provides their total cumulative entitlement and proof.
     *      Contract pays out the delta between entitlement and previously claimed.
     *      One proof, one tx — covers all unclaimed rewards regardless of how many
     *      days/weeks have passed.
     * @param cumulativeAmount The user's total cumulative reward entitlement
     * @param proof The Merkle proof
     */
    function claimMerkleRewards(
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (_currentMerkleRoot == bytes32(0)) revert MerkleRootNotSet();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(_msgSender(), cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, _currentMerkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }

        uint256 claimable = cumulativeAmount - _cumulativeClaimed[_msgSender()];
        if (claimable == 0) revert NothingToClaim();

        _cumulativeClaimed[_msgSender()] = cumulativeAmount;
        _merklePoolBalance -= claimable;
        _totalReservedRewards -= claimable;

        yusd.safeTransfer(_msgSender(), claimable);

        emit ClaimMerkleRewards(_msgSender(), claimable);
    }

    /**
     * @notice Rescue cumulative Merkle rewards for a user (e.g., lost wallet)
     * @dev Admin provides the user's cumulative entitlement and proof.
     *      Pays out the delta to a destination address.
     * @param user The user whose rewards to rescue
     * @param to The destination address
     * @param cumulativeAmount The user's total cumulative entitlement
     * @param proof The Merkle proof for the user
     */
    function rescueMerkleRewards(
        address user,
        address to,
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (_currentMerkleRoot == bytes32(0)) revert MerkleRootNotSet();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, _currentMerkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }

        uint256 claimable = cumulativeAmount - _cumulativeClaimed[user];
        if (claimable == 0) revert NothingToClaim();

        _cumulativeClaimed[user] = cumulativeAmount;
        _merklePoolBalance -= claimable;
        _totalReservedRewards -= claimable;

        yusd.safeTransfer(to, claimable);

        emit RescueMerkleRewards(user, to, claimable);
    }

    // ============================================
    // CROSS-CHAIN DISTRIBUTION
    // ============================================

    /**
     * @notice Configure a chain for cross-chain distribution
     * @param chainId The chain ID
     * @param dstEid The LayerZero destination endpoint ID
     * @param rewardsContract The rewards contract address on that chain
     * @param add True to add, false to remove
     */
    function configureChain(
        uint32 chainId,
        uint32 dstEid,
        address rewardsContract,
        bool add
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (add) {
            if (rewardsContract == address(0)) revert ZeroAddress();
            if (_chainConfigs[chainId].configured) revert ChainAlreadyConfigured();
            _chainConfigs[chainId] = ChainConfig({
                dstEid: dstEid,
                rewardsContract: rewardsContract,
                configured: true
            });
            _supportedChains.push(chainId);
        } else {
            if (!_chainConfigs[chainId].configured) revert InvalidChain();
            delete _chainConfigs[chainId];
            // Remove chain from supported list
            for (uint256 i = 0; i < _supportedChains.length; i++) {
                if (_supportedChains[i] == chainId) {
                    _supportedChains[i] = _supportedChains[_supportedChains.length - 1];
                    _supportedChains.pop();
                    break;
                }
            }
        }
        emit ChainConfigured(chainId, dstEid, rewardsContract, add);
    }

    /**
     * @notice Calculate and set cross-chain distribution for a snapshot
     * @dev Only callable on main chain (ETH)
     * @param snapshotId The snapshot identifier
     * @param chainIds Array of chain IDs
     * @param rewardsContracts Array of rewards contract addresses
     * @param amounts Array of amounts for each chain
     */
    function setChainDistribution(
        bytes32 snapshotId,
        uint32[] calldata chainIds,
        address[] calldata rewardsContracts,
        uint256[] calldata amounts
    ) external onlyRole(DISTRIBUTOR_ROLE) {
        if (!isMainChain) revert NotMainChain();
        if (chainIds.length != amounts.length || chainIds.length != rewardsContracts.length) {
            revert InvalidAddress();
        }

        for (uint256 i = 0; i < chainIds.length; i++) {
            _chainDistributions[snapshotId][chainIds[i]] = ChainDistribution({
                chainId: chainIds[i],
                rewardsContract: rewardsContracts[i],
                amount: amounts[i],
                bridged: false
            });
        }
    }

    /**
     * @notice Bridge YUSD to a destination chain via LayerZero OFT adapter
     * @param snapshotId The snapshot identifier
     * @param chainId The chain ID to bridge to
     * @param extraOptions Additional LayerZero options
     */
    function bridgeToChain(
        bytes32 snapshotId,
        uint32 chainId,
        bytes calldata extraOptions
    ) external payable onlyRole(DISTRIBUTOR_ROLE) {
        if (!isMainChain) revert NotMainChain();
        if (address(oftAdapter) == address(0)) revert OFTAdapterNotSet();

        ChainConfig storage config = _chainConfigs[chainId];
        if (!config.configured) revert InvalidChain();

        ChainDistribution storage dist = _chainDistributions[snapshotId][chainId];
        if (dist.chainId == 0) revert InvalidChain();
        if (dist.bridged) revert AlreadyBridged();

        uint256 amount = dist.amount;
        dist.bridged = true;
        _rewards[snapshotId].amount -= amount;
        _totalReservedRewards -= amount;

        // Approve OFT adapter to spend YUSD
        yusd.forceApprove(address(oftAdapter), amount);

        // Build SendParam
        SendParam memory sendParam = SendParam({
            dstEid: config.dstEid,
            to: bytes32(uint256(uint160(dist.rewardsContract))),
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: extraOptions,
            composeMsg: "",
            oftCmd: ""
        });

        // Get fee quote
        MessagingFee memory fee = MessagingFee({
            nativeFee: msg.value,
            lzTokenFee: 0
        });

        // Send via OFT adapter - excess ETH refunded to msg.sender
        oftAdapter.send{value: msg.value}(sendParam, fee, _msgSender());

        emit CrossChainDistribution(snapshotId, chainId, dist.rewardsContract, amount);
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /// @dev Marks reward with id as final
    function finalizeRewards(bytes32 id, uint256 claimDuration) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (_rewards[id].finalized) {
            revert UnknownRewards();
        }

        _rewards[id].finalized = true;
        if (claimDuration > 0) {
            _rewards[id].expiry = block.timestamp + claimDuration;
        }

        emit FinalizeRewards(id, _rewards[id].expiry);
    }

    /// @dev Transfers expired rewards left amount to destination address
    function withdrawExpiredRewards(bytes32 id, address to) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (!_rewards[id].finalized || _rewards[id].amount == 0 || _rewards[id].expiry == 0 || _rewards[id].expiry > block.timestamp) {
            revert UnknownRewards();
        }

        uint256 amount = _rewards[id].amount;
        _rewards[id].amount = 0;
        _totalReservedRewards -= amount;
        yusd.safeTransfer(to, amount);

        emit WithdrawExpiredRewards(id, to, amount);
    }

    /**
     * @notice Rescue rewards for a user
     * @dev Allows admin to withdraw rewards on behalf of a user (e.g., lost wallet)
     * @param snapshotId The snapshot identifier
     * @param user The user whose rewards to rescue
     * @param to The destination address
     */
    function rescueRewards(
        bytes32 snapshotId,
        address user,
        address to
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();

        UserRewardData storage userData = _userRewards[snapshotId][user];
        if (userData.amount == 0) revert UserRewardsNotSet();
        if (userData.claimed) revert AlreadyClaimed();

        uint256 amount = userData.amount;
        userData.claimed = true;
        _rewards[snapshotId].amount -= amount;
        _totalReservedRewards -= amount;

        yusd.safeTransfer(to, amount);

        emit RescueRewards(snapshotId, user, to, amount);
    }

    /// @dev Rescue ERC20 tokens from contract balance (excluding reserved rewards)
    function rescueAssets(IERC20 token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        address admin = msg.sender;

        uint256 balance = token.balanceOf(address(this));

        // If rescuing YUSD, only rescue excess above reserved amount
        if (address(token) == address(yusd)) {
            if (balance <= _totalReservedRewards) revert NoTokensToRescue();
            balance = balance - _totalReservedRewards;
        }

        if (balance == 0) revert NoTokensToRescue();

        SafeERC20.safeTransfer(token, admin, balance);
        emit RescueAssets(address(token), admin, balance);
    }

    /// @dev Sets new AegisMinting address
    function setAegisMintingAddress(address _aegisMinting) external onlyRole(DEFAULT_ADMIN_ROLE) {
        aegisMinting = _aegisMinting;
        emit SetAegisMintingAddress(_aegisMinting);
    }

    /// @dev Sets new AegisIncomeRouter address
    function setAegisIncomeRouterAddress(address _aegisIncomeRouter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        aegisIncomeRouter = _aegisIncomeRouter;
        emit SetAegisIncomeRouterAddress(_aegisIncomeRouter);
    }

    /// @dev Sets staking contract address
    function setStakingContract(address _stakingContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stakingContract = _stakingContract;
        emit SetStakingContract(_stakingContract);
    }

    /// @dev Sets OFT adapter for cross-chain bridging
    function setOFTAdapter(IOFT _oftAdapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oftAdapter = _oftAdapter;
        emit SetOFTAdapter(address(_oftAdapter));
    }

    // ============================================
    // INTERNAL FUNCTIONS
    // ============================================

    function _stringToBytes32(string memory source) private pure returns (bytes32 result) {
        bytes memory str = bytes(source);
        if (str.length == 0) {
            return 0x0;
        }

        assembly {
            result := mload(add(source, 32))
        }
    }
}
