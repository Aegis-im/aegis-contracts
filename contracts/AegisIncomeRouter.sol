// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./interfaces/IAegisRewards.sol";
import "./interfaces/IYUSD.sol";
import "./interfaces/IAegisMinting.sol";
import "./lib/OrderLib.sol";
import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @notice Minimal Permit2 interface for allowance management
 */
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

/**
 * @title AegisIncomeRouter
 * @notice Routes protocol income through optimal paths to maximize YUSD deposited to AegisRewards.
 *         Spends from its own token balance — callers must fund the contract before routing.
 * @dev Supports three income routes:
 *      1. MINTING  — transfer own collateral to AegisMinting, call depositIncome (requires FUNDS_MANAGER_ROLE)
 *      2. CURVE    — swap own collateral via Curve pool → fee split → deposit to rewards
 *      3. UNISWAP  — swap own collateral via Uniswap V4 → fee split → deposit to rewards
 */
contract AegisIncomeRouter is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================
    // ENUMS
    // ============================================

    enum Route { MINTING, CURVE, UNISWAP }

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Role for executing income routing operations
    bytes32 public constant INCOME_ROUTER_ROLE = keccak256("INCOME_ROUTER_ROLE");

    /// @notice YUSD stablecoin contract
    IYUSD public immutable yusd;

    /// @notice AegisMinting contract — router must hold FUNDS_MANAGER_ROLE there
    IAegisMinting public immutable aegisMinting;

    /// @notice AegisRewards contract where income is deposited
    IAegisRewards public immutable aegisRewards;

    /// @notice Basis points constant (10000 = 100%)
    uint16 private constant MAX_BPS = 10_000;

    /// @notice Pause state for emergency stops
    bool public paused;

    /// @notice Mapping of approved DEX router addresses
    mapping(address => bool) public approvedDexRouters;

    /// @notice Permit2 contract address (used by Uniswap V4)
    address public immutable permit2;

    /// @notice Uniswap V4 Universal Router address
    address public immutable uniswapV4Router;

    /// @notice Curve YUSD/USDC pool address
    address public immutable curveYusdUsdc;

    /// @notice Curve YUSD/USDT pool address
    address public immutable curveYusdUsdt;

    /// @notice USDT token address
    address public immutable usdt;

    /// @notice USDC token address
    address public immutable usdc;

    /// @notice Max USDT amount for Curve pool safety check
    uint256 public immutable usdtCurveMaxAmount;

    // ============================================
    // STRUCTS
    // ============================================

    /**
     * @notice Quote comparison for all income routes
     * @param curveOutput Expected YUSD from Curve swap
     * @param uniswapOutput Expected YUSD from Uniswap swap
     * @param mintingOutput Expected YUSD from oracle-based minting
     * @param curveRewards YUSD to rewards after fee (Curve route)
     * @param uniswapRewards YUSD to rewards after fee (Uniswap route)
     * @param mintingRewards YUSD to rewards after fee (Minting route)
     * @param recommendedRoute Route with best output
     */
    struct IncomeQuote {
        uint256 curveOutput;
        uint256 uniswapOutput;
        uint256 mintingOutput;
        uint256 curveRewards;
        uint256 uniswapRewards;
        uint256 mintingRewards;
        Route recommendedRoute;
    }

    // ============================================
    // EVENTS
    // ============================================

    event IncomeRouted(
        Route indexed route,
        address indexed collateralAsset,
        uint256 collateralAmount,
        uint256 yusdReceived,
        uint256 rewardsDeposited,
        uint256 insuranceFee,
        bytes snapshotId
    );

    event DexRouterApprovalChanged(address indexed dexRouter, bool approved);

    event PausedChanged(bool paused);

    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    // ============================================
    // ERRORS
    // ============================================

    error Paused();
    error InvalidDexRouter();
    error SwapFailed();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error InvalidAddress();
    error InvalidAmount();
    error InvalidRoute();

    // ============================================
    // CONSTRUCTOR
    // ============================================

    constructor(
        address _yusd,
        address _aegisMinting,
        address _aegisRewards,
        address _admin,
        uint48 _initialDelay,
        address _permit2,
        address _uniswapV4Router,
        address _curveYusdUsdc,
        address _curveYusdUsdt,
        address _usdt,
        address _usdc,
        uint256 _usdtCurveMaxAmount
    ) AccessControlDefaultAdminRules(_initialDelay, _admin) {
        if (_yusd == address(0) || _aegisMinting == address(0) || _aegisRewards == address(0)) {
            revert InvalidAddress();
        }

        yusd = IYUSD(_yusd);
        aegisMinting = IAegisMinting(_aegisMinting);
        aegisRewards = IAegisRewards(_aegisRewards);
        permit2 = _permit2;
        uniswapV4Router = _uniswapV4Router;
        curveYusdUsdc = _curveYusdUsdc;
        curveYusdUsdt = _curveYusdUsdt;
        usdt = _usdt;
        usdc = _usdc;
        usdtCurveMaxAmount = _usdtCurveMaxAmount;
        paused = false;
    }

    // ============================================
    // MODIFIERS
    // ============================================

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // ============================================
    // INCOME ROUTING
    // ============================================

    /**
     * @notice Route income from the router's own balance to YUSD rewards via the selected path.
     *
     * Route.MINTING  — Transfers `order.collateralAmount` of `order.collateralAsset` from the
     *                  router's balance to AegisMinting, then calls depositIncome(order, signature).
     *                  The router must hold FUNDS_MANAGER_ROLE on AegisMinting.
     *                  Fee handling is done inside AegisMinting; DEX params are ignored.
     *
     * Route.CURVE /
     * Route.UNISWAP — Approves `dexRouter`, swaps `collateralAmount` of `collateralAsset` for
     *                 YUSD, applies the income fee, and deposits net YUSD to AegisRewards.
     *                 MINTING params (order, signature) are ignored.
     *
     * @param route          Income route to use (MINTING / CURVE / UNISWAP)
     * @param order          Signed order for AegisMinting (MINTING route only)
     * @param signature      Trusted-signer signature over `order` (MINTING route only)
     * @param collateralAsset Collateral token address (CURVE / UNISWAP routes only)
     * @param collateralAmount Collateral amount from router balance (CURVE / UNISWAP routes only)
     * @param dexRouter      Approved DEX router/pool address (CURVE / UNISWAP routes only)
     * @param swapCalldata   Encoded swap call (CURVE / UNISWAP routes only)
     * @param minYUSDOut     Minimum YUSD output — slippage guard (CURVE / UNISWAP routes only)
     * @param snapshotId     Rewards snapshot identifier (CURVE / UNISWAP routes only)
     */
    function routeIncome(
        Route route,
        OrderLib.Order calldata order,
        bytes calldata signature,
        address collateralAsset,
        uint256 collateralAmount,
        address dexRouter,
        bytes calldata swapCalldata,
        uint256 minYUSDOut,
        bytes calldata snapshotId
    ) external nonReentrant onlyRole(INCOME_ROUTER_ROLE) whenNotPaused {
        if (route == Route.MINTING) {
            _routeMinting(order, signature);
        } else {
            _routeDex(route, collateralAsset, collateralAmount, dexRouter, swapCalldata, minYUSDOut, snapshotId);
        }
    }

    // ============================================
    // QUOTE FUNCTIONS (VIEW)
    // ============================================

    /**
     * @notice Get quotes for all three income routes.
     * @dev DEX quotes must be calculated off-chain (Curve get_dy / Uniswap Quoter) and passed in.
     * @param collateralAsset Asset to quote
     * @param amount          Collateral amount
     * @param curveQuote      Expected YUSD from Curve (off-chain)
     * @param uniswapQuote    Expected YUSD from Uniswap (off-chain)
     * @return quote Struct with per-route outputs and a recommendation
     */
    function getIncomeQuote(
        address collateralAsset,
        uint256 amount,
        uint256 curveQuote,
        uint256 uniswapQuote
    ) external view returns (IncomeQuote memory quote) {
        quote.curveOutput = curveQuote;
        quote.uniswapOutput = uniswapQuote;
        quote.mintingOutput = _getMintingQuote(collateralAsset, amount);

        address insuranceFund = aegisMinting.insuranceFundAddress();
        uint16 feeBP = aegisMinting.incomeFeeBP();

        (quote.curveRewards, ) = _calculateIncomeFee(quote.curveOutput, insuranceFund, feeBP);
        (quote.uniswapRewards, ) = _calculateIncomeFee(quote.uniswapOutput, insuranceFund, feeBP);
        (quote.mintingRewards, ) = _calculateIncomeFee(quote.mintingOutput, insuranceFund, feeBP);

        address curveRouter = _findCurveRouter(collateralAsset);
        bool uniswapApproved = approvedDexRouters[uniswapV4Router];

        quote.recommendedRoute = _getBestRoute(
            curveRouter,
            uniswapApproved,
            quote.curveRewards,
            quote.uniswapRewards,
            quote.mintingRewards
        );
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    function setDexRouterApproval(
        address dexRouter,
        bool approved
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (dexRouter == address(0)) revert InvalidAddress();
        approvedDexRouters[dexRouter] = approved;
        emit DexRouterApprovalChanged(dexRouter, approved);
    }

    function setPaused(bool _paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = _paused;
        emit PausedChanged(_paused);
    }

    function rescueTokens(
        address token,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    // ============================================
    // INTERNAL — ROUTE HANDLERS
    // ============================================

    /**
     * @dev MINTING route: send router's own collateral to AegisMinting, then trigger depositIncome.
     *      order.userWallet must equal address(this) so AegisMinting's sender check passes.
     *      Router must hold FUNDS_MANAGER_ROLE on AegisMinting.
     */
    function _routeMinting(OrderLib.Order calldata order, bytes calldata signature) internal {
        if (order.collateralAmount == 0) revert InvalidAmount();

        // Move router's own collateral to AegisMinting (will appear as untracked balance there)
        IERC20(order.collateralAsset).safeTransfer(address(aegisMinting), order.collateralAmount);

        // AegisMinting mints YUSD, applies fee, and deposits to rewards internally
        aegisMinting.depositIncome(order, signature);

        emit IncomeRouted(
            Route.MINTING,
            order.collateralAsset,
            order.collateralAmount,
            0, // YUSD amount is emitted by AegisMinting's own DepositIncome event
            0,
            0,
            order.additionalData
        );
    }

    /**
     * @dev CURVE / UNISWAP route: swap router's own collateral for YUSD, then fee-split and deposit.
     */
    function _routeDex(
        Route route,
        address collateralAsset,
        uint256 collateralAmount,
        address dexRouter,
        bytes calldata swapCalldata,
        uint256 minYUSDOut,
        bytes calldata snapshotId
    ) internal {
        if (!approvedDexRouters[dexRouter]) revert InvalidDexRouter();
        if (collateralAmount == 0) revert InvalidAmount();

        // Prevent large USDT swaps through the Curve YUSD/USDT pool (pool drainage risk)
        if (collateralAsset == usdt && dexRouter == curveYusdUsdt && collateralAmount > usdtCurveMaxAmount) {
            revert InvalidAmount();
        }

        // Approve DEX to spend router's balance
        if (dexRouter == uniswapV4Router) {
            IERC20(collateralAsset).forceApprove(permit2, type(uint256).max);
            IPermit2(permit2).approve(
                collateralAsset,
                uniswapV4Router,
                type(uint160).max,
                uint48(block.timestamp + 1 hours)
            );
        } else {
            IERC20(collateralAsset).forceApprove(dexRouter, collateralAmount);
        }

        uint256 yusdBefore = yusd.balanceOf(address(this));

        (bool success, bytes memory returnData) = dexRouter.call(swapCalldata);
        if (!success) {
            if (returnData.length > 0) {
                assembly {
                    revert(add(32, returnData), mload(returnData))
                }
            }
            revert SwapFailed();
        }

        uint256 yusdReceived = yusd.balanceOf(address(this)) - yusdBefore;
        if (yusdReceived < minYUSDOut) revert InsufficientOutput(yusdReceived, minYUSDOut);

        address insuranceFund = aegisMinting.insuranceFundAddress();
        uint16 feeBP = aegisMinting.incomeFeeBP();

        (uint256 rewardsAmount, uint256 insuranceFee) = _calculateIncomeFee(yusdReceived, insuranceFund, feeBP);

        if (insuranceFee > 0) {
            IERC20(address(yusd)).safeTransfer(insuranceFund, insuranceFee);
        }

        IERC20(address(yusd)).safeTransfer(address(aegisRewards), rewardsAmount);
        aegisRewards.depositRewards(snapshotId, rewardsAmount);

        emit IncomeRouted(
            route,
            collateralAsset,
            collateralAmount,
            yusdReceived,
            rewardsAmount,
            insuranceFee,
            snapshotId
        );
    }

    // ============================================
    // INTERNAL — HELPERS
    // ============================================

    function _getMintingQuote(
        address collateralAsset,
        uint256 amount
    ) internal view returns (uint256) {
        uint256 chainlinkPrice = aegisMinting.assetChainlinkUSDPrice(collateralAsset);
        if (chainlinkPrice == 0) return 0;

        uint8 collateralDecimals = IERC20Metadata(collateralAsset).decimals();
        return Math.mulDiv(
            amount * 10 ** (18 - collateralDecimals),
            chainlinkPrice,
            10 ** 8
        );
    }

    function _getBestRoute(
        address curveRouter,
        bool uniswapApproved,
        uint256 curveRewards,
        uint256 uniswapRewards,
        uint256 mintingRewards
    ) internal pure returns (Route best) {
        best = Route.MINTING;
        uint256 max = mintingRewards;

        if (curveRewards > max && curveRouter != address(0)) {
            max = curveRewards;
            best = Route.CURVE;
        }

        if (uniswapRewards > max && uniswapApproved) {
            best = Route.UNISWAP;
        }
    }

    function _findCurveRouter(address collateralAsset) internal view returns (address) {
        if (collateralAsset == usdc && approvedDexRouters[curveYusdUsdc]) return curveYusdUsdc;
        if (approvedDexRouters[curveYusdUsdt]) return curveYusdUsdt;
        return address(0);
    }

    function _calculateIncomeFee(
        uint256 amount,
        address insuranceFund,
        uint16 feeBP
    ) internal pure returns (uint256 netAmount, uint256 fee) {
        if (insuranceFund == address(0) || feeBP == 0) return (amount, 0);
        fee = (amount * feeBP) / MAX_BPS;
        netAmount = amount - fee;
    }
}
