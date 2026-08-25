// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICurvePool
 * @notice Interface for Curve stableswap pools
 */
interface ICurvePool {
    function exchange(
        int128 i,
        int128 j,
        uint256 dx,
        uint256 min_dy
    ) external returns (uint256);

    function get_dy(
        int128 i,
        int128 j,
        uint256 dx
    ) external view returns (uint256);

    function coins(uint256 index) external view returns (address);
}
