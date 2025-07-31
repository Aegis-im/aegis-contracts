// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OFT } from "@layerzerolabs/oft-evm/contracts/OFT.sol";

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { IYUSD, IYUSDErrors } from "./interfaces/IYUSD.sol";

contract YUSDOFT is OFT, ERC20Permit, IYUSDErrors {
  mapping(address => bool) public isBlackListed;

  event AddedBlackList(address _user);
  event RemovedBlackList(address _user);

  constructor(address _lzEndpoint, address _delegate) OFT("YUSD", "YUSD", _lzEndpoint, _delegate) Ownable(_delegate) ERC20Permit("YUSD") {}

  function getBlackListStatus(address _maker) external view returns (bool) {
    return isBlackListed[_maker];
  }

  function addBlackList(address _user) public onlyOwner {
    isBlackListed[_user] = true;

    emit AddedBlackList(_user);
  }

  function removeBlackList(address _user) public onlyOwner {
    isBlackListed[_user] = false;

    emit RemovedBlackList(_user);
  }

  function _update(address from, address to, uint256 value) internal virtual override(ERC20) {
    if (isBlackListed[from]) {
      revert Blacklisted(from);
    }
    if (isBlackListed[to]) {
      revert Blacklisted(to);
    }
    super._update(from, to, value);
  }
}
