// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { IMintableBurnable } from "@layerzerolabs/oft-evm/contracts/interfaces/IMintableBurnable.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IYUSD } from "./interfaces/IYUSD.sol";

contract ElevatedMinterBurner is IMintableBurnable, Ownable {
  IYUSD public immutable token;
  mapping(address => bool) public operators;

  modifier onlyOperators() {
    require(operators[msg.sender] || msg.sender == owner(), "Not authorized");
    _;
  }

  constructor(IYUSD _token, address _owner) Ownable(_owner) {
    token = _token;
  }

  function setOperator(address _operator, bool _status) external onlyOwner {
    operators[_operator] = _status;
  }

  function burn(address _from, uint256 _amount) external override onlyOperators returns (bool) {
    token.burnFrom(_from, _amount);
    return true;
  }

  function mint(address _to, uint256 _amount) external override onlyOperators returns (bool) {
    token.mint(_to, _amount);
    return true;
  }
}
