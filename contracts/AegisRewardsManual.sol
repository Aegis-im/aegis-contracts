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

contract AegisRewardsManual is IAegisRewardsEvents, IAegisRewardsErrors, AccessControlDefaultAdminRules, ReentrancyGuard {
  using EnumerableMap for EnumerableMap.Bytes32ToUintMap;
  using SafeERC20 for IYUSD;
  using ClaimRewardsLib for ClaimRewardsLib.ClaimRequest;

  struct Reward {
    uint256 amount;
    uint256 expiry;
    bool finalized;
  }

  struct ClaimRewardsRequest {
    bytes32[] ids;
    uint256[] amounts;
  }

  /// @dev role enabling to finalize and withdraw expired rewards
  bytes32 private constant REWARDS_MANAGER_ROLE = keccak256("REWARDS_MANAGER_ROLE");

  /// @dev EIP712 domain
  bytes32 private constant EIP712_DOMAIN = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

  /// @dev EIP712 name
  bytes32 private constant EIP712_NAME = keccak256("AegisRewardsManual");

  /// @dev holds EIP712 revision
  bytes32 private constant EIP712_REVISION = keccak256("1");

  IYUSD public immutable yusd;

  IAegisConfig public aegisConfig;

  /// @dev Map of reward ids to rewards amounts
  mapping(bytes32 => Reward) private _rewards;

  /// @dev Mapping of user addresses to reward ids to bool indicating if user already claimed
  mapping(address => mapping(bytes32 => bool)) private _addressClaimedRewards;

  /// @dev Total amount of YUSD reserved for rewards (prevent double spending)
  uint256 private _totalReservedRewards;

  /// @dev holds computable chain id
  uint256 private immutable _chainId;

  /// @dev holds computable domain separator
  bytes32 private immutable _domainSeparator;

  constructor(IYUSD _yusd, IAegisConfig _aegisConfig, address _admin) AccessControlDefaultAdminRules(3 days, _admin) {
    if (address(_yusd) == address(0)) revert ZeroAddress();
    if (address(_aegisConfig) == address(0)) revert ZeroAddress();

    yusd = _yusd;
    _setAegisConfigAddress(_aegisConfig);

    _chainId = block.chainid;
    _domainSeparator = _computeDomainSeparator();
  }

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

  /// @dev Adds YUSD rewards from admin (alternative to depositRewards from minting contract)
  function depositRewards(bytes calldata requestId, uint256 amount) external onlyRole(REWARDS_MANAGER_ROLE) {
    // Check if contract has enough YUSD balance for this deposit
    uint256 availableBalance = yusd.balanceOf(address(this)) - _totalReservedRewards;
    if (availableBalance < amount) {
      revert InsufficientContractBalance();
    }

    bytes32 id = _stringToBytes32(abi.decode(requestId, (string)));
    _rewards[id].amount += amount;
    _totalReservedRewards += amount;

    emit DepositRewards(id, amount, block.timestamp);
  }

  /// @dev Sets new AegisConfig address
  function setAegisConfigAddress(IAegisConfig _aegisConfig) external onlyRole(DEFAULT_ADMIN_ROLE) {
    _setAegisConfigAddress(_aegisConfig);
  }

  /// @dev Rescue ERC20 tokens from contract balance
  function rescueAssets(IERC20 token) external onlyRole(DEFAULT_ADMIN_ROLE) {
    address admin = msg.sender;

    uint256 balance = token.balanceOf(address(this));
    if (balance == 0) revert NoTokensToRescue();

    SafeERC20.safeTransfer(token, admin, balance);
    emit RescueAssets(address(token), admin, balance);
  }

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
