// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Test double for Circle's CCTP v2 TokenMessenger. Pulls the tokens with `transferFrom` and
 *         burns them by holding them, the way the real one burns through the TokenMinter.
 * @dev Test-only. `mode` makes it misbehave so the guard's balance-delta assertion can be proven.
 */
contract MockTokenMessenger {
    enum Mode { Normal, TakeNothing, TakeTwice, TakeAndRefund }

    Mode public mode;
    address public localMinter;

    mapping(uint32 => bytes32) public remoteTokenMessengers;

    struct Burn {
        uint256 amount;
        uint32 domain;
        bytes32 mintRecipient;
        address burnToken;
        address caller;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
    }
    Burn[] public burns;

    constructor(uint32[] memory domains) {
        for (uint256 i = 0; i < domains.length; i++) {
            remoteTokenMessengers[domains[i]] = bytes32(uint256(uint160(address(this))));
        }
        localMinter = address(this);
    }

    function setMode(Mode _mode) external { mode = _mode; }
    function setLocalMinter(address minter) external { localMinter = minter; }
    function setRemoteTokenMessenger(uint32 domain, bytes32 messenger) external { remoteTokenMessengers[domain] = messenger; }

    uint256 private _burnLimit = type(uint256).max;
    function setBurnLimit(uint256 limit) external { _burnLimit = limit; }
    function burnLimitsPerMessage(address) external view returns (uint256) { return _burnLimit; }

    function burnCount() external view returns (uint256) { return burns.length; }

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external {
        require(remoteTokenMessengers[destinationDomain] != bytes32(0), "No TokenMessenger for domain");
        require(amount <= _burnLimit, "Burn amount exceeds per tx limit");

        if (mode == Mode.Normal) {
            IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        } else if (mode == Mode.TakeTwice) {
            // Only possible with a standing allowance larger than `amount`
            IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
            IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        } else if (mode == Mode.TakeAndRefund) {
            IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
            IERC20(burnToken).transfer(msg.sender, amount / 2);
        }
        // Mode.TakeNothing leaves the caller's balance untouched

        burns.push(Burn(amount, destinationDomain, mintRecipient, burnToken, msg.sender, destinationCaller, maxFee, minFinalityThreshold));
    }
}
