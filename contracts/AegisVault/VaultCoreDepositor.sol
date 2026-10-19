// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { VaultAssetGuard } from "./VaultAssetGuard.sol";
import { ICoreDepositWallet } from "./interfaces/ICoreDepositWallet.sol";

/**
 * @title VaultCoreDepositor
 * @notice VaultAssetGuard for HyperEVM, plus one more exit: crediting a designated HyperCore account
 *         through Circle's CoreDepositWallet. USDC arrives here over CCTP from the guard on Ethereum
 *         and leaves either back over CCTP or into the HyperCore account that trades it.
 *
 * @dev `depositFor` credits any address it is given, so on its own it is an unrestricted exit. Here
 *      the recipient is not a parameter: it is `coreRecipient`, set at deployment and replaceable
 *      only by WHITELIST_MANAGER_ROLE, with a replacement waiting out `whitelistCooldown` exactly as
 *      a new destination or bridge route does. COLLATERAL_MANAGER_ROLE decides when and how much,
 *      never where.
 *
 *      The recipient must be an account that can act on HyperCore — an EOA, or a contract that
 *      drives CoreWriter, such as a Safe. Credit lands on the HyperCore account with the recipient's
 *      own address, and withdrawals from HyperCore land on that same address on HyperEVM, not
 *      here. Returning funds to this contract is therefore the recipient's job.
 *
 *      Deposits use the same allowance discipline as `bridgeCctp`: the exact amount is approved to
 *      the immutable CoreDepositWallet, the allowance is zeroed in the same call, and the balance
 *      delta is asserted. Only the wallet's own token (USDC) can be deposited.
 *
 *      Circle controls the CoreDepositWallet: it can pause it, which makes deposits revert, and it
 *      is an upgradeable proxy. While funds sit on HyperCore they are backed by that wallet's pool.
 *
 *      There is no minting contract on HyperEVM, so the redemption sink is disabled for good:
 *      `mintingAddress` is zero forever, every attempt to set one reverts `MintingDisabled`, and
 *      the minting functions inherited from the base (`returnToMinting`, `returnAllToMinting`,
 *      `pullFromMinting`, `pullAllFromMinting`) always revert `MintingNotConfigured`. Without
 *      this, the first `setMintingAddress` would be immediate and `returnToMinting` unpausable —
 *      an instant exit to any contract the whitelist manager names.
 */
contract VaultCoreDepositor is VaultAssetGuard {
    using SafeERC20 for IERC20;

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Circle's CoreDepositWallet — the only address that ever receives an allowance for deposits
    ICoreDepositWallet public immutable coreDepositWallet;

    /// @notice The token CoreDepositWallet backs on HyperCore (USDC); the only depositable asset
    address public immutable coreToken;

    /// @notice HyperCore account every deposit credits
    address public coreRecipient;

    /// @notice First timestamp at which `coreRecipient` can be credited
    uint256 public coreRecipientActiveFrom;

    /// @notice HyperCore dex id for the Core perps balance
    uint32 public constant CORE_PERPS_DEX = 0;

    /// @notice HyperCore dex id for the Core spot balance
    uint32 public constant CORE_SPOT_DEX = type(uint32).max;

    // ============================================
    // EVENTS
    // ============================================

    /// @dev Emitted when assets are deposited to the HyperCore account
    event HyperCoreDeposit(address indexed recipient, uint256 amount, uint32 destinationDex);

    /// @dev Emitted when the HyperCore account is set
    event CoreRecipientChanged(address indexed recipient, uint256 activeFrom);

    // ============================================
    // ERRORS
    // ============================================

    error CoreRecipientInCooldown(address recipient, uint256 activeAt);
    error DepositAmountMismatch(uint256 expected, uint256 actual);
    error MintingDisabled();
    error UnsupportedDex(uint32 destinationDex);

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @param _coreDepositWallet Circle's CoreDepositWallet. Cannot be changed.
     * @param _coreRecipient  HyperCore account to credit, usable from deployment
     *
     * @dev Remaining parameters are VaultAssetGuard's, minus `_mintingAddress` and
     *      `_mintingChangeDelay`: there is no redemption sink here (zero, and zero delay, are passed
     *      to the base). The guard on Ethereum is reached through a bridge route instead.
     */
    constructor(
        address _admin,
        uint48 _initialDelay,
        address[] memory _destinations,
        string[] memory _labels,
        address[][] memory _assets,
        uint256 _whitelistCooldown,
        address[] memory _collateralManagers,
        address[] memory _whitelistManagers,
        address _cctpTokenMessenger,
        CctpRouteConfig[] memory _cctpRoutes,
        address _coreDepositWallet,
        address _coreRecipient
    ) VaultAssetGuard(
        address(0), _admin, _initialDelay, _destinations, _labels, _assets,
        _whitelistCooldown, 0, _collateralManagers, _whitelistManagers,
        _cctpTokenMessenger, _cctpRoutes
    ) {
        if (_coreDepositWallet == address(0)) revert ZeroAddress();
        if (_coreDepositWallet.code.length == 0) revert InvalidAddress();
        address token = ICoreDepositWallet(_coreDepositWallet).token();
        if (token == address(0)) revert InvalidAddress();

        coreDepositWallet = ICoreDepositWallet(_coreDepositWallet);
        coreToken = token;

        _setCoreRecipient(_coreRecipient, true);
    }

    // ============================================
    // HYPERCORE DEPOSIT
    // ============================================

    /**
     * @notice Deposits USDC to the designated HyperCore account
     * @dev approve(wallet, amount) → depositFor(coreRecipient, …) → approve(wallet, 0), then the
     *      balance delta is asserted. Credit is not instant: HyperCore picks the deposit up from the
     *      wallet's event shortly after this transaction.
     * @param amount         Amount in the token's EVM decimals (6 for USDC)
     * @param destinationDex `CORE_PERPS_DEX` or `CORE_SPOT_DEX`; anything else reverts. Either way
     *                       the same account is credited; this only picks which of its balances.
     *                       CoreDepositWallet itself accepts any dex id, including HIP-3 dexes and
     *                       ids that do not exist, so the restriction has to live here.
     */
    function depositToHyperCore(
        uint256 amount,
        uint32 destinationDex
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        address recipient = coreRecipient;
        uint256 activeFrom = coreRecipientActiveFrom;
        if (block.timestamp < activeFrom) revert CoreRecipientInCooldown(recipient, activeFrom);
        if (amount == 0) revert InvalidAmount();
        if (destinationDex != CORE_PERPS_DEX && destinationDex != CORE_SPOT_DEX) revert UnsupportedDex(destinationDex);

        IERC20 token = IERC20(coreToken);
        address wallet = address(coreDepositWallet);
        uint256 balanceBefore = token.balanceOf(address(this));

        token.forceApprove(wallet, amount);
        coreDepositWallet.depositFor(recipient, amount, destinationDex);
        token.forceApprove(wallet, 0);

        uint256 balanceAfter = token.balanceOf(address(this));
        if (balanceAfter > balanceBefore || balanceBefore - balanceAfter != amount) {
            revert DepositAmountMismatch(amount, balanceAfter > balanceBefore ? 0 : balanceBefore - balanceAfter);
        }

        emit HyperCoreDeposit(recipient, amount, destinationDex);
    }

    // ============================================
    // RECIPIENT MANAGEMENT — WHITELIST_MANAGER_ROLE
    // ============================================

    /**
     * @notice Replaces the HyperCore account deposits credit
     * @dev Takes effect after `whitelistCooldown`, like any new address funds can reach. Deposits
     *      revert until then, so the old account stops receiving at once.
     */
    function setCoreRecipient(address recipient) external onlyRole(WHITELIST_MANAGER_ROLE) {
        _setCoreRecipient(recipient, false);
    }

    // ============================================
    // INTERNAL
    // ============================================

    /// @dev No address is ever an acceptable redemption sink here, so `setMintingAddress` always
    ///      reverts and `mintingAddress` stays zero. `beginMintingAddressChange` already reverts
    ///      `MintingNotConfigured` while it is zero.
    function _validateMintingAddress(address) internal pure override {
        revert MintingDisabled();
    }

    /**
     * @param immediate Skip the cooldown — true only for the constructor, whose recipient is part of
     *        the deployment being inspected, as with the seeded whitelist and routes.
     */
    function _setCoreRecipient(address recipient, bool immediate) internal {
        if (recipient == address(0)) revert ZeroAddress();
        // This contract's own HyperCore account would be unreachable: it cannot drive CoreWriter.
        if (recipient == address(this) || recipient == address(coreDepositWallet)) revert InvalidAddress();

        uint256 activeFrom = immediate ? block.timestamp : block.timestamp + whitelistCooldown;
        coreRecipient = recipient;
        coreRecipientActiveFrom = activeFrom;

        emit CoreRecipientChanged(recipient, activeFrom);
    }
}
