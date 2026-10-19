// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { AggregatorV3Interface } from "./AegisVault/interfaces/AggregatorV3Interface.sol";

/// @dev Ondo's USDY price oracle. Not Chainlink-shaped: no rounds, no decimals getter.
interface IOndoPriceOracle {
    /// @return price USDY/USD with 18 decimals
    function getPrice() external view returns (uint256 price);

    /// @return price USDY/USD with 18 decimals
    /// @return timestamp unix seconds the price was last written
    function getPriceData() external view returns (uint256 price, uint256 timestamp);
}

/**
 * @title OndoPriceFeedAdapter
 * @notice Presents Ondo's USDY oracle through AggregatorV3Interface, so JUSDAssetGuard can price
 *         USDY with the same validated path it uses for Chainlink feeds.
 *
 * @dev Ondo exposes `getPrice()` and `getPriceData()` — no `latestRoundData`, no `decimals`, no
 *      rounds. This wraps it rather than teaching the guard a second oracle shape: the guard keeps
 *      one price path to audit, and a real Chainlink USDY feed can later replace this adapter
 *      through `setPriceFeed` with no contract change.
 *
 *      `getPriceData` carries the write timestamp, so staleness is real here, not assumed: the
 *      guard compares it against the per-asset heartbeat and fails closed on a stale answer.
 *
 *      Decimals are fixed at 18, matching the deployed Ondo oracle (verified live: getPrice()
 *      returned 1148778020000000000 for $1.148778). This adapter is specific to that shape — an
 *      oracle with different precision needs its own adapter, never a reconfiguration of this one,
 *      because a wrong decimals value misprices silently by a factor of ten.
 *
 *      Rounds: Ondo has none, so `roundId` and `answeredInRound` both report the price timestamp.
 *      That is monotonic, equal to each other (so the guard's `answeredInRound >= roundId` check
 *      passes), and changes whenever the price does. Historical lookups have no backing data and
 *      revert rather than invent an answer.
 */
contract OndoPriceFeedAdapter is AggregatorV3Interface {
    /// @notice The Ondo oracle being wrapped
    IOndoPriceOracle public immutable oracle;

    /// @dev Ondo publishes USDY/USD with 18 decimals
    uint8 private constant DECIMALS = 18;

    string private _description;

    error NoHistoricalData();
    error ZeroAddress();

    constructor(address _oracle, string memory description_) {
        if (_oracle == address(0)) revert ZeroAddress();
        oracle = IOndoPriceOracle(_oracle);
        _description = description_;
    }

    function decimals() external pure override returns (uint8) {
        return DECIMALS;
    }

    function description() external view override returns (string memory) {
        return _description;
    }

    function version() external pure override returns (uint256) {
        return 1;
    }

    /**
     * @notice Current USDY/USD price in AggregatorV3 shape
     * @dev A price that does not fit int256 would otherwise wrap to negative and read as valid to
     *      a consumer checking `answer > 0`, so it is rejected outright.
     */
    function latestRoundData()
        external
        view
        override
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        (uint256 price, uint256 timestamp) = oracle.getPriceData();
        require(price <= uint256(type(int256).max), "Price overflow");

        roundId = uint80(timestamp);
        answer = int256(price);
        startedAt = timestamp;
        updatedAt = timestamp;
        answeredInRound = roundId;
    }

    /// @dev Ondo keeps no round history; inventing one would let a consumer trust a fabricated price
    function getRoundData(uint80)
        external
        pure
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert NoHistoricalData();
    }
}
