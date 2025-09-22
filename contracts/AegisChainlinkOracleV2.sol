// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

// Morpho ChainlinkOracle V2 imports
import { IOracle } from "./interfaces/IOracle.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { IERC4626 } from "./interfaces/IERC4626.sol";
import { IMorphoChainlinkOracleV2 } from "./interfaces/IMorphoChainlinkOracleV2.sol";

/// @title AegisChainlinkOracleV2
/// @notice Aegis Oracle with manual price updates for Morpho Blue compatibility
/// @dev YUSD is a stablecoin pegged to 1 USD. Uses operator-set prices only (no Chainlink feeds)
contract AegisChainlinkOracleV2 is Ownable2Step, IMorphoChainlinkOracleV2 {
  using Math for uint256;

  struct YUSDUSDPriceData {
    int256 price;
    uint32 timestamp;
  }

  YUSDUSDPriceData private _priceData;
  mapping(address => bool) private _operators;

  /* IMMUTABLES - Required by IMorphoChainlinkOracleV2 */

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to address(0) since we work with ERC-20 tokens, not ERC4626 vaults
  IERC4626 public immutable BASE_VAULT;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to 1 as required when vault is address(0)
  uint256 public immutable BASE_VAULT_CONVERSION_SAMPLE;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to address(0) since we work with ERC-20 tokens, not ERC4626 vaults
  IERC4626 public immutable QUOTE_VAULT;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to 1 as required when vault is address(0)
  uint256 public immutable QUOTE_VAULT_CONVERSION_SAMPLE;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to address(0) since we use manual price updates only
  AggregatorV3Interface public immutable BASE_FEED_1;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to address(0) since we use manual price updates only
  AggregatorV3Interface public immutable BASE_FEED_2;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to address(0) since we use manual price updates only
  AggregatorV3Interface public immutable QUOTE_FEED_1;

  /// @inheritdoc IMorphoChainlinkOracleV2
  /// @dev Set to address(0) since we use manual price updates only
  AggregatorV3Interface public immutable QUOTE_FEED_2;

  /// @inheritdoc IMorphoChainlinkOracleV2
  uint256 public immutable SCALE_FACTOR;



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

  constructor(
    address[] memory operators,
    address initialOwner
  ) Ownable(initialOwner) {
    if (initialOwner == address(0)) revert ZeroAddress();

    // Initialize immutable variables for Morpho compatibility
    // No ERC4626 vaults - set to zero address
    BASE_VAULT = IERC4626(address(0));
    BASE_VAULT_CONVERSION_SAMPLE = 1; // Required to be 1 when vault is zero address
    QUOTE_VAULT = IERC4626(address(0));
    QUOTE_VAULT_CONVERSION_SAMPLE = 1; // Required to be 1 when vault is zero address
    
    // All Chainlink feeds set to zero address (not used)
    BASE_FEED_1 = AggregatorV3Interface(address(0));
    BASE_FEED_2 = AggregatorV3Interface(address(0));
    QUOTE_FEED_1 = AggregatorV3Interface(address(0));
    QUOTE_FEED_2 = AggregatorV3Interface(address(0));



    // Calculate scale factor for price conversion
    // For YUSD (8 decimals) to 1e36 format: scale = 1e28
    SCALE_FACTOR = 10 ** (36 - 8); // = 1e28

    // Set operators
    for (uint256 i = 0; i < operators.length; i++) {
      _setOperator(operators[i], true);
    }
  }

  function decimals() public pure returns (uint8) {
    return 8;
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
  function updateYUSDPrice(int256 newPrice) external onlyOperator {
    _priceData.price = newPrice;
    _priceData.timestamp = uint32(block.timestamp);
    emit UpdateYUSDPrice(_priceData.price, _priceData.timestamp);
  }

  /// @dev Adds/removes operator
  function setOperator(address operator, bool allowed) external onlyOwner {
    _setOperator(operator, allowed);
  }



  function _setOperator(address operator, bool allowed) internal {
    _operators[operator] = allowed;
    emit SetOperator(operator, allowed);
  }



  /// @inheritdoc IOracle
  /// @notice Returns the price of 1 asset of collateral token quoted in 1 asset of loan token, scaled by 1e36
  /// @dev For YUSD stablecoin, uses operator-set price only (manual mode)
  function price() external view returns (uint256) {
    if (_priceData.price <= 0) {
      // Default to 1 USD if no price set
      return 1e36;
    }
    
    // Scale from 8 decimals to 1e36 format using SCALE_FACTOR
    return uint256(_priceData.price) * SCALE_FACTOR;
  }
}
