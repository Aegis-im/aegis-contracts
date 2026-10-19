// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Stands in for Ondo's USDY oracle in tests: getPrice/getPriceData, no rounds, no decimals.
contract MockOndoOracle {
    uint256 public price;
    uint256 public timestamp;

    constructor(uint256 _price) {
        price = _price;
        timestamp = block.timestamp;
    }

    function setPrice(uint256 _price) external {
        price = _price;
        timestamp = block.timestamp;
    }

    /// @dev Lets a test age or forward-date the answer without moving the chain clock
    function setTimestamp(uint256 _timestamp) external {
        timestamp = _timestamp;
    }

    function getPrice() external view returns (uint256) {
        return price;
    }

    function getPriceData() external view returns (uint256, uint256) {
        return (price, timestamp);
    }
}
