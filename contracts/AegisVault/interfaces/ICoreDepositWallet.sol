// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * @notice Minimal interface for Circle's CoreDepositWallet on HyperEVM — the contract HyperCore links
 *         USDC to. Depositing pulls USDC into the wallet and credits a HyperCore account.
 * @dev Signatures match circlefin's CoreDepositWallet (`depositFor` lives on IForwardDepositReceiver).
 */
interface ICoreDepositWallet {
    /// @notice Pulls `amount` from the caller and credits `recipient` on HyperCore
    /// @param destinationDex 0 for the Core perps dex, type(uint32).max for Core spot
    function depositFor(address recipient, uint256 amount, uint32 destinationDex) external;

    /// @notice The ERC-20 this wallet backs on HyperCore (USDC)
    function token() external view returns (address);
}
