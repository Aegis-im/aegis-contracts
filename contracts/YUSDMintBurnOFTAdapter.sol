// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.22;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { MintBurnOFTAdapter } from "@layerzerolabs/oft-evm/contracts/MintBurnOFTAdapter.sol";
import { IMintableBurnable } from "@layerzerolabs/oft-evm/contracts/interfaces/IMintableBurnable.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

contract YUSDMintBurnOFTAdapter is MintBurnOFTAdapter {
  constructor(
    address _token, // Your existing ERC20 token with mint/burn exposed
    IMintableBurnable _minterBurner, // Contract with mint/burn privileges
    address _lzEndpoint, // Local LayerZero endpoint
    address _owner // Contract owner
  ) MintBurnOFTAdapter(_token, _minterBurner, _lzEndpoint, _owner) Ownable(_owner) {}

  /**
   * @dev Returns the number of decimals used by the underlying token.
   * This is required for LayerZero OFT functionality.
   */
  function decimals() public view returns (uint8) {
    return IERC20Metadata(this.token()).decimals();
  }

  /**
   * @dev Returns the number of decimals used locally.
   * For YUSD this is the same as the token decimals (18).
   */
  function localDecimals() public view returns (uint8) {
    return IERC20Metadata(this.token()).decimals();
  }

  /**
   * @dev Returns the address of the YUSD token.
   * This is a convenience method for compatibility with test scripts.
   */
  function yusdToken() public view returns (address) {
    return this.token();
  }
}