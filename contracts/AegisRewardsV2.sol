// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Context } from "@openzeppelin/contracts/utils/Context.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC165, ERC165 } from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { ClaimRewardsLib } from "./lib/ClaimRewardsLib.sol";

import { IYUSD } from "./interfaces/IYUSD.sol";
import { IAegisConfig } from "./interfaces/IAegisConfig.sol";
import { IAegisRewardsEvents, IAegisRewardsErrors } from "./interfaces/IAegisRewards.sol";

/**
 * @title AegisRewardsV2
 * @notice Refactored rewards contract with daily updates and cross-chain distribution support
 * @dev Key changes from AegisRewards:
 *      - Rewards deposited to current week snapshot (not previous)
 *      - Daily reward updates without closing snapshot
 *      - On-chain storage of user rewards data
 *      - Rescue function for admin to recover stuck rewards
 *      - Cross-chain distribution support via bridges
 */
contract AegisRewardsV2 is IAegisRewardsEvents, IAegisRewardsErrors, AccessControlDefaultAdminRules, ReentrancyGuard {
    using EnumerableMap for EnumerableMap.Bytes32ToUintMap;
    using SafeERC20 for IYUSD;
    using SafeERC20 for IERC20;
    using ClaimRewardsLib for ClaimRewardsLib.ClaimRequest;

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

    /// @notice Daily update data
    struct DailyUpdate {
        uint256 timestamp;
        uint256 totalDeposited;
        uint256 stakingShare;
        uint256 usersShare;
    }

    /// @dev role enabling to finalize and withdraw expired rewards
    bytes32 private constant REWARDS_MANAGER_ROLE = keccak256("REWARDS_MANAGER_ROLE");

    /// @dev role for daily updates
    bytes32 private constant DAILY_UPDATER_ROLE = keccak256("DAILY_UPDATER_ROLE");

    /// @dev role for cross-chain distribution
    bytes32 private constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    /// @dev EIP712 domain
    bytes32 private constant EIP712_DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    /// @dev EIP712 name
    bytes32 private constant EIP712_NAME = keccak256("AegisRewardsV2");

    /// @dev holds EIP712 revision
    bytes32 private constant EIP712_REVISION = keccak256("1");

    /// @notice YUSD token contract
    IYUSD public immutable yusd;

    /// @notice Aegis config contract
    IAegisConfig public aegisConfig;

    /// @notice AegisMinting contract address
    address public aegisMinting;

    /// @notice AegisIncomeRouter contract address
    address public aegisIncomeRouter;

    /// @notice Staking contract address (for cross-chain distribution)
    address public stakingContract;

    /// @dev Map of reward ids to rewards amounts
    mapping(bytes32 => Reward) private _rewards;

    /// @dev Mapping of user addresses to reward ids to bool indicating if user already claimed
    mapping(address => mapping(bytes32 => bool)) private _addressClaimedRewards;

    /// @dev Total amount of YUSD reserved for rewards (prevent double spending)
    uint256 private _totalReservedRewards;

    /// @dev On-chain user rewards storage: snapshotId => user => UserRewardData
    mapping(bytes32 => mapping(address => UserRewardData)) private _userRewards;

    /// @dev Snapshot daily updates: snapshotId => day => DailyUpdate
    mapping(bytes32 => mapping(uint256 => DailyUpdate)) private _dailyUpdates;

    /// @dev Current day index for each snapshot
    mapping(bytes32 => uint256) private _currentDay;

    /// @dev Cross-chain distribution: snapshotId => chainId => ChainDistribution
    mapping(bytes32 => mapping(uint32 => ChainDistribution)) private _chainDistributions;

    /// @dev List of supported chain IDs for distribution
    uint32[] private _supportedChains;

    /// @dev Mapping to track if chain is already configured
    mapping(uint32 => bool) private _chainConfigured;

    /// @dev holds computable chain id
    uint256 private immutable _chainId;

    /// @dev holds computable domain separator
    bytes32 private immutable _domainSeparator;

    /// @dev Flag to indicate if this is the main chain (ETH)
    bool public immutable isMainChain;

    // ============================================
    // EVENTS
    // ============================================

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

    // ============================================
    // ERRORS
    // ============================================

    error AlreadyClaimed();
    error InvalidChain();
    error AlreadyBridged();
    error NotMainChain();
    error SnapshotNotFinalized();
    error UserRewardsNotSet();
    error ChainAlreadyConfigured();
    error InvalidSnapshotId();

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(
        IYUSD _yusd,
        IAegisConfig _aegisConfig,
        address _admin,
        bool _isMainChain
    ) AccessControlDefaultAdminRules(3 days, _admin) {
        if (address(_yusd) == address(0)) revert ZeroAddress();
        if (address(_aegisConfig) == address(0)) revert ZeroAddress();

        yusd = _yusd;
        _setAegisConfigAddress(_aegisConfig);
        isMainChain = _isMainChain;

        _chainId = block.chainid;
        _domainSeparator = _computeDomainSeparator();
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /// @dev Return cached value if chainId matches cache, otherwise recomputes separator
    /// @return The domain separator at current chain
    function getDomainSeparator() public view returns (bytes32) {
        if (block.chainid == _chainId) {
            return _domainSeparator;
        }
        return _computeDomainSeparator();
    }

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

    /// @dev Returns daily update for a snapshot
    function getDailyUpdate(bytes32 snapshotId, uint256 day) public view returns (DailyUpdate memory) {
        return _dailyUpdates[snapshotId][day];
    }

    /// @dev Returns current day for a snapshot
    function getCurrentDay(bytes32 snapshotId) public view returns (uint256) {
        return _currentDay[snapshotId];
    }

    /// @dev Returns chain distribution for a snapshot
    function getChainDistribution(bytes32 snapshotId, uint32 chainId) public view returns (ChainDistribution memory) {
        return _chainDistributions[snapshotId][chainId];
    }

    /// @dev Returns list of supported chains
    function getSupportedChains() public view returns (uint32[] memory) {
        return _supportedChains;
    }

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    /// @dev Adds minted YUSD rewards from AegisMintingContract or AegisIncomeRouter
    /// @notice In V2, rewards are deposited to the CURRENT week snapshot
    function depositRewards(bytes calldata requestId, uint256 amount) external {
        require(_msgSender() == aegisMinting || _msgSender() == aegisIncomeRouter, "Unauthorized");

        bytes32 id = _stringToBytes32(abi.decode(requestId, (string)));
        _rewards[id].amount += amount;
        _totalReservedRewards += amount;

        emit DepositRewards(id, amount, block.timestamp);
    }

    // ============================================
    // DAILY UPDATE FUNCTIONS
    // ============================================

    /**
     * @notice Perform daily rewards update
     * @dev Updates rewards distribution for today based on current balances
     *      Does NOT finalize the snapshot - allows continuous updates
     * @param snapshotId The snapshot identifier
     * @param stakingBalance Current staking balance
     * @param totalEligibleBalance Total balance eligible for rewards (staking + users)
     */
    function updateDailyRewards(
        bytes32 snapshotId,
        uint256 stakingBalance,
        uint256 totalEligibleBalance
    ) external onlyRole(DAILY_UPDATER_ROLE) {
        if (totalEligibleBalance == 0) revert ZeroRewards();

        uint256 currentDayIndex = _currentDay[snapshotId];
        uint256 totalDeposited = _rewards[snapshotId].amount;

        // Calculate proportional distribution
        uint256 stakingShare = (totalDeposited * stakingBalance) / totalEligibleBalance;
        uint256 usersShare = totalDeposited - stakingShare;

        // Store daily update
        _dailyUpdates[snapshotId][currentDayIndex] = DailyUpdate({
            timestamp: block.timestamp,
            totalDeposited: totalDeposited,
            stakingShare: stakingShare,
            usersShare: usersShare
        });

        // Increment day counter
        _currentDay[snapshotId] = currentDayIndex + 1;

        emit DailyRewardsUpdate(
            snapshotId,
            currentDayIndex,
            totalDeposited,
            stakingShare,
            usersShare,
            block.timestamp
        );
    }

    /**
     * @notice Send staking rewards to staking contract
     * @dev Called after daily update to distribute staking portion
     * @param snapshotId The snapshot identifier
     * @param amount Amount to send to staking
     */
    function sendToStaking(bytes32 snapshotId, uint256 amount) external onlyRole(DAILY_UPDATER_ROLE) {
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
     * @notice Set user rewards on-chain
     * @dev Allows storing rewards data on-chain so backend is not required for claiming
     * @param snapshotId The snapshot identifier
     * @param users Array of user addresses
     * @param amounts Array of reward amounts
     */
    function setUserRewards(
        bytes32 snapshotId,
        address[] calldata users,
        uint256[] calldata amounts
    ) external onlyRole(REWARDS_MANAGER_ROLE) {
        if (snapshotId == bytes32(0)) revert InvalidSnapshotId();
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
    }

    /**
     * @notice Claim rewards using on-chain stored data
     * @dev Alternative to signature-based claiming - uses on-chain storage
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
    // SIGNATURE-BASED CLAIMING (legacy compatible)
    // ============================================

    /// @dev Transfers rewards at ids to a caller
    function claimRewards(ClaimRewardsLib.ClaimRequest calldata claimRequest, bytes calldata signature) external nonReentrant {
        claimRequest.verify(getDomainSeparator(), aegisConfig.trustedSigner(), signature);

        uint256 count = 0;
        uint256 totalAmount = 0;
        bytes32[] memory claimedIds = new bytes32[](claimRequest.ids.length);
        uint256 len = claimRequest.ids.length;
        for (uint256 i = 0; i < len; i++) {
            if (
                !_rewards[claimRequest.ids[i]].finalized ||
                _rewards[claimRequest.ids[i]].amount == 0 ||
                (_rewards[claimRequest.ids[i]].expiry > 0 && _rewards[claimRequest.ids[i]].expiry < block.timestamp) ||
                _addressClaimedRewards[_msgSender()][claimRequest.ids[i]]
            ) {
                continue;
            }

            _addressClaimedRewards[_msgSender()][claimRequest.ids[i]] = true;
            _rewards[claimRequest.ids[i]].amount -= claimRequest.amounts[i];
            _totalReservedRewards -= claimRequest.amounts[i];
            totalAmount += claimRequest.amounts[i];
            claimedIds[count] = claimRequest.ids[i];
            count++;
        }

        if (totalAmount == 0) {
            revert ZeroRewards();
        }

        yusd.safeTransfer(_msgSender(), totalAmount);

        /// @solidity memory-safe-assembly
        assembly {
            mstore(claimedIds, count)
        }

        emit ClaimRewards(_msgSender(), claimedIds, totalAmount);
    }

    // ============================================
    // CROSS-CHAIN DISTRIBUTION
    // ============================================

    /**
     * @notice Configure a chain for cross-chain distribution
     * @param chainId The chain ID
     * @param rewardsContract The rewards contract address on that chain
     * @param add True to add, false to remove
     */
    function configureChain(
        uint32 chainId,
        address rewardsContract,
        bool add
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (add) {
            if (rewardsContract == address(0)) revert ZeroAddress();
            if (_chainConfigured[chainId]) revert ChainAlreadyConfigured();
            _chainConfigured[chainId] = true;
            _supportedChains.push(chainId);
        } else {
            if (!_chainConfigured[chainId]) revert InvalidChain();
            _chainConfigured[chainId] = false;
            // Remove chain from supported list
            for (uint256 i = 0; i < _supportedChains.length; i++) {
                if (_supportedChains[i] == chainId) {
                    _supportedChains[i] = _supportedChains[_supportedChains.length - 1];
                    _supportedChains.pop();
                    break;
                }
            }
        }
        emit ChainConfigured(chainId, rewardsContract, add);
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
     * @notice Mark chain distribution as bridged
     * @dev Called after bridge transaction is initiated
     * @param snapshotId The snapshot identifier
     * @param chainId The chain ID that was bridged to
     */
    function markAsBridged(bytes32 snapshotId, uint32 chainId) external onlyRole(DISTRIBUTOR_ROLE) {
        ChainDistribution storage dist = _chainDistributions[snapshotId][chainId];
        if (dist.chainId == 0) revert InvalidChain();
        if (dist.bridged) revert AlreadyBridged();

        dist.bridged = true;
        _rewards[snapshotId].amount -= dist.amount;
        _totalReservedRewards -= dist.amount;

        emit CrossChainDistribution(snapshotId, chainId, dist.rewardsContract, dist.amount);
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

    /// @dev Sets new AegisConfig address
    function setAegisConfigAddress(IAegisConfig _aegisConfig) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setAegisConfigAddress(_aegisConfig);
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

    // ============================================
    // INTERNAL FUNCTIONS
    // ============================================

    function _setAegisConfigAddress(IAegisConfig _aegisConfig) internal {
        if (address(_aegisConfig) != address(0) && !IERC165(address(_aegisConfig)).supportsInterface(type(IAegisConfig).interfaceId)) {
            revert InvalidAddress();
        }

        aegisConfig = _aegisConfig;
        emit SetAegisConfigAddress(address(aegisConfig));
    }

    function _stringToBytes32(string memory source) private pure returns (bytes32 result) {
        bytes memory str = bytes(source);
        if (str.length == 0) {
            return 0x0;
        }

        assembly {
            result := mload(add(source, 32))
        }
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN, EIP712_NAME, EIP712_REVISION, block.chainid, address(this)));
    }
}
