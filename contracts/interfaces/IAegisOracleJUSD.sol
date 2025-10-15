// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IAegisOracleJUSD {
  function decimals() external pure returns (uint8);

  function jusdUSDPrice() external view returns (int256);

  function lastUpdateTimestamp() external view returns (uint32);
}
