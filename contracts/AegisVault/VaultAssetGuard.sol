// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { IVaultMinting } from "./interfaces/IVaultMinting.sol";

/**
 * @title VaultAssetGuard
 * @notice Gated push/pull holder for collateral that would otherwise sit in an external custody
 *         wallet. Registered as a custodian address in VaultMinting, so `transferToCustody` and
 *         `forceTransferToCustody` deliver collateral here instead of to an EOA or an exchange
 *         sub-account.
 *
 * @dev Collateral can leave this contract in exactly two directions:
 *
 *      1. PUSH — `withdraw` / `withdrawBatch` send to an address on the destination whitelist
 *                (venues, banks, RWA providers, sub-custodians).
 *      2. PULL — `returnToMinting` / `returnAllToMinting` send to the configured VaultMinting
 *                contract, where collateral becomes untracked liquidity that funds redeem
 *                requests. This is the address a redeeming user is ultimately paid from. Only
 *                assets minting supports are accepted; anything else would be stranded there.
 *
 *      `pullFromMinting` closes the loop in the other direction: when this contract also holds
 *      COLLATERAL_MANAGER_ROLE on VaultMinting, one operator call draws custody-transferrable
 *      collateral out of minting and into here, so both legs are driven from a single contract.
 *
 *      There is deliberately no arbitrary-destination rescue function and no ERC-20 approval
 *      surface. Either one would void the whitelist, which is the only security boundary this
 *      contract has: a compromised COLLATERAL_MANAGER_ROLE key can move funds between addresses
 *      the whitelist manager already approved, and nowhere else. Recovering a stray token means
 *      whitelisting its recipient first, which leaves an on-chain record.
 *
 *      Roles:
 *        DEFAULT_ADMIN_ROLE      — points the contract at VaultMinting, administers roles.
 *        COLLATERAL_MANAGER_ROLE — moves assets: push to whitelisted destinations, return to
 *                                  minting, draw collateral out of minting.
 *        WHITELIST_MANAGER_ROLE  — maintains the destination whitelist and the pause switch.
 *
 *      Pausing stops every outbound movement and every draw from minting. Returning collateral
 *      to minting is never paused: redemption liquidity must stay reachable during an incident.
 */
contract VaultAssetGuard is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

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

    /// @dev Addresses this contract is allowed to withdraw to
    EnumerableSet.AddressSet private _destinations;

    /// @dev Assets each destination is allowed to receive. A destination with an empty list can
    ///      receive nothing: permission is per pair, never implied by the whitelist alone.
    mapping(address => EnumerableSet.AddressSet) private _destinationAssets;

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

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @param _mintingAddress VaultMinting contract that receives returned collateral
     * @param _admin          Initial DEFAULT_ADMIN_ROLE holder (expected to be a multisig)
     * @param _initialDelay   AccessControlDefaultAdminRules handover delay, in seconds
     * @param _destinations_  Initial whitelist of addresses assets may be withdrawn to
     * @param _labels         Operator labels matching `_destinations_`, one per entry
     * @param _assets         Assets each initial destination may receive, one list per entry.
     *                        An empty list means that destination can receive nothing yet.
     * @param _whitelistCooldown Seconds before a newly added destination can receive funds; zero
     *                        disables it. Applies to the initial whitelist too. Cannot be changed.
     * @param _mintingChangeDelay Seconds between proposing and applying a new minting address.
     *                        Cannot be changed.
     */
    constructor(
        address _mintingAddress,
        address _admin,
        uint48 _initialDelay,
        address[] memory _destinations_,
        string[] memory _labels,
        address[][] memory _assets,
        uint256 _whitelistCooldown,
        uint256 _mintingChangeDelay
    ) AccessControlDefaultAdminRules(_initialDelay, _admin) {
        if (_destinations_.length != _labels.length || _destinations_.length != _assets.length) {
            revert InvalidArrayLength();
        }
        whitelistCooldown = _whitelistCooldown;
        mintingChangeDelay = _mintingChangeDelay;
        if (_mintingAddress != address(0)) _setMintingAddress(_mintingAddress);

        for (uint256 i = 0; i < _destinations_.length; i++) {
            _addDestination(_destinations_[i], _labels[i], _assets[i]);
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
        _addDestination(destination, label, assets);
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
            _addDestination(destinations_[i], labels[i], assets[i]);
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
    // ADMIN
    // ============================================

    /**
     * @notice Names the minting contract for the first time
     * @dev Only while none is set — there is no sink to protect yet. Replacing a live one goes
     *      through the cooldown below.
     */
    function setMintingAddress(address _mintingAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
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
    function beginMintingAddressChange(address newMinting) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mintingAddress == address(0)) revert MintingNotConfigured();
        _validateMintingAddress(newMinting);

        uint256 activeAt = block.timestamp + mintingChangeDelay;
        pendingMintingAddress = newMinting;
        mintingChangeActiveAt = activeAt;

        emit MintingAddressChangeStarted(newMinting, activeAt);
    }

    /// @notice Applies a proposed minting contract once its cooldown has elapsed
    function applyMintingAddressChange() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address pending = pendingMintingAddress;
        if (pending == address(0)) revert NoPendingMintingChange();

        uint256 activeAt = mintingChangeActiveAt;
        if (block.timestamp < activeAt) revert MintingChangeInCooldown(pending, activeAt);

        delete pendingMintingAddress;
        delete mintingChangeActiveAt;

        _setMintingAddress(pending);
    }

    /// @notice Abandons a proposed minting contract
    function cancelMintingAddressChange() external onlyRole(DEFAULT_ADMIN_ROLE) {
        address pending = pendingMintingAddress;
        if (pending == address(0)) revert NoPendingMintingChange();

        delete pendingMintingAddress;
        delete mintingChangeActiveAt;

        emit MintingAddressChangeCancelled(pending);
    }

    // ============================================
    // VIEWS
    // ============================================

    /// @notice Whether assets may be withdrawn to `destination`
    function isDestination(address destination) public view returns (bool) {
        return _destinations.contains(destination);
    }

    /// @notice First timestamp at which `destination` can receive funds; zero if not whitelisted
    /// @dev With a cooldown configured, withdrawals are allowed once `block.timestamp` is strictly
    ///      greater than this value; without one, a destination is usable as soon as it is added
    function destinationActiveAt(address destination) public view returns (uint256) {
        if (!_destinations.contains(destination)) return 0;
        return destinationAddedAt[destination] + whitelistCooldown;
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
        uint256 cooldown = whitelistCooldown;
        if (cooldown != 0) {
            uint256 activeAt = destinationAddedAt[to] + cooldown;
            if (block.timestamp <= activeAt) revert DestinationInCooldown(to, activeAt);
        }
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

    function _addDestination(address destination, string memory label, address[] memory assets) internal virtual {
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
