// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/AggregatorV3Interface.sol";

contract VaultChainlinkOracleV3 is Ownable2Step, AggregatorV3Interface {
  struct USDPriceData {
    int256 price;
    uint32 timestamp;
  }

  USDPriceData private _priceData;

  mapping(address => bool) private _operators;

  struct RoundData {
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;
  }

  mapping(uint80 => RoundData) private _rounds;
  uint80 private _latestRoundId;

  event UpdatePrice(int256 price, uint32 timestamp);
  event SetOperator(address indexed operator, bool allowed);

  error ZeroAddress();
  error AccessForbidden();

  modifier onlyOperator() {
    if (!_operators[_msgSender()]) {
      revert AccessForbidden();
    }
    _;
  }

  uint8 private immutable _decimals;
  string private _description;

  constructor(string memory description_, uint8 decimals_, address[] memory _ops, address _initialOwner) Ownable(_initialOwner) {
    if (_initialOwner == address(0)) revert ZeroAddress();
    require(decimals_ <= 18, "Invalid decimals");
    _decimals = decimals_;
    _description = description_;

    for (uint256 i = 0; i < _ops.length; i++) {
      _setOperator(_ops[i], true);
    }
  }

  function decimals() public view override returns (uint8) {
    return _decimals;
  }

  function description() external view override returns (string memory) {
    return _description;
  }

  function version() external pure override returns (uint256) {
    return 1;
  }

  /// @dev Returns current token/USD price
  function USDPrice() public view returns (int256) {
    return _priceData.price;
  }

  /// @dev Returns timestamp of last price update
  function lastUpdateTimestamp() public view returns (uint32) {
    return _priceData.timestamp;
  }

  /**
   * @dev Updates price.
   * @dev Price uses the configured decimals
   */
  function updatePrice(int256 price) external onlyOperator {
    require(price > 0, "Invalid price");
    _priceData.price = price;
    _priceData.timestamp = uint32(block.timestamp);

    // update aggregator round data
    uint80 newRoundId = _latestRoundId + 1;
    _latestRoundId = newRoundId;
    _rounds[newRoundId] = RoundData({
      answer: price,
      startedAt: block.timestamp,
      updatedAt: block.timestamp,
      answeredInRound: newRoundId
    });
    emit UpdatePrice(_priceData.price, _priceData.timestamp);
  }

  function getRoundData(uint80 _roundId)
    external
    view
    override
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    )
  {
    RoundData memory r = _rounds[_roundId];
    if (r.updatedAt == 0) revert("No data present");
    return (_roundId, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
  }

  function latestRoundData()
    external
    view
    override
    returns (
      uint80 roundId,
      int256 answer,
      uint256 startedAt,
      uint256 updatedAt,
      uint80 answeredInRound
    )
  {
    uint80 id = _latestRoundId;
    RoundData memory r = _rounds[id];
    if (r.updatedAt == 0) revert("No data present");
    return (id, r.answer, r.startedAt, r.updatedAt, r.answeredInRound);
  }

  /// @dev Adds/removes operator
  function setOperator(address operator, bool allowed) external onlyOwner {
    _setOperator(operator, allowed);
  }

  function _setOperator(address operator, bool allowed) internal {
    _operators[operator] = allowed;
    emit SetOperator(operator, allowed);
  }
}
