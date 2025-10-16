// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract MockUSDT is ERC20, Ownable {
  uint8 private _decimals;

  constructor(
    string memory name,
    string memory symbol,
    uint8 decimalsValue,
    address initialOwner
  ) ERC20(name, symbol) Ownable(initialOwner) {
    _decimals = decimalsValue;
  }

  function decimals() public view virtual override returns (uint8) {
    return _decimals;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
