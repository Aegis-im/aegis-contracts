// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

/* solhint-disable var-name-mixedcase  */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title TokenSilo
 * @notice The Silo allows to store Token during the stake cooldown process.
 */
contract VaultStakingSilo {
  using SafeERC20 for IERC20;
  address immutable _STAKING_VAULT;
  IERC20 immutable _Token;

  error OnlyStakingVault();

  constructor(address stakingVault, address token) {
    _STAKING_VAULT = stakingVault;
    _Token = IERC20(token);
  }

  modifier onlyStakingVault() {
    if (msg.sender != _STAKING_VAULT) revert OnlyStakingVault();
    _;
  }

  function withdraw(address to, uint256 amount) external onlyStakingVault {
    _Token.safeTransfer(to, amount);
  }

  function getToken() external view returns (address) {
    return address(_Token);
  }

  function getStakingVault() external view returns (address) {
    return _STAKING_VAULT;
  }
}