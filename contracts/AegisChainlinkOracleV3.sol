// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/AggregatorV3Interface.sol";

contract AegisChainlinkOracleV3 is Ownable2Step, AggregatorV3Interface {
  struct YUSDUSDPriceData {
    int256 price;
    uint32 timestamp;
  }

  YUSDUSDPriceData private _priceData;

  mapping(address => bool) private _operators;

  struct RoundData {
    int256 answer;
    uint256 startedAt;
    uint256 updatedAt;
    uint80 answeredInRound;
  }

  mapping(uint80 => RoundData) private _rounds;
  uint80 private _latestRoundId;

  event UpdateYUSDPrice(int256 price, uint32 timestamp);
  event SetOperator(address indexed operator, bool allowed);

  error ZeroAddress();
  error AccessForbidden();

  modifier onlyOperator() {
    if (!_operators[_msgSender()]) {
      revert AccessForbidden();
    }
    _;
  }

  constructor(address[] memory _ops, address _initialOwner) Ownable(_initialOwner) {
    if (_initialOwner == address(0)) revert ZeroAddress();

    for (uint256 i = 0; i < _ops.length; i++) {
      _setOperator(_ops[i], true);
    }
  }

  function decimals() public pure override returns (uint8) {
    return 8;
  }

  function description() external pure override returns (string memory) {
    return "Aegis Oracle sYUSD / YUSD";
  }

  function version() external pure override returns (uint256) {
    return 1;
  }

  /// @dev Returns current YUSD/USD price
  function yusdUSDPrice() public view returns (int256) {
    return _priceData.price;
  }

  /// @dev Returns timestamp of last price update
  function lastUpdateTimestamp() public view returns (uint32) {
    return _priceData.timestamp;
  }

  /**
   * @dev Updates YUSD/USD price.
   * @dev Price should have 8 decimals
   */
  function updateYUSDPrice(int256 price) external onlyOperator {
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
    emit UpdateYUSDPrice(_priceData.price, _priceData.timestamp);
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
