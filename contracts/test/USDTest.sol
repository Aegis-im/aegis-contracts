// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title USDTest
 * @notice Mock USD collateral for testnet deployments. Six decimals, to mirror USDC.
 * @dev The owner mints without limit, so a test deployment can be funded on demand. This has no
 *      supply cap, no backing and no transfer restrictions — it exists to exercise the protocol on
 *      a testnet and must never be deployed to a production network.
 */
contract USDTest is ERC20, Ownable2Step {
    event Minted(address indexed to, uint256 amount);

    constructor(address _owner) ERC20("USD Test", "USDTest") Ownable(_owner) {}

    /// @notice Mock collateral mirrors USDC's six decimals
    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mints any amount to any address
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
        emit Minted(to, amount);
    }

    /// @notice Burns from the caller's own balance, to undo a mint that overshot
    function burn(uint256 amount) external {
        _burn(_msgSender(), amount);
    }
}
