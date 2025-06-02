// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title TimelockController
 * @dev This contract is a wrapper around OpenZeppelin's TimelockController
 * Used for time-delayed governance for upgradeable contracts
 */
contract TimelockControllerWrapper is TimelockController {
    /**
     * @dev Constructor for TimelockController
     * @param minDelay Minimum delay before an operation can be executed
     * @param proposers List of addresses that can propose operations
     * @param executors List of addresses that can execute operations
     * @param admin Optional admin address; can be zero address
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
} 