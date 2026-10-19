// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { OFTAdapter } from "@layerzerolabs/oft-evm/contracts/OFTAdapter.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IVaultMintingCrossChain {
  function mintForCrossChain(address to, uint256 amount) external;
  function burnForCrossChain(address from, uint256 amount) external;
}

contract VaultMintBurnOFTAdapter is OFTAdapter {
  using SafeERC20 for IERC20;

  IVaultMintingCrossChain public immutable aegisMinting;

  constructor(
    address _token, // Token token address
    IVaultMintingCrossChain _aegisMinting, // VaultMinting contract (directly!)
    address _lzEndpoint, // Local LayerZero endpoint
    address _owner // Contract owner
  ) OFTAdapter(_token, _lzEndpoint, _owner) Ownable(_owner) {
    aegisMinting = _aegisMinting;
  }

  /**
   * @dev Override _debit to handle outgoing cross-chain transfers.
   * This is called when tokens need to be "burned" for cross-chain transfer.
   */
  function _debit(address _from, uint256 _amountLD, uint256 _minAmountLD, uint32 _dstEid)
    internal
    override
    returns (uint256 amountSentLD, uint256 amountReceivedLD)
  {
    // Calculate amounts with dust removed
    (amountSentLD, amountReceivedLD) = _debitView(_amountLD, _minAmountLD, _dstEid);

    // Transfer tokens from user to this contract first
    IERC20(this.token()).safeTransferFrom(_from, address(this), amountSentLD);

    // Approve VaultMinting to spend our tokens
    IERC20(this.token()).forceApprove(address(aegisMinting), amountSentLD);

    // Call VaultMinting to burn tokens from this contract (this contract must be a cross-chain operator)
    aegisMinting.burnForCrossChain(address(this), amountSentLD);

    return (amountSentLD, amountReceivedLD);
  }

  /**
   * @dev Override _credit to handle incoming cross-chain transfers.
   * This is called when tokens are received from another chain.
   */
  function _credit(address _to, uint256 _amountLD, uint32) 
    internal 
    override 
    returns (uint256 amountReceivedLD) 
  {
    // Call VaultMinting directly to mint tokens to the recipient
    aegisMinting.mintForCrossChain(_to, _amountLD);
    
    return _amountLD;
  }

  /**
   * @dev Returns the number of decimals used by the underlying token.
   * This is required for LayerZero OFT functionality.
   */
  function decimals() public view returns (uint8) {
    return IERC20Metadata(this.token()).decimals();
  }

  /**
   * @dev Returns the number of decimals used locally.
   * For Token this is the same as the token decimals (18).
   */
  function localDecimals() public view returns (uint8) {
    return IERC20Metadata(this.token()).decimals();
  }

  /**
   * @dev Returns the address of the Token token.
   * This is a convenience method for compatibility with test scripts.
   */
  function vaultToken() public view returns (address) {
    return this.token();
  }

  /**
   * @dev Returns the address of the VaultMinting contract.
   */
  function getVaultMinting() public view returns (address) {
    return address(aegisMinting);
  }
}