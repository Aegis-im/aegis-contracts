// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.26;

/* solhint-disable var-name-mixedcase  */

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title JUSDSilo
 * @notice The Silo allows to store JUSD during the stake cooldown process.
 */
contract sJUSDSilo {
  address immutable _STAKING_VAULT;
  IERC20 immutable _JUSD;

  error OnlyStakingVault();

  constructor(address stakingVault, address jusd) {
    _STAKING_VAULT = stakingVault;
    _JUSD = IERC20(jusd);
  }

  modifier onlyStakingVault() {
    if (msg.sender != _STAKING_VAULT) revert OnlyStakingVault();
    _;
  }

  function withdraw(address to, uint256 amount) external onlyStakingVault {
    _JUSD.transfer(to, amount);
  }

  function getJUSD() external view returns (address) {
    return address(_JUSD);
  }

  function getStakingVault() external view returns (address) {
    return _STAKING_VAULT;
  }
}