// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { IVaultMinting } from "./interfaces/IVaultMinting.sol";
import { ITokenMessenger, ITokenMinter } from "./interfaces/ITokenMessenger.sol";

/**
 * @title VaultAssetGuard
 * @notice Gated push/pull holder for collateral that would otherwise sit in an external custody
 *         wallet. Registered as a custodian address in VaultMinting, so `transferToCustody` and
 *         `forceTransferToCustody` deliver collateral here instead of to an EOA or an exchange
 *         sub-account.
 *
 * @dev Collateral can leave this contract in exactly three directions:
 *
 *      1. PUSH — `withdraw` / `withdrawBatch` send to an address on the destination whitelist
 *                (venues, banks, RWA providers, sub-custodians).
 *      2. PULL — `returnToMinting` / `returnAllToMinting` send to the configured VaultMinting
 *                contract, where collateral becomes untracked liquidity that funds redeem
 *                requests. This is the address a redeeming user is ultimately paid from. Only
 *                assets minting supports are accepted; anything else would be stranded there.
 *      3. BRIDGE — `bridgeCctp` burns USDC through Circle's CCTP TokenMessenger so it mints on
 *                another chain. The destination is a whitelisted (domain, mintRecipient, asset)
 *                triple, not an address this contract can choose, and it waits out the same
 *                cooldown as the destination whitelist.
 *
 *      `pullFromMinting` closes the loop in the other direction: when this contract also holds
 *      COLLATERAL_MANAGER_ROLE on VaultMinting, one operator call draws custody-transferrable
 *      collateral out of minting and into here, so both legs are driven from a single contract.
 *
 *      There is deliberately no arbitrary-destination rescue function. It would void the whitelist,
 *      which is the only security boundary this contract has: a compromised COLLATERAL_MANAGER_ROLE
 *      key can move funds between addresses the whitelist manager already approved, and nowhere
 *      else. Recovering a stray token means whitelisting its recipient first, which leaves an
 *      on-chain record.
 *
 *      The bridge is the one place an ERC-20 allowance exists, and it is built so that holds for a
 *      single call and nothing longer: `bridgeCctp` approves the exact amount, burns, zeroes the
 *      allowance, and asserts that precisely that amount left the contract. Outside the span of
 *      that one transaction the allowance is always zero, so a standing approval can never be
 *      drained later. The spender is the CCTP TokenMessenger address fixed at construction — it is
 *      immutable, so no role can ever repoint the allowance at a contract of its own choosing.
 *
 *      Roles are fixed at construction and can never be granted, revoked or renounced. `grantRole`
 *      and `revokeRole` always revert. Holders are expected to be multisigs, which rotate their own
 *      signers internally, so the address in each role never needs to change:
 *
 *        COLLATERAL_MANAGER_ROLE — moves assets: push to whitelisted destinations, return to
 *                                  minting, draw collateral out of minting.
 *        WHITELIST_MANAGER_ROLE  — every boundary: the destination whitelist, the pause switch,
 *                                  and the redemption sink.
 *        DEFAULT_ADMIN_ROLE      — holds no power over this contract. It cannot move assets, set a
 *                                  limit, pause, or change a role. It exists only because
 *                                  AccessControlDefaultAdminRules requires an admin, and it can
 *                                  retire itself by scheduling a transfer to the zero address and
 *                                  renouncing. Nothing is lost when it does.
 *
 *      Pausing stops every outbound movement and every draw from minting. Returning collateral
 *      to minting is never paused: redemption liquidity must stay reachable during an incident.
 */
contract VaultAssetGuard is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using EnumerableSet for EnumerableSet.Bytes32Set;

    // ============================================
    // ROLES
    // ============================================

    /// @notice Role allowed to move assets — push to whitelisted destinations and pull to/from minting
    bytes32 public constant COLLATERAL_MANAGER_ROLE = keccak256("COLLATERAL_MANAGER_ROLE");

    /// @notice Role allowed to maintain the destination whitelist and the pause switch
    bytes32 public constant WHITELIST_MANAGER_ROLE = keccak256("WHITELIST_MANAGER_ROLE");

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Sentinel standing for native currency in a destination's asset list
    address public constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice VaultMinting contract — the sink for collateral funding redeem requests
    address public mintingAddress;

    /// @notice Seconds between proposing a new minting address and being able to apply it.
    ///         Fixed at deployment; zero still requires two separate admin transactions.
    uint256 public immutable mintingChangeDelay;

    /// @notice Minting address awaiting its cooldown; zero when no change is pending
    address public pendingMintingAddress;

    /// @notice First timestamp at which the pending minting change may be applied
    uint256 public mintingChangeActiveAt;

    /// @notice Seconds a newly whitelisted destination must wait before it can receive funds.
    ///         Fixed at deployment; zero disables the cooldown.
    uint256 public immutable whitelistCooldown;

    /// @notice Emergency stop for outbound movement and draws from minting
    bool public paused;

    /// @notice Operator-readable label for each whitelisted destination ("Copper omnibus", "Bank A")
    mapping(address => string) public destinationLabel;

    /// @notice Timestamp at which each destination was whitelisted; cleared on removal
    mapping(address => uint256) public destinationAddedAt;

    /// @notice First timestamp at which each destination may receive funds; cleared on removal
    mapping(address => uint256) public destinationActiveFrom;

    /// @dev Addresses this contract is allowed to withdraw to
    EnumerableSet.AddressSet private _destinations;

    /// @dev Assets each destination is allowed to receive. A destination with an empty list can
    ///      receive nothing: permission is per pair, never implied by the whitelist alone.
    mapping(address => EnumerableSet.AddressSet) private _destinationAssets;

    /// @notice Circle CCTP TokenMessenger this contract bridges through, or zero to disable bridging.
    ///         Fixed at deployment: it is the only address that ever receives an allowance, so no
    ///         role can repoint it.
    ITokenMessenger public immutable cctpTokenMessenger;

    /// @notice CCTP v2 finality threshold for a standard transfer: wait for a finalized source block
    uint32 public constant CCTP_FINALITY_STANDARD = 2000;

    /// @notice One approved cross-chain destination: a CCTP domain and the recipient on it
    struct CctpRoute {
        uint32 domain;
        bytes32 mintRecipient;
        uint256 addedAt;
        uint256 activeFrom;
        string label;
    }

    /// @dev Approved bridge routes, keyed by `cctpRouteId(domain, mintRecipient)`
    EnumerableSet.Bytes32Set private _cctpRoutes;

    /// @dev Route detail by id; cleared on removal
    mapping(bytes32 => CctpRoute) private _cctpRoute;

    /// @dev Assets each route may bridge. Empty means the route can bridge nothing, exactly as an
    ///      empty asset list makes a whitelisted destination unable to receive anything.
    mapping(bytes32 => EnumerableSet.AddressSet) private _cctpRouteAssets;

    // ============================================
    // EVENTS
    // ============================================

    /// @dev Emitted when assets are pushed to a whitelisted destination
    event Withdrawal(address indexed asset, address indexed to, uint256 amount);

    /// @dev Emitted when native currency is pushed to a whitelisted destination
    event NativeWithdrawal(address indexed to, uint256 amount);

    /// @dev Emitted when assets are returned to the minting contract as redemption liquidity
    event ReturnedToMinting(address indexed asset, address indexed minting, uint256 amount);

    /// @dev Emitted when collateral is drawn out of the minting contract into this one
    event PulledFromMinting(address indexed asset, address indexed minting, uint256 amount);

    /// @dev Emitted when native currency is received
    event NativeReceived(address indexed from, uint256 amount);

    /// @dev Emitted when a destination is added to the whitelist
    event DestinationAdded(address indexed destination, string label);

    /// @dev Emitted when a destination is removed from the whitelist
    event DestinationRemoved(address indexed destination);

    /// @dev Emitted when an asset is allowed on / removed from a destination
    event DestinationAssetChanged(address indexed destination, address indexed asset, bool allowed);

    /// @dev Emitted when the minting contract address is changed
    event MintingAddressChanged(address indexed minting);

    /// @dev Emitted when a minting address change is proposed and starts its cooldown
    event MintingAddressChangeStarted(address indexed minting, uint256 activeAt);

    /// @dev Emitted when a pending minting address change is abandoned
    event MintingAddressChangeCancelled(address indexed minting);

    /// @dev Emitted when the pause state is changed
    event PausedChanged(bool paused);

    /// @dev Emitted when a bridge route is added
    event CctpRouteAdded(bytes32 indexed routeId, uint32 indexed domain, bytes32 mintRecipient, string label, uint256 activeFrom);

    /// @dev Emitted when a bridge route is removed
    event CctpRouteRemoved(bytes32 indexed routeId);

    /// @dev Emitted when an asset is allowed on / removed from a bridge route
    event CctpRouteAssetChanged(bytes32 indexed routeId, address indexed asset, bool allowed);

    /// @dev Emitted when assets are burned for a mint on another chain
    event CctpBridged(
        address indexed asset,
        bytes32 indexed routeId,
        uint32 domain,
        bytes32 mintRecipient,
        uint256 amount
    );

    // ============================================
    // ERRORS
    // ============================================

    error ZeroAddress();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidArrayLength();
    error NotWhitelistedDestination(address destination);
    error DestinationInCooldown(address destination, uint256 activeAt);
    error AlreadyWhitelisted(address destination);
    error MintingNotConfigured();
    error MintingAlreadySet(address minting);
    error NoPendingMintingChange();
    error MintingChangeInCooldown(address minting, uint256 activeAt);
    error NotSupportedAsset(address asset);
    error AssetNotAllowedForDestination(address destination, address asset);
    error Paused();
    error NativeTransferFailed();
    error RolesAreImmutable();
    error NoRoleHolders(bytes32 role);
    error CctpNotConfigured();
    error UnsupportedCctpDomain(uint32 domain);
    error NotWhitelistedRoute(uint32 domain, bytes32 mintRecipient);
    error CctpRouteAlreadyExists(bytes32 routeId);
    error CctpRouteInCooldown(bytes32 routeId, uint256 activeAt);
    error AssetNotAllowedForRoute(bytes32 routeId, address asset);
    error BridgeAmountMismatch(uint256 expected, uint256 actual);

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /// @notice One bridge route to seed at deployment, with the assets it may carry
    struct CctpRouteConfig {
        uint32 domain;
        bytes32 mintRecipient;
        string label;
        address[] assets;
    }

    /**
     * @param _mintingAddress VaultMinting contract that receives returned collateral
     * @param _admin          Initial DEFAULT_ADMIN_ROLE holder (expected to be a multisig)
     * @param _initialDelay   AccessControlDefaultAdminRules handover delay, in seconds
     * @param _destinations_  Initial whitelist of addresses assets may be withdrawn to
     * @param _labels         Operator labels matching `_destinations_`, one per entry
     * @param _assets         Assets each initial destination may receive, one list per entry.
     *                        An empty list means that destination can receive nothing yet.
     * @param _whitelistCooldown Seconds before a newly added destination or bridge route becomes
     *                        usable; zero disables it. One value governs both, because both are the
     *                        same decision: a new address funds can reach. Cannot be changed.
     * @param _mintingChangeDelay Seconds between proposing and applying a new minting address.
     *                        Cannot be changed.
     * @param _collateralManagers Permanent holders of COLLATERAL_MANAGER_ROLE
     * @param _whitelistManagers  Permanent holders of WHITELIST_MANAGER_ROLE
     * @param _cctpTokenMessenger Circle CCTP TokenMessenger, or zero to leave bridging unavailable
     *                        for the life of the contract. Cannot be changed.
     * @param _cctpRoutes_    Bridge routes to seed, usable from deployment. May be empty; routes
     *                        added later wait out `_whitelistCooldown`.
     *
     * @dev Both role lists are fixed here for the life of the contract — see the roles note in the
     *      contract docs. Each must be non-empty: with no collateral manager the guard could never
     *      move an asset again, and with no whitelist manager it could never be paused, and neither
     *      mistake could be corrected afterwards.
     */
    constructor(
        address _mintingAddress,
        address _admin,
        uint48 _initialDelay,
        address[] memory _destinations_,
        string[] memory _labels,
        address[][] memory _assets,
        uint256 _whitelistCooldown,
        uint256 _mintingChangeDelay,
        address[] memory _collateralManagers,
        address[] memory _whitelistManagers,
        address _cctpTokenMessenger,
        CctpRouteConfig[] memory _cctpRoutes_
    ) AccessControlDefaultAdminRules(_initialDelay, _admin) {
        if (_destinations_.length != _labels.length || _destinations_.length != _assets.length) {
            revert InvalidArrayLength();
        }
        if (_collateralManagers.length == 0) revert NoRoleHolders(COLLATERAL_MANAGER_ROLE);
        if (_whitelistManagers.length == 0) revert NoRoleHolders(WHITELIST_MANAGER_ROLE);
        // A messenger address with no code would make every bridge call revert in a way that looks
        // like a Circle outage rather than a typo at deployment.
        if (_cctpTokenMessenger != address(0) && _cctpTokenMessenger.code.length == 0) revert InvalidAddress();
        // Routes without a messenger are unreachable configuration, and the messenger can never be
        // set later — so this is a deployment mistake, not a state to tolerate.
        if (_cctpTokenMessenger == address(0) && _cctpRoutes_.length != 0) revert CctpNotConfigured();

        whitelistCooldown = _whitelistCooldown;
        mintingChangeDelay = _mintingChangeDelay;
        cctpTokenMessenger = ITokenMessenger(_cctpTokenMessenger);

        for (uint256 i = 0; i < _collateralManagers.length; i++) {
            if (_collateralManagers[i] == address(0)) revert ZeroAddress();
            _grantRole(COLLATERAL_MANAGER_ROLE, _collateralManagers[i]);
        }
        for (uint256 i = 0; i < _whitelistManagers.length; i++) {
            if (_whitelistManagers[i] == address(0)) revert ZeroAddress();
            _grantRole(WHITELIST_MANAGER_ROLE, _whitelistManagers[i]);
        }

        if (_mintingAddress != address(0)) _setMintingAddress(_mintingAddress);

        for (uint256 i = 0; i < _destinations_.length; i++) {
            _addDestination(_destinations_[i], _labels[i], _assets[i], true);
        }

        for (uint256 i = 0; i < _cctpRoutes_.length; i++) {
            CctpRouteConfig memory route = _cctpRoutes_[i];
            _addCctpRoute(route.domain, route.mintRecipient, route.label, route.assets, true);
        }
    }

    // ============================================
    // MODIFIERS
    // ============================================

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ============================================
    // PUSH — WITHDRAWALS TO WHITELISTED DESTINATIONS
    // ============================================

    /**
     * @notice Sends assets to a whitelisted destination
     * @param asset  ERC-20 asset to send
     * @param to     Whitelisted destination
     * @param amount Amount to send
     */
    function withdraw(
        address asset,
        address to,
        uint256 amount
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        _withdraw(asset, to, amount);
    }

    /**
     * @notice Sends several assets to whitelisted destinations in one call
     * @dev Arrays are positional: `assets[i]` goes to `tos[i]` for `amounts[i]`
     */
    function withdrawBatch(
        address[] calldata assets,
        address[] calldata tos,
        uint256[] calldata amounts
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        if (assets.length == 0 || assets.length != tos.length || assets.length != amounts.length) {
            revert InvalidArrayLength();
        }

        for (uint256 i = 0; i < assets.length; i++) {
            _withdraw(assets[i], tos[i], amounts[i]);
        }
    }

    /**
     * @notice Sends the contract's entire balance of an asset to a whitelisted destination
     */
    function withdrawAll(
        address asset,
        address to
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        _withdraw(asset, to, IERC20(asset).balanceOf(address(this)));
    }

    /**
     * @notice Sends native currency to a whitelisted destination
     * @dev Present so force-sent value is recoverable through the same gate as ERC-20 assets
     */
    function withdrawNative(
        address to,
        uint256 amount
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        _checkDestination(to);
        if (!_destinationAssets[to].contains(NATIVE_ASSET)) revert AssetNotAllowedForDestination(to, NATIVE_ASSET);
        if (amount == 0 || amount > address(this).balance) revert InvalidAmount();

        Address.sendValue(payable(to), amount);

        emit NativeWithdrawal(to, amount);
    }

    // ============================================
    // BRIDGE — CCTP TRANSFER TO ANOTHER CHAIN
    // ============================================

    /**
     * @notice Burns assets through Circle's CCTP so they mint on a whitelisted route
     * @dev The only function in this contract that grants an ERC-20 allowance, and it does so for
     *      the length of one external call:
     *
     *        approve(messenger, amount) → depositForBurn → approve(messenger, 0)
     *
     *      so between transactions the allowance is always zero and there is nothing for a later
     *      caller to drain. The spender is immutable, the exact amount is approved rather than an
     *      unlimited one, and the balance delta is asserted afterwards: if the messenger took more
     *      or less than `amount`, or took it and gave nothing back, the whole call reverts. That
     *      check is what makes an unknown future TokenMessenger implementation uninteresting — it
     *      cannot quietly move a different amount than the one in the event log.
     *
     *      Minting on the far side is not atomic. The burn happens here; the mint needs Circle's
     *      attestation to be fetched and submitted on the destination chain, which takes roughly
     *      13-19 minutes at standard finality. Until then the value exists only as a burned message,
     *      identified by this transaction's hash. Nothing in this contract can complete or recall it.
     *
     *      Every burn is a standard CCTP v2 transfer: finalized source block, zero fee, and an open
     *      destination caller so anyone holding the attestation can submit it. None of the three is
     *      a parameter, because each would hand the operator something to misuse — a fee is value
     *      paid away, and a pinned caller is a relayer who can stall the mint. The recipient is
     *      fixed by the route either way, so an open caller can only deliver, never redirect.
     *
     *      Circle also caps a single burn (10,000,000 USDC on Ethereum at the time of writing) — see
     *      `cctpBurnLimit`. Larger moves are several calls, deliberately: this contract does not
     *      loop, so the per-message cap stays visible to whoever signs the transaction.
     *
     * @param asset         Burn token, allowed on this route (USDC in practice)
     * @param domain        CCTP destination domain (Arbitrum 3, Base 6, OP 2, Polygon PoS 7, HyperEVM 19)
     * @param mintRecipient Recipient on the destination domain, 32 bytes — see `addressToBytes32`
     * @param amount        Amount to burn here and mint there
     */
    function bridgeCctp(
        address asset,
        uint32 domain,
        bytes32 mintRecipient,
        uint256 amount
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        ITokenMessenger messenger = cctpTokenMessenger;
        if (address(messenger) == address(0)) revert CctpNotConfigured();

        bytes32 routeId = _checkCctpRoute(domain, mintRecipient);
        if (!_cctpRouteAssets[routeId].contains(asset)) revert AssetNotAllowedForRoute(routeId, asset);
        if (amount == 0) revert InvalidAmount();

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));

        IERC20(asset).forceApprove(address(messenger), amount);
        messenger.depositForBurn(amount, domain, mintRecipient, asset, bytes32(0), 0, CCTP_FINALITY_STANDARD);
        IERC20(asset).forceApprove(address(messenger), 0);

        uint256 balanceAfter = IERC20(asset).balanceOf(address(this));
        if (balanceAfter > balanceBefore || balanceBefore - balanceAfter != amount) {
            revert BridgeAmountMismatch(amount, balanceAfter > balanceBefore ? 0 : balanceBefore - balanceAfter);
        }

        emit CctpBridged(asset, routeId, domain, mintRecipient, amount);
    }

    // ============================================
    // PULL — MOVEMENT BETWEEN THIS CONTRACT AND MINTING
    // ============================================

    /**
     * @notice Returns assets to the minting contract, where they become redemption liquidity
     * @dev Never paused: redeem requests must stay fundable during an incident. Limited to assets
     *      minting supports, because it has no way to release anything else.
     */
    function returnToMinting(address asset, uint256 amount) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) {
        _returnToMinting(asset, amount);
    }

    /**
     * @notice Returns the contract's entire balance of an asset to the minting contract
     */
    function returnAllToMinting(address asset) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) {
        _returnToMinting(asset, IERC20(asset).balanceOf(address(this)));
    }

    /**
     * @notice Draws custody-transferrable collateral out of the minting contract into this one
     * @dev Requires this contract to be a registered custodian in VaultMinting AND to hold
     *      COLLATERAL_MANAGER_ROLE there. Reverts inside VaultMinting otherwise.
     */
    function pullFromMinting(
        address asset,
        uint256 amount
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        address minting = mintingAddress;
        if (minting == address(0)) revert MintingNotConfigured();
        if (amount == 0) revert InvalidAmount();

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IVaultMinting(minting).transferToCustody(address(this), asset, amount);

        emit PulledFromMinting(asset, minting, IERC20(asset).balanceOf(address(this)) - balanceBefore);
    }

    /**
     * @notice Draws all unfrozen custody-transferrable collateral of an asset out of minting
     * @dev Same prerequisites as `pullFromMinting`
     */
    function pullAllFromMinting(address asset) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        address minting = mintingAddress;
        if (minting == address(0)) revert MintingNotConfigured();

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IVaultMinting(minting).forceTransferToCustody(address(this), asset);

        emit PulledFromMinting(asset, minting, IERC20(asset).balanceOf(address(this)) - balanceBefore);
    }

    // ============================================
    // WHITELIST MANAGEMENT
    // ============================================

    /**
     * @notice Adds a destination, together with the assets it is allowed to receive
     * @param destination Address assets may be withdrawn to
     * @param label       Operator label ("Copper omnibus", "Bank A")
     * @param assets      Assets this destination may receive; `NATIVE_ASSET` permits native currency
     */
    function addDestination(
        address destination,
        string calldata label,
        address[] calldata assets
    ) external onlyRole(WHITELIST_MANAGER_ROLE) {
        _addDestination(destination, label, assets, false);
    }

    /// @notice Adds several destinations in one call, each with its own asset list
    function addDestinations(
        address[] calldata destinations_,
        string[] calldata labels,
        address[][] calldata assets
    ) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (destinations_.length == 0 || destinations_.length != labels.length || destinations_.length != assets.length) {
            revert InvalidArrayLength();
        }

        for (uint256 i = 0; i < destinations_.length; i++) {
            _addDestination(destinations_[i], labels[i], assets[i], false);
        }
    }

    /**
     * @notice Allows or removes assets on an existing destination
     * @dev Removing an asset closes that pair immediately; the destination keeps its other assets.
     */
    function setDestinationAssets(
        address destination,
        address[] calldata assets,
        bool allowed
    ) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (!_destinations.contains(destination)) revert NotWhitelistedDestination(destination);
        if (assets.length == 0) revert InvalidArrayLength();

        for (uint256 i = 0; i < assets.length; i++) {
            _setDestinationAsset(destination, assets[i], allowed);
        }
    }

    /// @notice Removes a destination from the whitelist
    function removeDestination(address destination) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (!_destinations.remove(destination)) revert NotWhitelistedDestination(destination);
        delete destinationLabel[destination];
        delete destinationAddedAt[destination];
        delete destinationActiveFrom[destination];
        _clearDestinationAssets(destination);

        emit DestinationRemoved(destination);
    }

    /// @notice Removes several destinations in one call
    function removeDestinations(address[] calldata destinations_) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (destinations_.length == 0) revert InvalidArrayLength();

        for (uint256 i = 0; i < destinations_.length; i++) {
            if (!_destinations.remove(destinations_[i])) revert NotWhitelistedDestination(destinations_[i]);
            delete destinationLabel[destinations_[i]];
            delete destinationAddedAt[destinations_[i]];
            delete destinationActiveFrom[destinations_[i]];
            _clearDestinationAssets(destinations_[i]);

            emit DestinationRemoved(destinations_[i]);
        }
    }

    /// @notice Stops outbound movement and draws from minting. Returns to minting stay available.
    function setPaused(bool _paused) external onlyRole(WHITELIST_MANAGER_ROLE) {
        paused = _paused;
        emit PausedChanged(_paused);
    }

    // ============================================
    // BRIDGE ROUTE MANAGEMENT
    // ============================================

    /**
     * @notice Adds a bridge route, together with the assets it may carry
     * @dev Same role, same cooldown and same shape as the destination whitelist, because it is the
     *      same decision: naming an address funds may reach. A route becomes usable once
     *      `whitelistCooldown` has elapsed, so a recipient appearing on a live contract is visible
     *      on chain before anything can be sent to it.
     * @param domain        CCTP destination domain, which must be one Circle serves
     * @param mintRecipient Recipient on that domain, 32 bytes — see `addressToBytes32`
     * @param label         Operator label ("Hyperliquid deposit EOA")
     * @param assets        Burn tokens this route may carry
     */
    function addCctpRoute(
        uint32 domain,
        bytes32 mintRecipient,
        string calldata label,
        address[] calldata assets
    ) external onlyRole(WHITELIST_MANAGER_ROLE) {
        _addCctpRoute(domain, mintRecipient, label, assets, false);
    }

    /// @notice Allows or removes assets on an existing bridge route
    /// @dev Removing an asset closes that pair immediately; the route keeps its other assets.
    function setCctpRouteAssets(
        uint32 domain,
        bytes32 mintRecipient,
        address[] calldata assets,
        bool allowed
    ) external onlyRole(WHITELIST_MANAGER_ROLE) {
        bytes32 routeId = cctpRouteId(domain, mintRecipient);
        if (!_cctpRoutes.contains(routeId)) revert NotWhitelistedRoute(domain, mintRecipient);
        if (assets.length == 0) revert InvalidArrayLength();

        for (uint256 i = 0; i < assets.length; i++) {
            _setCctpRouteAsset(routeId, assets[i], allowed);
        }
    }

    /// @notice Removes a bridge route. Takes effect immediately; re-adding restarts the cooldown.
    function removeCctpRoute(uint32 domain, bytes32 mintRecipient) external onlyRole(WHITELIST_MANAGER_ROLE) {
        bytes32 routeId = cctpRouteId(domain, mintRecipient);
        if (!_cctpRoutes.remove(routeId)) revert NotWhitelistedRoute(domain, mintRecipient);

        delete _cctpRoute[routeId];
        _clearCctpRouteAssets(routeId);

        emit CctpRouteRemoved(routeId);
    }

    // ============================================
    // REDEMPTION SINK
    // ============================================

    /**
     * @notice Names the minting contract for the first time
     * @dev Only while none is set — there is no sink to protect yet. Replacing a live one goes
     *      through the cooldown below.
     */
    function setMintingAddress(address _mintingAddress) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (mintingAddress != address(0)) revert MintingAlreadySet(mintingAddress);
        _setMintingAddress(_mintingAddress);
    }

    /**
     * @notice Proposes a new minting contract and starts its cooldown
     * @dev The redemption sink is where every returned asset ends up, so swapping it is the most
     *      consequential change this contract allows. The delay gives anyone watching the chain
     *      time to react before collateral can be routed somewhere new. Validated now and again
     *      on apply, since the whitelist may move in between.
     */
    function beginMintingAddressChange(address newMinting) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (mintingAddress == address(0)) revert MintingNotConfigured();
        _validateMintingAddress(newMinting);

        uint256 activeAt = block.timestamp + mintingChangeDelay;
        pendingMintingAddress = newMinting;
        mintingChangeActiveAt = activeAt;

        emit MintingAddressChangeStarted(newMinting, activeAt);
    }

    /// @notice Applies a proposed minting contract once its cooldown has elapsed
    function applyMintingAddressChange() external onlyRole(WHITELIST_MANAGER_ROLE) {
        address pending = pendingMintingAddress;
        if (pending == address(0)) revert NoPendingMintingChange();

        uint256 activeAt = mintingChangeActiveAt;
        if (block.timestamp < activeAt) revert MintingChangeInCooldown(pending, activeAt);

        delete pendingMintingAddress;
        delete mintingChangeActiveAt;

        _setMintingAddress(pending);
    }

    /// @notice Abandons a proposed minting contract
    function cancelMintingAddressChange() external onlyRole(WHITELIST_MANAGER_ROLE) {
        address pending = pendingMintingAddress;
        if (pending == address(0)) revert NoPendingMintingChange();

        delete pendingMintingAddress;
        delete mintingChangeActiveAt;

        emit MintingAddressChangeCancelled(pending);
    }

    // ============================================
    // ROLE LOCK
    // ============================================

    /**
     * @notice Roles cannot be granted after deployment. Always reverts.
     * @dev Both operational roles are set in the constructor and fixed for the life of the
     *      contract. Without this, DEFAULT_ADMIN_ROLE could grant itself COLLATERAL_MANAGER_ROLE
     *      and WHITELIST_MANAGER_ROLE in a single transaction and hold every power the guard has.
     *      Holders are Safes, so signer rotation happens inside them and never needs this.
     */
    function grantRole(bytes32, address) public pure override {
        revert RolesAreImmutable();
    }

    /// @notice Roles cannot be revoked after deployment. Always reverts.
    function revokeRole(bytes32, address) public pure override {
        revert RolesAreImmutable();
    }

    /**
     * @notice An operational role holder cannot drop its own role; the default admin can retire.
     * @dev Letting a holder renounce would be a one-way loss of a capability nothing can restore —
     *      an operator mistake, or a griefing move by a compromised key. Renouncing
     *      DEFAULT_ADMIN_ROLE stays available (after its scheduled transfer to the zero address),
     *      because an admin with nothing left to administer should be able to step away.
     */
    function renounceRole(bytes32 role, address account) public override {
        if (role == COLLATERAL_MANAGER_ROLE || role == WHITELIST_MANAGER_ROLE) revert RolesAreImmutable();
        super.renounceRole(role, account);
    }

    // ============================================
    // VIEWS
    // ============================================

    /// @notice Whether assets may be withdrawn to `destination`
    function isDestination(address destination) public view returns (bool) {
        return _destinations.contains(destination);
    }

    /// @notice First timestamp at which `destination` can receive funds; zero if not whitelisted
    /// @dev Withdrawals are allowed once `block.timestamp` reaches this value. Destinations seeded
    ///      in the constructor are active from deployment; ones added later wait out the cooldown.
    function destinationActiveAt(address destination) public view returns (uint256) {
        if (!_destinations.contains(destination)) return 0;
        return destinationActiveFrom[destination];
    }

    /// @notice Whether `destination` is allowed to receive `asset`
    function isDestinationAsset(address destination, address asset) public view returns (bool) {
        return _destinationAssets[destination].contains(asset);
    }

    /// @notice Every asset `destination` is allowed to receive
    function destinationAssets(address destination) external view returns (address[] memory) {
        return _destinationAssets[destination].values();
    }

    /// @notice Number of whitelisted destinations
    function destinationCount() external view returns (uint256) {
        return _destinations.length();
    }

    /// @notice Whitelisted destination at `index`, with its label
    function destinationAt(uint256 index) external view returns (address destination, string memory label) {
        destination = _destinations.at(index);
        label = destinationLabel[destination];
    }

    /// @notice All whitelisted destinations
    function destinations() external view returns (address[] memory) {
        return _destinations.values();
    }

    /// @notice This contract's balance of `asset`
    function assetBalance(address asset) external view returns (uint256) {
        return IERC20(asset).balanceOf(address(this));
    }

    /// @notice Identifier a route is stored under. A route is the pair, so the same recipient on a
    ///         different domain, or a different recipient on the same domain, is a separate route.
    function cctpRouteId(uint32 domain, bytes32 mintRecipient) public pure returns (bytes32) {
        return keccak256(abi.encode(domain, mintRecipient));
    }

    /// @notice Left-pads an EVM address into the 32-byte form CCTP expects for `mintRecipient`
    function addressToBytes32(address account) public pure returns (bytes32) {
        return bytes32(uint256(uint160(account)));
    }

    /// @notice Whether a route is whitelisted. Being whitelisted is not the same as being usable —
    ///         check `cctpRouteActiveAt` for the cooldown and `isCctpRouteAsset` for the asset.
    function isCctpRoute(uint32 domain, bytes32 mintRecipient) public view returns (bool) {
        return _cctpRoutes.contains(cctpRouteId(domain, mintRecipient));
    }

    /// @notice First timestamp at which a route can carry funds; zero if not whitelisted
    function cctpRouteActiveAt(uint32 domain, bytes32 mintRecipient) public view returns (uint256) {
        return _cctpRoute[cctpRouteId(domain, mintRecipient)].activeFrom;
    }

    /// @notice Whether `asset` may be bridged on a route
    function isCctpRouteAsset(uint32 domain, bytes32 mintRecipient, address asset) public view returns (bool) {
        return _cctpRouteAssets[cctpRouteId(domain, mintRecipient)].contains(asset);
    }

    /// @notice Every asset a route may carry
    function cctpRouteAssets(bytes32 routeId) external view returns (address[] memory) {
        return _cctpRouteAssets[routeId].values();
    }

    /// @notice Number of whitelisted bridge routes
    function cctpRouteCount() external view returns (uint256) {
        return _cctpRoutes.length();
    }

    /// @notice Every whitelisted route id, in storage order
    function cctpRouteIds() external view returns (bytes32[] memory) {
        return _cctpRoutes.values();
    }

    /// @notice Full detail of a route by id, including its cooldown and the assets it may carry
    function cctpRouteInfo(bytes32 routeId)
        external
        view
        returns (
            uint32 domain,
            bytes32 mintRecipient,
            string memory label,
            uint256 addedAt,
            uint256 activeFrom,
            address[] memory assets
        )
    {
        CctpRoute storage route = _cctpRoute[routeId];
        return (
            route.domain,
            route.mintRecipient,
            route.label,
            route.addedAt,
            route.activeFrom,
            _cctpRouteAssets[routeId].values()
        );
    }

    /**
     * @notice Largest amount of `asset` CCTP will burn in a single message, as Circle reports it now
     * @dev Read live, not cached: Circle can change it, and a bridge call larger than this reverts
     *      inside the TokenMessenger. Zero means bridging is unavailable — no messenger configured,
     *      or no cap set for this token, which the TokenMinter also treats as unsupported.
     */
    function cctpBurnLimit(address asset) external view returns (uint256) {
        ITokenMessenger messenger = cctpTokenMessenger;
        if (address(messenger) == address(0)) return 0;

        address minter = messenger.localMinter();
        if (minter == address(0)) return 0;

        return ITokenMinter(minter).burnLimitsPerMessage(asset);
    }

    // ============================================
    // INTERNAL
    // ============================================

    function _withdraw(address asset, address to, uint256 amount) internal {
        _checkDestination(to);
        if (!_destinationAssets[to].contains(asset)) revert AssetNotAllowedForDestination(to, asset);
        if (amount == 0) revert InvalidAmount();

        IERC20(asset).safeTransfer(to, amount);

        emit Withdrawal(asset, to, amount);
    }

    /// @dev A destination must be whitelisted and, when a cooldown is configured, past it. Removal
    ///      takes effect immediately; re-adding a destination restarts its cooldown.
    function _checkDestination(address to) internal view {
        if (!_destinations.contains(to)) revert NotWhitelistedDestination(to);
        uint256 activeFrom = destinationActiveFrom[to];
        if (block.timestamp < activeFrom) revert DestinationInCooldown(to, activeFrom);
    }

    function _returnToMinting(address asset, uint256 amount) internal {
        address minting = mintingAddress;
        if (minting == address(0)) revert MintingNotConfigured();
        // Minting can pay out or re-custody only the assets it supports. Anything else sent there
        // would be stranded, and this route cannot be paused.
        if (!IVaultMinting(minting).isSupportedAsset(asset)) revert NotSupportedAsset(asset);
        if (amount == 0) revert InvalidAmount();

        IERC20(asset).safeTransfer(minting, amount);

        emit ReturnedToMinting(asset, minting, amount);
    }

    /**
     * @param immediate Skip the cooldown. True only for the constructor's initial whitelist, which
     *        is part of the deployment the operator is already inspecting — a guard that cannot use
     *        its own configured destinations until days after launch is not deployed, it is
     *        half-deployed. Every destination added afterwards waits, because that is the case the
     *        cooldown exists for: an address appearing on a live contract.
     */
    function _addDestination(
        address destination,
        string memory label,
        address[] memory assets,
        bool immediate
    ) internal virtual {
        if (destination == address(0)) revert ZeroAddress();
        // The two exit routes stay disjoint: minting is reached through returnToMinting, never
        // through withdraw, so every movement is unambiguous in the event log. A pending minting
        // address is held to the same rule, so a scheduled change cannot be blocked by whitelisting.
        if (destination == address(this) || destination == mintingAddress || destination == pendingMintingAddress) {
            revert InvalidAddress();
        }
        if (!_destinations.add(destination)) revert AlreadyWhitelisted(destination);

        destinationLabel[destination] = label;
        destinationAddedAt[destination] = block.timestamp;
        destinationActiveFrom[destination] = immediate ? block.timestamp : block.timestamp + whitelistCooldown;

        emit DestinationAdded(destination, label);

        for (uint256 i = 0; i < assets.length; i++) {
            _setDestinationAsset(destination, assets[i], true);
        }
    }

    function _setDestinationAsset(address destination, address asset, bool allowed) private {
        if (asset == address(0)) revert ZeroAddress();

        bool changed = allowed ? _destinationAssets[destination].add(asset) : _destinationAssets[destination].remove(asset);
        if (changed) emit DestinationAssetChanged(destination, asset, allowed);
    }

    /// @dev Swap-and-pop from the tail, so clearing costs one slot refund per asset. Asset lists
    ///      are curated per destination and expected to be short.
    function _clearDestinationAssets(address destination) private {
        EnumerableSet.AddressSet storage assets = _destinationAssets[destination];
        for (uint256 length = assets.length(); length > 0; length--) {
            address asset = assets.at(length - 1);
            assets.remove(asset);
            emit DestinationAssetChanged(destination, asset, false);
        }
    }

    /**
     * @param immediate Skip the cooldown — true only for routes seeded in the constructor, for the
     *        same reason the initial whitelist skips it: they are part of the deployment the
     *        operator is already inspecting. Routes added to a live contract always wait.
     */
    function _addCctpRoute(
        uint32 domain,
        bytes32 mintRecipient,
        string memory label,
        address[] memory assets,
        bool immediate
    ) internal virtual {
        ITokenMessenger messenger = cctpTokenMessenger;
        if (address(messenger) == address(0)) revert CctpNotConfigured();
        if (mintRecipient == bytes32(0)) revert ZeroAddress();
        // Circle's own registry decides which domains exist. This also rejects the local domain,
        // which has no remote messenger, so a route can never loop back to this chain. Checking it
        // here turns a mistyped domain into an immediate revert instead of a route that looks
        // configured, waits out the cooldown, and only then fails on first use.
        if (messenger.remoteTokenMessengers(domain) == bytes32(0)) revert UnsupportedCctpDomain(domain);

        bytes32 routeId = cctpRouteId(domain, mintRecipient);
        if (!_cctpRoutes.add(routeId)) revert CctpRouteAlreadyExists(routeId);

        uint256 activeFrom = immediate ? block.timestamp : block.timestamp + whitelistCooldown;
        _cctpRoute[routeId] = CctpRoute({
            domain: domain,
            mintRecipient: mintRecipient,
            addedAt: block.timestamp,
            activeFrom: activeFrom,
            label: label
        });

        emit CctpRouteAdded(routeId, domain, mintRecipient, label, activeFrom);

        for (uint256 i = 0; i < assets.length; i++) {
            _setCctpRouteAsset(routeId, assets[i], true);
        }
    }

    /**
     * @dev Whether `mintRecipient` is the recipient of a route on any domain. Children use this to
     *      keep a designated address off the bridge, the way `isDestination` keeps it off the
     *      whitelist. Linear in the number of routes, which only WHITELIST_MANAGER_ROLE can grow,
     *      and only reached from rare configuration calls — never from a movement.
     */
    function _isCctpRouteRecipient(bytes32 mintRecipient) internal view returns (bool) {
        uint256 length = _cctpRoutes.length();
        for (uint256 i = 0; i < length; i++) {
            if (_cctpRoute[_cctpRoutes.at(i)].mintRecipient == mintRecipient) return true;
        }
        return false;
    }

    /// @dev A route must be whitelisted and, when a cooldown is configured, past it
    function _checkCctpRoute(uint32 domain, bytes32 mintRecipient) internal view returns (bytes32 routeId) {
        routeId = cctpRouteId(domain, mintRecipient);
        if (!_cctpRoutes.contains(routeId)) revert NotWhitelistedRoute(domain, mintRecipient);

        uint256 activeFrom = _cctpRoute[routeId].activeFrom;
        if (block.timestamp < activeFrom) revert CctpRouteInCooldown(routeId, activeFrom);
    }

    function _setCctpRouteAsset(bytes32 routeId, address asset, bool allowed) private {
        if (asset == address(0)) revert ZeroAddress();
        // CCTP burns ERC-20s only. The native sentinel on a route would be a permission that reads
        // as granted and can never be used.
        if (asset == NATIVE_ASSET) revert InvalidAddress();

        bool changed = allowed ? _cctpRouteAssets[routeId].add(asset) : _cctpRouteAssets[routeId].remove(asset);
        if (changed) emit CctpRouteAssetChanged(routeId, asset, allowed);
    }

    /// @dev Same swap-and-pop shape as `_clearDestinationAssets`; route asset lists are short
    function _clearCctpRouteAssets(bytes32 routeId) private {
        EnumerableSet.AddressSet storage assets = _cctpRouteAssets[routeId];
        for (uint256 length = assets.length(); length > 0; length--) {
            address asset = assets.at(length - 1);
            assets.remove(asset);
            emit CctpRouteAssetChanged(routeId, asset, false);
        }
    }

    /// @dev Checks a candidate redemption sink. Children extend this to add their own exclusions.
    function _validateMintingAddress(address _mintingAddress) internal view virtual {
        if (_mintingAddress == address(0)) revert ZeroAddress();
        if (_mintingAddress == address(this) || _mintingAddress.code.length == 0) revert InvalidAddress();
        if (_destinations.contains(_mintingAddress)) revert InvalidAddress();
    }

    function _setMintingAddress(address _mintingAddress) internal {
        _validateMintingAddress(_mintingAddress);

        mintingAddress = _mintingAddress;

        emit MintingAddressChanged(_mintingAddress);
    }

    /// @dev Accepts native currency so it is recoverable through `withdrawNative`
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }
}
