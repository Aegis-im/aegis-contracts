// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @notice Test double for Circle's CoreDepositWallet. Pulls the tokens with `transferFrom` and records
 *         the HyperCore credit, the way the real one emits a Transfer for HyperCore to pick up.
 * @dev Test-only. `mode` makes it misbehave so the depositor's balance-delta assertion can be proven.
 */
contract MockCoreDepositWallet {
    enum Mode { Normal, TakeNothing, TakeTwice, TakeAndRefund }

    Mode public mode;
    bool public paused;
    address public immutable token;

    struct Deposit {
        address caller;
        address recipient;
        uint256 amount;
        uint32 destinationDex;
    }
    Deposit[] public deposits;

    constructor(address _token) { token = _token; }

    function setMode(Mode _mode) external { mode = _mode; }
    function setPaused(bool _paused) external { paused = _paused; }
    function depositCount() external view returns (uint256) { return deposits.length; }

    function depositFor(address recipient, uint256 amount, uint32 destinationDex) external {
        require(!paused, "Pausable: paused");
        require(recipient != address(0), "Invalid recipient: zero address");

        if (mode == Mode.Normal) {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        } else if (mode == Mode.TakeTwice) {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
            IERC20(token).transferFrom(msg.sender, address(this), amount);
        } else if (mode == Mode.TakeAndRefund) {
            IERC20(token).transferFrom(msg.sender, address(this), amount);
            IERC20(token).transfer(msg.sender, amount / 2);
        }

        deposits.push(Deposit(msg.sender, recipient, amount, destinationDex));
    }
}
