// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import { VaultAssetGuard } from "./AegisVault/VaultAssetGuard.sol";
import { AggregatorV3Interface } from "./AegisVault/interfaces/AggregatorV3Interface.sol";

/**
 * @title JUSDAssetGuard
 * @notice VaultAssetGuard plus a metered leg for the Ondo reserve program. JUSD holds part of its
 *         reserves as USDY on this contract; USDC is routed to a 2/4 multisig that mints USDY at
 *         Ondo and sends it back here.
 *
 * @dev The Ondo multisig is NOT an entry on the withdrawal whitelist — it is its own designated
 *      address, and the two sets are kept disjoint in both directions. That separation is what
 *      makes the meter meaningful:
 *
 *        withdraw(...)       → whitelisted venue/bank. Does not touch the counter.
 *        withdrawToOndo(...) → the multisig. Raises `ondoOutstanding` by the USD value sent.
 *        pullFromOndo(...)   → draws assets back out of the multisig. Lowers it by what arrives.
 *
 *      `ondoOutstanding` therefore measures value the multisig is holding right now and has not
 *      returned — counterparty exposure to the mint/redeem round trip, in USD with 18 decimals.
 *      `maxOndoOutstanding` caps it. A round trip is neutral overall: sending USDY back for
 *      redemption raises the counter by the USDY value, and the returning USDC lowers it again.
 *
 *      This bounds what the multisig holds at any moment. It does not bound how much USDY the
 *      contract accumulates: once USDY is back here the headroom is free again, by design.
 *
 *      Both legs are valued through per-asset Chainlink feeds, so USDC and USDY share one USD
 *      limit. An asset with no feed, or with a stale, non-positive or incomplete round, cannot
 *      move on the Ondo leg at all — the meter fails closed rather than guessing a price.
 *
 *      Returns are pulled with `transferFrom` against the multisig's own balance, so provenance
 *      is proven inside the transaction and no operator can credit a return that never happened.
 *      If the multisig pushes assets here by plain transfer instead, the counter does not move;
 *      `setOndoOutstanding` lets the whitelist manager reconcile that deliberately.
 *
 *      Every limit, the multisig address, the Ondo asset registry and the price feeds belong to
 *      WHITELIST_MANAGER_ROLE — the same role that decides where funds may go. COLLATERAL_MANAGER_ROLE
 *      moves assets inside those bounds and can neither raise a limit nor reprice an asset.
 */
contract JUSDAssetGuard is VaultAssetGuard {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice 2/4 multisig that mints and redeems USDY at Ondo on the protocol's behalf
    address public ondoMultisig;

    /// @notice USD value (18 decimals) sent to the multisig that has not come back yet
    uint256 public ondoOutstanding;

    /// @notice Cap on `ondoOutstanding`. Zero blocks the Ondo leg entirely — the deployment default.
    uint256 public maxOndoOutstanding;

    /// @notice Chainlink-compatible USD feed per asset
    mapping(address => AggregatorV3Interface) public priceFeed;

    /// @notice Maximum age of a feed answer, in seconds, per asset
    mapping(address => uint32) public feedHeartbeat;

    /// @dev Assets allowed to move on the Ondo leg — USDC out, USDY back
    EnumerableSet.AddressSet private _ondoAssets;

    // ============================================
    // EVENTS
    // ============================================

    /// @dev Emitted when assets are sent to the Ondo multisig
    event OndoWithdrawal(address indexed asset, uint256 amount, uint256 usdValue, uint256 outstanding);

    /// @dev Emitted when assets are drawn back out of the Ondo multisig
    event OndoReturn(address indexed asset, uint256 amount, uint256 usdValue, uint256 outstanding);

    /// @dev Emitted when the whitelist manager reconciles the counter by hand
    event OndoOutstandingReconciled(uint256 previous, uint256 current);

    /// @dev Emitted when the Ondo multisig address is changed
    event OndoMultisigChanged(address indexed multisig);

    /// @dev Emitted when the cap on outstanding Ondo exposure is changed
    event MaxOndoOutstandingChanged(uint256 max);

    /// @dev Emitted when an asset is allowed on / removed from the Ondo leg
    event OndoAssetChanged(address indexed asset, bool allowed);

    /// @dev Emitted when an asset's USD price feed is set
    event PriceFeedChanged(address indexed asset, address indexed feed, uint32 heartbeat);

    // ============================================
    // ERRORS
    // ============================================

    error OndoNotConfigured();
    error NotOndoAsset(address asset);
    error OndoLimitExceeded(uint256 requested, uint256 headroom);
    error MissingPriceFeed(address asset);
    error InvalidPrice(address asset);
    error UnsupportedDecimals(address asset);
    error OndoAssetInUse(address asset);
    error OutstandingNotSettled(uint256 outstanding);

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @param _mintingAddress AegisMintingJUSD contract that receives returned collateral
     * @param _admin          Initial DEFAULT_ADMIN_ROLE holder (expected to be a multisig)
     * @param _initialDelay   AccessControlDefaultAdminRules handover delay, in seconds
     * @param _destinations   Initial whitelist of addresses assets may be withdrawn to
     * @param _labels         Operator labels matching `_destinations`, one per entry
     * @param _whitelistCooldown Seconds before a newly added destination can receive funds; zero
     *                        disables it. Cannot be changed after deployment.
     *
     * @dev The Ondo leg starts closed: no multisig, no allowed assets and a zero cap. The whitelist
     *      manager opens it by setting the multisig, registering USDC/USDY with their feeds and
     *      raising the cap.
     */
    constructor(
        address _mintingAddress,
        address _admin,
        uint48 _initialDelay,
        address[] memory _destinations,
        string[] memory _labels,
        address[][] memory _assets,
        uint256 _whitelistCooldown,
        uint256 _mintingChangeDelay
    ) VaultAssetGuard(_mintingAddress, _admin, _initialDelay, _destinations, _labels, _assets, _whitelistCooldown, _mintingChangeDelay) {}

    // ============================================
    // ONDO LEG
    // ============================================

    /**
     * @notice Sends assets to the Ondo multisig and meters the exposure it creates
     * @param asset  Registered Ondo asset (USDC on the way out, USDY on the way back for redemption)
     * @param amount Amount to send
     */
    function withdrawToOndo(
        address asset,
        uint256 amount
    ) external nonReentrant onlyRole(COLLATERAL_MANAGER_ROLE) whenNotPaused {
        address multisig = ondoMultisig;
        if (multisig == address(0)) revert OndoNotConfigured();
        if (!_ondoAssets.contains(asset)) revert NotOndoAsset(asset);
        if (amount == 0) revert InvalidAmount();

        uint256 value = assetUsdValue(asset, amount);
        uint256 outstanding = ondoOutstanding + value;
        if (outstanding > maxOndoOutstanding) revert OndoLimitExceeded(value, ondoHeadroom());

        ondoOutstanding = outstanding;
        IERC20(asset).safeTransfer(multisig, amount);

        emit OndoWithdrawal(asset, amount, value, outstanding);
    }

    /**
     * @notice Draws assets back out of the Ondo multisig and releases the exposure they settle
     * @dev Pulled with `transferFrom` against the multisig's balance, so the return is proven in
     *      this transaction. The multisig must have approved this contract for `amount` first.
     *      Callable by a collateral manager or by the multisig itself. Never paused: value coming
     *      back must stay reachable during an incident, exactly like `returnToMinting`.
     * @param asset  Registered Ondo asset arriving from the multisig
     * @param amount Amount to draw
     */
    function pullFromOndo(address asset, uint256 amount) external nonReentrant {
        address multisig = ondoMultisig;
        if (multisig == address(0)) revert OndoNotConfigured();
        if (!hasRole(COLLATERAL_MANAGER_ROLE, _msgSender()) && _msgSender() != multisig) {
            revert AccessControlUnauthorizedAccount(_msgSender(), COLLATERAL_MANAGER_ROLE);
        }
        if (!_ondoAssets.contains(asset)) revert NotOndoAsset(asset);
        if (amount == 0) revert InvalidAmount();

        uint256 balanceBefore = IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(multisig, address(this), amount);
        uint256 received = IERC20(asset).balanceOf(address(this)) - balanceBefore;

        // A return larger than what is outstanding settles the position rather than going negative:
        // USDY accrues, so value can legitimately come back worth more than it left.
        uint256 value = assetUsdValue(asset, received);
        uint256 outstanding = ondoOutstanding > value ? ondoOutstanding - value : 0;
        ondoOutstanding = outstanding;

        emit OndoReturn(asset, received, value, outstanding);
    }

    // ============================================
    // LIMITS AND PRICING — WHITELIST_MANAGER_ROLE
    // ============================================

    /**
     * @notice Sets the multisig that mints USDY at Ondo
     * @dev Kept off the withdrawal whitelist so `withdraw` can never bypass the meter. Rotating it
     *      requires a settled position, so outstanding value is never reattributed to a new holder.
     */
    function setOndoMultisig(address multisig) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (multisig == address(0)) revert ZeroAddress();
        if (
            multisig == address(this) ||
            multisig == mintingAddress ||
            multisig == pendingMintingAddress ||
            isDestination(multisig)
        ) revert InvalidAddress();
        if (ondoOutstanding != 0) revert OutstandingNotSettled(ondoOutstanding);

        ondoMultisig = multisig;
        emit OndoMultisigChanged(multisig);
    }

    /// @notice Sets the cap on outstanding Ondo exposure, in USD with 18 decimals. Zero closes the leg.
    function setMaxOndoOutstanding(uint256 max) external onlyRole(WHITELIST_MANAGER_ROLE) {
        maxOndoOutstanding = max;
        emit MaxOndoOutstandingChanged(max);
    }

    /**
     * @notice Reconciles the counter by hand
     * @dev For returns that arrived outside `pullFromOndo` — a plain transfer from the multisig, or
     *      a position written off. Deliberately restricted to the role that owns the cap: reducing
     *      the counter frees headroom, so it is the same power as raising the limit.
     */
    function setOndoOutstanding(uint256 outstanding) external onlyRole(WHITELIST_MANAGER_ROLE) {
        emit OndoOutstandingReconciled(ondoOutstanding, outstanding);
        ondoOutstanding = outstanding;
    }

    /// @notice Allows or removes an asset on the Ondo leg
    function setOndoAsset(address asset, bool allowed) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (asset == address(0)) revert ZeroAddress();
        if (allowed) {
            if (address(priceFeed[asset]) == address(0)) revert MissingPriceFeed(asset);
            _ondoAssets.add(asset);
        } else {
            _ondoAssets.remove(asset);
        }
        emit OndoAssetChanged(asset, allowed);
    }

    /**
     * @notice Sets an asset's USD price feed and the maximum age of its answers
     * @dev Belongs to the limit-setting role: a price drives how much value a transfer consumes, so
     *      repricing an asset is the same power as moving the cap.
     */
    function setPriceFeed(address asset, AggregatorV3Interface feed, uint32 heartbeat) external onlyRole(WHITELIST_MANAGER_ROLE) {
        if (asset == address(0)) revert ZeroAddress();
        if (address(feed) != address(0) && (address(feed).code.length == 0 || heartbeat == 0)) revert InvalidAddress();
        if (address(feed) == address(0) && _ondoAssets.contains(asset)) revert OndoAssetInUse(asset);

        priceFeed[asset] = feed;
        feedHeartbeat[asset] = heartbeat;

        emit PriceFeedChanged(asset, address(feed), heartbeat);
    }

    // ============================================
    // VIEWS
    // ============================================

    /// @notice USD value (18 decimals) of `amount` of `asset` at the current validated feed price
    function assetUsdValue(address asset, uint256 amount) public view returns (uint256) {
        uint8 assetDecimals = IERC20Metadata(asset).decimals();
        if (assetDecimals > 18) revert UnsupportedDecimals(asset);

        return Math.mulDiv(amount, _validatedPrice(asset) * 10 ** (18 - assetDecimals), 1e18);
    }

    /// @notice How much more USD value may be sent to the Ondo multisig right now
    function ondoHeadroom() public view returns (uint256) {
        uint256 max = maxOndoOutstanding;
        uint256 outstanding = ondoOutstanding;
        return max > outstanding ? max - outstanding : 0;
    }

    /// @notice USD value of the registered Ondo assets this contract currently holds — the reserve
    function ondoAssetValue() external view returns (uint256 total) {
        uint256 length = _ondoAssets.length();
        for (uint256 i = 0; i < length; i++) {
            address asset = _ondoAssets.at(i);
            total += assetUsdValue(asset, IERC20(asset).balanceOf(address(this)));
        }
    }

    /// @notice Whether `asset` may move on the Ondo leg
    function isOndoAsset(address asset) external view returns (bool) {
        return _ondoAssets.contains(asset);
    }

    /// @notice All assets registered on the Ondo leg
    function ondoAssets() external view returns (address[] memory) {
        return _ondoAssets.values();
    }

    // ============================================
    // INTERNAL
    // ============================================

    /// @dev Rejects prices that are missing, non-positive, future-dated, stale or from an incomplete round
    function _validatedPrice(address asset) internal view returns (uint256) {
        AggregatorV3Interface feed = priceFeed[asset];
        if (address(feed) == address(0)) revert MissingPriceFeed(asset);

        (uint80 round, int256 answer, , uint256 updatedAt, uint80 answeredRound) = feed.latestRoundData();
        uint8 precision = feed.decimals();
        if (
            answer <= 0 ||
            updatedAt == 0 ||
            updatedAt > block.timestamp ||
            block.timestamp - updatedAt > feedHeartbeat[asset] ||
            answeredRound < round ||
            precision > 18
        ) revert InvalidPrice(asset);

        // Normalize every feed to 18 decimals, matching AegisMintingJUSD.
        return uint256(answer) * 10 ** (18 - precision);
    }

    /// @dev The multisig is never reachable through the plain whitelist, in either direction
    function _addDestination(address destination, string memory label, address[] memory assets) internal override {
        if (ondoMultisig != address(0) && destination == ondoMultisig) revert InvalidAddress();
        super._addDestination(destination, label, assets);
    }

    /// @dev The redemption sink is never the multisig either — checked when a change is proposed
    ///      and again when it is applied, so a multisig rotation in between cannot slip past.
    function _validateMintingAddress(address _mintingAddress) internal view override {
        if (ondoMultisig != address(0) && _mintingAddress == ondoMultisig) revert InvalidAddress();
        super._validateMintingAddress(_mintingAddress);
    }
}
