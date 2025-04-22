// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

/**
 * @title IStYUSD
 * @dev Interface for the StYUSD (Staked YUSD) token.
 */
interface IStYUSD is IERC20Permit, IERC20Metadata {
    /**
     * @dev Stake YUSD to receive stYUSD
     * @param yusdAmount Amount of YUSD to stake
     */
    function stake(uint256 yusdAmount) external;

    /**
     * @dev Unstake stYUSD to receive YUSD
     * @param stYUSDAmount Amount of stYUSD to unstake
     */
    function unstake(uint256 stYUSDAmount) external;

    /**
     * @dev Add rewards to the staking pool (increases stYUSD value)
     * @param yusdAmount Amount of YUSD to add as rewards
     */
    function addRewards(uint256 yusdAmount) external;

    /**
     * @dev Get the exchange rate of stYUSD to YUSD
     * @return Amount of YUSD that 1 stYUSD is worth
     */
    function getExchangeRate() external view returns (uint256);

    /**
     * @dev Calculate the amount of stYUSD for a given amount of YUSD
     * @param yusdAmount Amount of YUSD
     * @return Amount of stYUSD
     */
    function getStYUSDForYUSD(uint256 yusdAmount) external view returns (uint256);

    /**
     * @dev Calculate the amount of YUSD for a given amount of stYUSD
     * @param stYUSDAmount Amount of stYUSD
     * @return Amount of YUSD
     */
    function getYUSDForStYUSD(uint256 stYUSDAmount) external view returns (uint256);

    /**
     * @dev Get total amount of YUSD held by the contract
     */
    function totalYUSDHeld() external view returns (uint256);

    /**
     * @dev Get the last stake timestamp for a user
     * @param account The user's address
     * @return The timestamp of the last stake
     */
    function lastStakeTimestamp(address account) external view returns (uint256);

    /**
     * @dev Rescue YUSD tokens sent directly to the contract
     * @param to Address to send the rescued tokens to
     * @param amount Amount of YUSD to rescue
     */
    function rescueYUSD(address to, uint256 amount) external;

    /**
     * @dev Rescue ERC20 tokens (other than YUSD) sent directly to the contract
     * @param token Address of the ERC20 token
     * @param to Address to send the rescued tokens to
     * @param amount Amount of tokens to rescue
     */
    function rescueERC20(address token, address to, uint256 amount) external;
}

/**
 * @title IStYUSDErrors
 * @dev Custom errors for the StYUSD contract.
 */
interface IStYUSDErrors {
    /**
     * @dev Error thrown when an address parameter is zero.
     * @param paramName Name of the parameter that was zero
     */
    error ZeroAddress(string paramName);

    /**
     * @dev Error thrown when staking is disabled.
     */
    error StakingDisabled();

    /**
     * @dev Error thrown when unstaking is disabled.
     */
    error UnstakingDisabled();

    /**
     * @dev Error thrown when a zero amount is provided.
     */
    error ZeroAmount();

    /**
     * @dev Error thrown when the output amount is zero.
     */
    error ZeroOutputAmount();

    /**
     * @dev Error thrown when attempting to stake less than the minimum amount.
     * @param provided Amount provided
     * @param minimum Minimum allowed amount
     */
    error BelowMinStakeAmount(uint256 provided, uint256 minimum);

    /**
     * @dev Error thrown when attempting to stake more than the maximum amount.
     * @param provided Amount provided
     * @param maximum Maximum allowed amount
     */
    error AboveMaxStakeAmount(uint256 provided, uint256 maximum);

    /**
     * @dev Error thrown when there are no stakers (total supply is zero).
     */
    error NoStakers();

    /**
     * @dev Error thrown when cooldown period is still active.
     * @param earliestUnstakeTime Timestamp when unstaking will be allowed
     */
    error CooldownActive(uint256 earliestUnstakeTime);

    /**
     * @dev Error thrown when contract doesn't have enough balance for the operation.
     * @param requested Amount requested
     * @param available Amount available
     */
    error InsufficientContractBalance(uint256 requested, uint256 available);

    /**
     * @dev Error thrown when attempting to rescue more YUSD than available.
     * @param requested Amount requested
     * @param rescuable Amount available for rescue
     */
    error InsufficientRescuableAmount(uint256 requested, uint256 rescuable);

    /**
     * @dev Error thrown when attempting to rescue the underlying asset through rescueERC20.
     */
    error CannotRescueUnderlyingAsset();
} 