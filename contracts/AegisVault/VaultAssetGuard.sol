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

    /// @notice VaultMinting contract — the sink for collateral funding redeem requests
    address public mintingAddress;

    /// @notice Emergency stop for outbound movement and draws from minting
    bool public paused;

    /// @notice Operator-readable label for each whitelisted destination ("Copper omnibus", "Bank A")
    mapping(address => string) public destinationLabel;

    /// @dev Addresses this contract is allowed to withdraw to
    EnumerableSet.AddressSet private _destinations;

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

    /// @dev Emitted when the minting contract address is changed
    event MintingAddressChanged(address indexed minting);

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
    error AlreadyWhitelisted(address destination);
    error MintingNotConfigured();
    error NotSupportedAsset(address asset);
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
     */
    constructor(
        address _mintingAddress,
        address _admin,
        uint48 _initialDelay,
        address[] memory _destinations_,
        string[] memory _labels
    ) AccessControlDefaultAdminRules(_initialDelay, _admin) {
        if (_destinations_.length != _labels.length) revert InvalidArrayLength();
        if (_mintingAddress != address(0)) _setMintingAddress(_mintingAddress);

        for (uint256 i = 0; i < _destinations_.length; i++) {
            _addDestination(_destinations_[i], _labels[i]);
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
        if (!_destinations.contains(to)) revert NotWhitelistedDestination(to);
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

    /// @notice Adds a destination assets may be withdrawn to
    function addDestination(address destination, string calldata label) external onlyRole(WHITELIST_MANAGER_ROLE) {
        _addDestination(destination, label);
    }

    /// @notice Adds several destinations in one call
    function addDestinations(
        address[] calldata destinations_,
        string[] calldata labels
    ) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (destinations_.length == 0 || destinations_.length != labels.length) revert InvalidArrayLength();

        for (uint256 i = 0; i < destinations_.length; i++) {
            _addDestination(destinations_[i], labels[i]);
        }
    }

    /// @notice Removes a destination from the whitelist
    function removeDestination(address destination) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (!_destinations.remove(destination)) revert NotWhitelistedDestination(destination);
        delete destinationLabel[destination];

        emit DestinationRemoved(destination);
    }

    /// @notice Removes several destinations in one call
    function removeDestinations(address[] calldata destinations_) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (destinations_.length == 0) revert InvalidArrayLength();

        for (uint256 i = 0; i < destinations_.length; i++) {
            if (!_destinations.remove(destinations_[i])) revert NotWhitelistedDestination(destinations_[i]);
            delete destinationLabel[destinations_[i]];

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
     * @notice Sets the minting contract that returned collateral is sent to
     * @dev Must be a contract. This is the address redeem requests are paid from, so it is
     *      restricted to DEFAULT_ADMIN_ROLE rather than an operational role.
     */
    function setMintingAddress(address _mintingAddress) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setMintingAddress(_mintingAddress);
    }

    // ============================================
    // VIEWS
    // ============================================

    /// @notice Whether assets may be withdrawn to `destination`
    function isDestination(address destination) public view returns (bool) {
        return _destinations.contains(destination);
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
        if (!_destinations.contains(to)) revert NotWhitelistedDestination(to);
        if (amount == 0) revert InvalidAmount();

        IERC20(asset).safeTransfer(to, amount);

        emit Withdrawal(asset, to, amount);
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

    function _addDestination(address destination, string memory label) internal virtual {
        if (destination == address(0)) revert ZeroAddress();
        // The two exit routes stay disjoint: minting is reached through returnToMinting, never
        // through withdraw, so every movement is unambiguous in the event log.
        if (destination == address(this) || destination == mintingAddress) revert InvalidAddress();
        if (!_destinations.add(destination)) revert AlreadyWhitelisted(destination);

        destinationLabel[destination] = label;

        emit DestinationAdded(destination, label);
    }

    function _setMintingAddress(address _mintingAddress) internal virtual {
        if (_mintingAddress == address(0)) revert ZeroAddress();
        if (_mintingAddress == address(this) || _mintingAddress.code.length == 0) revert InvalidAddress();
        if (_destinations.contains(_mintingAddress)) revert InvalidAddress();

        mintingAddress = _mintingAddress;

        emit MintingAddressChanged(_mintingAddress);
    }

    /// @dev Accepts native currency so it is recoverable through `withdrawNative`
    receive() external payable {
        emit NativeReceived(msg.sender, msg.value);
    }
}
