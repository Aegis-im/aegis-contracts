// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

/* solhint-disable var-name-mixedcase  */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title YUSDSilo
 * @notice The Silo allows to store YUSD during the stake cooldown process.
 */
contract sYUSDSilo {
  address immutable _STAKING_VAULT;
  IERC20 immutable _YUSD;

  error OnlyStakingVault();

  constructor(address stakingVault, address yusd) {
    _STAKING_VAULT = stakingVault;
    _YUSD = IERC20(yusd);
  }

  modifier onlyStakingVault() {
    if (msg.sender != _STAKING_VAULT) revert OnlyStakingVault();
    _;
  }

  function withdraw(address to, uint256 amount) external onlyStakingVault {
    _YUSD.transfer(to, amount);
  }

  function getYUSD() external view returns (address) {
    return address(_YUSD);
  }

  function getStakingVault() external view returns (address) {
    return _STAKING_VAULT;
  }
}