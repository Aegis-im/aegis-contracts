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
import { IAegisRewardsErrors } from "./interfaces/IAegisRewards.sol";

/**
 * @title AegisRewardsV2
 * @notice Rewards contract with cumulative Merkle distribution
 *         and cross-chain support via LayerZero OFT bridging
 */
contract AegisRewardsV2 is IAegisRewardsErrors, AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IYUSD;
    using SafeERC20 for IERC20;

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

    /// @dev role for depositing rewards
    bytes32 private constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");

    /// @dev role for trusted signer operations
    bytes32 private constant TRUSTED_SIGNER_ROLE = keccak256("TRUSTED_SIGNER_ROLE");

    /// @notice YUSD token contract
    IYUSD public immutable yusd;

    /// @notice Staking contract address
    address public stakingContract;

    /// @notice OFT adapter for cross-chain bridging
    IOFT public oftAdapter;

    /// @notice Fixed address that receives rescued ETH and tokens — not the caller
    address public rescueTo;

    /// @dev Flag to indicate if this is the main chain (ETH)
    bool public immutable isMainChain;

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

    /// @dev Event emitted when rewards are deposited
    event DepositRewards(bytes requestId, uint256 amount, uint256 timestamp);

    /// @dev Event emitted when rewards are distributed to a chain
    event CrossChainDistribution(uint32 indexed chainId, address rewardsContract, uint256 amount);

    /// @dev Event emitted when user claims via cumulative Merkle proof
    event ClaimMerkleRewards(address indexed account, address indexed claimer, uint256 amount);

    /// @dev Event emitted when admin rescues Merkle rewards for a user
    event RescueMerkleRewards(address indexed user, address indexed to, uint256 amount);

    /// @dev Event emitted when funds are sent to staking
    event SendToStaking(address indexed stakingContract, uint256 amount);

    /// @dev Event emitted when staking contract is set
    event SetStakingContract(address indexed stakingContract);

    /// @dev Event emitted when chain is added/removed for distribution
    event ChainConfigured(uint32 indexed chainId, uint32 dstEid, address rewardsContract, bool added);

    /// @dev Event emitted when OFT adapter is set
    event SetOFTAdapter(address indexed oftAdapter);

    /// @dev Event emitted when rescue destination is updated
    event SetRescueTo(address indexed oldRescueTo, address indexed newRescueTo);

    /// @dev Event emitted when cumulative Merkle root is updated
    event SetMerkleRoot(bytes32 merkleRoot);

    /// @dev Event emitted when ERC20 tokens are rescued from contract
    event RescueAssets(address indexed token, address indexed to, uint256 amount);

    // ============================================
    // ERRORS
    // ============================================

    error InvalidChain();
    error NotMainChain();
    error ChainAlreadyConfigured();
    error OFTAdapterNotSet();
    error MerkleRootNotSet();
    error InvalidMerkleProof();
    error NothingToClaim();
    error InvalidNativeFee();

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(
        IYUSD _yusd,
        address _admin,
        bool _isMainChain,
        address _rescueTo
    ) AccessControlDefaultAdminRules(3 days, _admin) {
        if (address(_yusd) == address(0)) revert ZeroAddress();
        if (_rescueTo == address(0)) revert ZeroAddress();

        yusd = _yusd;
        isMainChain = _isMainChain;
        rescueTo = _rescueTo;
    }

    // ============================================
    // VIEW FUNCTIONS
    // ============================================

    /// @dev Returns available balance for new deposits
    function availableBalanceForDeposits() public view returns (uint256) {
        uint256 balance = yusd.balanceOf(address(this));
        if (balance <= _merklePoolBalance) return 0;
        return balance - _merklePoolBalance;
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
        uint32 chainId,
        uint256 amount,
        bytes calldata extraOptions
    ) public view returns (MessagingFee memory) {
        if (address(oftAdapter) == address(0)) revert OFTAdapterNotSet();

        ChainConfig storage config = _chainConfigs[chainId];
        if (!config.configured) revert InvalidChain();

        SendParam memory sendParam = SendParam({
            dstEid: config.dstEid,
            to: bytes32(uint256(uint160(config.rewardsContract))),
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: extraOptions,
            composeMsg: "",
            oftCmd: ""
        });

        return oftAdapter.quoteSend(sendParam, false);
    }

    // ============================================
    // DEPOSIT FUNCTIONS
    // ============================================

    /// @dev Adds rewards directly to the merkle pool
    function depositRewards(bytes calldata requestId, uint256 amount) external onlyRole(DEPOSITOR_ROLE) {
        _merklePoolBalance += amount;
        if (yusd.balanceOf(address(this)) < _merklePoolBalance) revert InsufficientContractBalance();
        emit DepositRewards(requestId, amount, block.timestamp);
    }

    // ============================================
    // STAKING FUNCTIONS
    // ============================================
    /// @notice Send staking rewards to staking contract
    function sendToStaking(uint256 amount) external onlyRole(TRUSTED_SIGNER_ROLE) {
        if (stakingContract == address(0)) revert ZeroAddress();
        if (amount > _merklePoolBalance) revert InsufficientContractBalance();
        
        _merklePoolBalance -= amount;
        yusd.safeTransfer(stakingContract, amount);
        emit SendToStaking(stakingContract, amount);
    }
    
    // ============================================
    // CUMULATIVE MERKLE REWARDS
    // ============================================

    /// @notice Set the cumulative Merkle root
    /// @param merkleRoot New cumulative Merkle root
    /// @param totalUnclaimedAmount Sum of (cumulativeAmount - cumulativeClaimed) for all users in the tree.
    ///        Used as a sanity check: reverts if the merkle pool cannot cover total unclaimed rewards.
    function setMerkleRoot(
        bytes32 merkleRoot,
        uint256 totalUnclaimedAmount
    ) external onlyRole(TRUSTED_SIGNER_ROLE) {
        if (merkleRoot == bytes32(0)) revert ZeroRewards();
        if (totalUnclaimedAmount > _merklePoolBalance) revert InsufficientContractBalance();

        _currentMerkleRoot = merkleRoot;

        emit SetMerkleRoot(merkleRoot);
    }

    /// @notice Claim rewards using a cumulative Merkle proof
    /// @dev Leaf = keccak256(bytes.concat(keccak256(abi.encode(account, msg.sender, cumulativeAmount))))
    ///      _cumulativeClaimed keyed by account, funds sent to msg.sender (claimer).
    ///      The Merkle tree must contain only one entry per account to prevent claim conflicts.
    function claimMerkleRewards(
        address account,
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external nonReentrant {
        if (_currentMerkleRoot == bytes32(0)) revert MerkleRootNotSet();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, _msgSender(), cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, _currentMerkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }

        uint256 claimable = cumulativeAmount - _cumulativeClaimed[account];
        if (claimable == 0) revert NothingToClaim();
        if (claimable > _merklePoolBalance) revert InsufficientContractBalance();

        _cumulativeClaimed[account] = cumulativeAmount;
        _merklePoolBalance -= claimable;

        yusd.safeTransfer(_msgSender(), claimable);

        emit ClaimMerkleRewards(account, _msgSender(), claimable);
    }

    /// @notice Rescue cumulative Merkle rewards for a user (e.g., lost wallet)
    function rescueMerkleRewards(
        address account,
        address claimer,
        address to,
        uint256 cumulativeAmount,
        bytes32[] calldata proof
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (_currentMerkleRoot == bytes32(0)) revert MerkleRootNotSet();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, claimer, cumulativeAmount))));
        if (!MerkleProof.verifyCalldata(proof, _currentMerkleRoot, leaf)) {
            revert InvalidMerkleProof();
        }

        uint256 claimable = cumulativeAmount - _cumulativeClaimed[account];
        if (claimable == 0) revert NothingToClaim();
        if (claimable > _merklePoolBalance) revert InsufficientContractBalance();

        _cumulativeClaimed[account] = cumulativeAmount;
        _merklePoolBalance -= claimable;

        yusd.safeTransfer(to, claimable);

        emit RescueMerkleRewards(account, to, claimable);
    }

    // ============================================
    // CROSS-CHAIN DISTRIBUTION
    // ============================================

    /// @notice Configure a chain for cross-chain distribution
    function configureChain(
        uint32 chainId,
        uint32 dstEid,
        address rewardsContract,
        bool add
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (add) {
            if (rewardsContract == address(0)) revert ZeroAddress();
            if (dstEid == 0) revert InvalidChain();
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

    /// @notice Bridge YUSD to a destination chain via LayerZero OFT adapter
    function bridgeToChain(
        uint32 chainId,
        uint256 amount,
        bytes calldata extraOptions
    ) external payable onlyRole(TRUSTED_SIGNER_ROLE) {
        _executeBridge(chainId, amount, msg.value, extraOptions);
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /// @dev Rescue ERC20 tokens from contract balance (excluding reserved rewards)
    function rescueAssets(IERC20 token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = token.balanceOf(address(this));

        // If rescuing YUSD, only rescue excess above reserved amount
        if (address(token) == address(yusd)) {
            if (balance <= _merklePoolBalance) revert NoTokensToRescue();
            balance = balance - _merklePoolBalance;
        }

        if (balance == 0) revert NoTokensToRescue();

        SafeERC20.safeTransfer(token, rescueTo, balance);
        emit RescueAssets(address(token), rescueTo, balance);
    }

    /// @dev Sets staking contract address. Set to address(0) to disable staking.
    function setStakingContract(address _stakingContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stakingContract = _stakingContract;
        emit SetStakingContract(_stakingContract);
    }

    /// @dev Updates the rescue destination address — cannot be set to zero
    function setRescueTo(address _rescueTo) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_rescueTo == address(0)) revert ZeroAddress();
        emit SetRescueTo(rescueTo, _rescueTo);
        rescueTo = _rescueTo;
    }

    /// @dev Sets OFT adapter for cross-chain bridging
    function setOFTAdapter(IOFT _oftAdapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        oftAdapter = _oftAdapter;
        emit SetOFTAdapter(address(_oftAdapter));
    }

    /// @dev Allow contract to receive native ETH (e.g., LayerZero fee refunds)
    receive() external payable {}

    /// @dev Rescue native ETH from contract
    function rescueETH() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NoTokensToRescue();

        (bool success, ) = rescueTo.call{value: balance}("");
        require(success);

        emit RescueAssets(address(0), rescueTo, balance);
    }

    // ============================================
    // INTERNAL FUNCTIONS
    // ============================================

    function _executeBridge(
        uint32 chainId,
        uint256 amount,
        uint256 nativeFee,
        bytes calldata extraOptions
    ) internal {
        if (!isMainChain) revert NotMainChain();
        if (address(oftAdapter) == address(0)) revert OFTAdapterNotSet();

        ChainConfig storage config = _chainConfigs[chainId];
        if (!config.configured) revert InvalidChain();
        if (amount > _merklePoolBalance) revert InsufficientContractBalance();

        _merklePoolBalance -= amount;

        // Approve OFT adapter to spend YUSD
        yusd.forceApprove(address(oftAdapter), amount);

        SendParam memory sendParam = SendParam({
            dstEid: config.dstEid,
            to: bytes32(uint256(uint160(config.rewardsContract))),
            amountLD: amount,
            minAmountLD: amount,
            extraOptions: extraOptions,
            composeMsg: "",
            oftCmd: ""
        });

        MessagingFee memory fee = MessagingFee({
            nativeFee: nativeFee,
            lzTokenFee: 0
        });

        oftAdapter.send{value: nativeFee}(sendParam, fee, _msgSender());

        emit CrossChainDistribution(chainId, config.rewardsContract, amount);
    }
}
