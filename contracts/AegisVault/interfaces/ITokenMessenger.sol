// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @notice Circle CCTP v2 TokenMessenger — burns USDC here and authorises an equal mint on the
 *         destination domain once Circle's attestation service signs the message.
 * @dev Mainnet 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d (same address on every CCTP v2 chain).
 *      Domains are Circle's own numbering, not chain ids: Ethereum 0, Avalanche 1, OP 2,
 *      Arbitrum 3, Solana 5, Base 6, Polygon PoS 7, HyperEVM 19. HyperEVM is served by v2 only —
 *      the v1 messenger has no route to it.
 */
interface ITokenMessenger {
    /**
     * @notice Burns `amount` of `burnToken` and emits the message that mints it on `destinationDomain`
     * @dev Pulls the tokens with `transferFrom`, so the caller must hold an allowance first. Returns
     *      nothing: a v2 message is identified by the burn transaction hash when fetching its
     *      attestation.
     * @param mintRecipient        Recipient on the destination domain, left-padded to 32 bytes for EVM chains
     * @param destinationCaller    Only this address may submit the message on the destination
     *                             domain; zero lets anyone relay it
     * @param maxFee               Most of `amount` Circle may keep as a fee; zero for a standard transfer
     * @param minFinalityThreshold 2000 waits for finality (standard); 1000 is a paid fast transfer
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold
    ) external;

    /// @notice TokenMessenger registered on `domain`; zero when Circle does not serve that domain
    function remoteTokenMessengers(uint32 domain) external view returns (bytes32);

    /// @notice TokenMinter that performs the local burn and holds the per-message burn caps
    function localMinter() external view returns (address);
}

/// @notice Circle CCTP TokenMinter — holds the per-message burn cap this contract reports
interface ITokenMinter {
    /// @notice Largest amount of `token` that may be burned in a single message
    function burnLimitsPerMessage(address token) external view returns (uint256);
}
