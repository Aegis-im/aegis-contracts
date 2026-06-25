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
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

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
 *      3. UNISWAP  — swap own collateral via Uniswap Universal Router → fee split → deposit to rewards
 *
 *      DEX routes (CURVE/UNISWAP) require a signed OrderLib.Order from trustedSigner, matching the
 *      pattern used by AegisMinting.depositIncome. The order carries collateral params and minYUSDOut;
 *      the actual DEX calldata is passed separately and is not signed.
 */
contract AegisIncomeRouter is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================
    // ENUMS
    // ============================================

    enum Route { MINTING, CURVE, UNISWAP }

    // ============================================
    // EIP-712
    // ============================================

    bytes32 private constant EIP712_DOMAIN =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant EIP712_NAME     = keccak256("AegisIncomeRouter");
    bytes32 private constant EIP712_REVISION = keccak256("1");

    bytes32 private immutable _domainSeparator;

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Role for executing income routing operations
    bytes32 public constant INCOME_ROUTER_ROLE    = keccak256("INCOME_ROUTER_ROLE");

    /// @notice Role for operational settings (DEX config, limits, pause)
    bytes32 public constant SETTINGS_MANAGER_ROLE = keccak256("SETTINGS_MANAGER_ROLE");

    /// @notice YUSD stablecoin contract (immutable — core protocol token)
    IYUSD public immutable yusd;

    /// @notice Permit2 contract address (immutable — canonical across all networks)
    address public immutable permit2;

    /// @notice AegisMinting contract — router must hold FUNDS_MANAGER_ROLE there
    IAegisMinting public aegisMinting;

    /// @notice AegisRewards contract where income is deposited
    IAegisRewards public aegisRewards;

    /// @notice Uniswap Universal Router address
    address public uniswapV4Router;

    /// @notice Curve YUSD/USDC pool address
    address public curveYusdUsdc;

    /// @notice Curve YUSD/USDT pool address
    address public curveYusdUsdt;

    /// @notice USDT token address
    address public usdt;

    /// @notice USDC token address
    address public usdc;

    /// @notice Max USDT amount routed through Curve YUSD/USDT pool (risk cap)
    uint256 public usdtCurveMaxAmount;

    /// @notice Basis points constant (10000 = 100%)
    uint16 private constant MAX_BPS = 10_000;

    /// @notice Pause state for emergency stops
    bool public paused;

    /// @notice Mapping of approved DEX router addresses
    mapping(address => bool) public approvedDexRouters;

    /// @notice Address whose private key signs DEX swap orders
    address public trustedSigner;

    /// @notice Bitmap-based nonce tracking per operator wallet (same pattern as AegisMinting)
    mapping(address => mapping(uint256 => uint256)) private _orderBitmaps;

    // ============================================
    // STRUCTS
    // ============================================

    /**
     * @notice Quote comparison for all income routes
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
    event TrustedSignerChanged(address indexed signer);
    event AegisMintingChanged(address indexed minting);
    event AegisRewardsChanged(address indexed rewards);
    event UniswapRouterChanged(address indexed router);
    event CurvePoolChanged(address indexed pool, address indexed token);
    event StablecoinChanged(address indexed token, bool isUsdc);
    event UsdtCurveMaxAmountChanged(uint256 amount);

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
    error PriceSlippage();

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

        _domainSeparator = keccak256(
            abi.encode(EIP712_DOMAIN, EIP712_NAME, EIP712_REVISION, block.chainid, address(this))
        );
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
     * Route.MINTING  — `order` is forwarded to AegisMinting.depositIncome as-is.
     *                  `signature` is verified by AegisMinting against its own trustedSigner.
     *                  `swapCalldata` is ignored.
     *
     * Route.CURVE /
     * Route.UNISWAP — `order` must be of type DEX_SWAP and signed by this router's trustedSigner.
     *                 Order fields used:
     *                   • collateralAsset / collateralAmount  — what to swap from router balance
     *                   • slippageAdjustedAmount              — minYUSDOut slippage floor
     *                   • expiry / nonce                      — replay protection
     *                   • additionalData                      — abi.encode(dexRouter, snapshotId)
     *                 `swapCalldata` is the raw call forwarded to dexRouter (not signed; outcome is
     *                 verified against slippageAdjustedAmount after execution).
     *
     * @param route        Income route (MINTING / CURVE / UNISWAP)
     * @param order        Signed order — minting order for MINTING route, DEX_SWAP order for DEX routes
     * @param signature    Signature over `order`
     * @param swapCalldata Encoded swap call forwarded to dexRouter (DEX routes only)
     */
    function routeIncome(
        Route route,
        OrderLib.Order calldata order,
        bytes calldata signature,
        bytes calldata swapCalldata
    ) external nonReentrant onlyRole(INCOME_ROUTER_ROLE) whenNotPaused {
        if (route == Route.MINTING) {
            _routeMinting(order, signature);
        } else {
            _verifyDexOrder(order, signature);
            (address dexRouter, bytes memory snapshotId) = abi.decode(order.additionalData, (address, bytes));
            _routeDex(
                route,
                order.collateralAsset,
                order.collateralAmount,
                dexRouter,
                swapCalldata,
                order.slippageAdjustedAmount,
                snapshotId
            );
        }
    }

    // ============================================
    // QUOTE FUNCTIONS (VIEW)
    // ============================================

    function getIncomeQuote(
        address collateralAsset,
        uint256 amount,
        uint256 curveQuote,
        uint256 uniswapQuote
    ) external view returns (IncomeQuote memory quote) {
        quote.curveOutput   = curveQuote;
        quote.uniswapOutput = uniswapQuote;
        quote.mintingOutput = _getMintingQuote(collateralAsset, amount);

        address insuranceFund = aegisMinting.insuranceFundAddress();
        uint16 feeBP = aegisMinting.incomeFeeBP();

        (quote.curveRewards, )   = _calculateIncomeFee(quote.curveOutput,   insuranceFund, feeBP);
        (quote.uniswapRewards, ) = _calculateIncomeFee(quote.uniswapOutput, insuranceFund, feeBP);
        (quote.mintingRewards, ) = _calculateIncomeFee(quote.mintingOutput,  insuranceFund, feeBP);

        address curveRouter   = _findCurveRouter(collateralAsset);
        bool uniswapApproved  = approvedDexRouters[uniswapV4Router];

        quote.recommendedRoute = _getBestRoute(curveRouter, uniswapApproved, quote.curveRewards, quote.uniswapRewards, quote.mintingRewards);
    }

    function getDomainSeparator() external view returns (bytes32) {
        return _domainSeparator;
    }

    function verifyNonce(address sender, uint256 nonce) public view returns (uint256, uint256, uint256) {
        if (nonce == 0) revert InvalidAmount();
        uint256 invalidatorSlot = uint64(nonce) >> 8;
        uint256 invalidatorBit  = 1 << uint8(nonce);
        uint256 invalidator     = _orderBitmaps[sender][invalidatorSlot];
        if (invalidator & invalidatorBit != 0) revert InvalidAmount();
        return (invalidatorSlot, invalidator, invalidatorBit);
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    // ── DEFAULT_ADMIN_ROLE — critical settings ────────────────────────────────

    function setTrustedSigner(address _signer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_signer == address(0)) revert InvalidAddress();
        trustedSigner = _signer;
        emit TrustedSignerChanged(_signer);
    }

    function setAegisMinting(address _minting) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_minting == address(0)) revert InvalidAddress();
        aegisMinting = IAegisMinting(_minting);
        emit AegisMintingChanged(_minting);
    }

    function setAegisRewards(address _rewards) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_rewards == address(0)) revert InvalidAddress();
        aegisRewards = IAegisRewards(_rewards);
        emit AegisRewardsChanged(_rewards);
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert InvalidAddress();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    // ── SETTINGS_MANAGER_ROLE — operational settings ─────────────────────────

    function setUniswapRouter(address _router) external onlyRole(SETTINGS_MANAGER_ROLE) {
        if (_router == address(0)) revert InvalidAddress();
        uniswapV4Router = _router;
        emit UniswapRouterChanged(_router);
    }

    function setCurvePool(address _pool, address _token) external onlyRole(SETTINGS_MANAGER_ROLE) {
        if (_pool == address(0) || _token == address(0)) revert InvalidAddress();
        if (_token == usdc) {
            curveYusdUsdc = _pool;
        } else if (_token == usdt) {
            curveYusdUsdt = _pool;
        } else {
            revert InvalidAddress();
        }
        emit CurvePoolChanged(_pool, _token);
    }

    function setStablecoin(address _token, bool _isUsdc) external onlyRole(SETTINGS_MANAGER_ROLE) {
        if (_token == address(0)) revert InvalidAddress();
        if (_isUsdc) {
            usdc = _token;
        } else {
            usdt = _token;
        }
        emit StablecoinChanged(_token, _isUsdc);
    }

    function setUsdtCurveMaxAmount(uint256 _amount) external onlyRole(SETTINGS_MANAGER_ROLE) {
        usdtCurveMaxAmount = _amount;
        emit UsdtCurveMaxAmountChanged(_amount);
    }

    function setDexRouterApproval(address dexRouter, bool approved) external onlyRole(SETTINGS_MANAGER_ROLE) {
        if (dexRouter == address(0)) revert InvalidAddress();
        approvedDexRouters[dexRouter] = approved;
        emit DexRouterApprovalChanged(dexRouter, approved);
    }

    function setPaused(bool _paused) external onlyRole(SETTINGS_MANAGER_ROLE) {
        paused = _paused;
        emit PausedChanged(_paused);
    }

    // ============================================
    // INTERNAL — ROUTE HANDLERS
    // ============================================

    function _routeMinting(OrderLib.Order calldata order, bytes calldata signature) internal {
        if (order.collateralAmount == 0) revert InvalidAmount();

        IERC20(order.collateralAsset).safeTransfer(address(aegisMinting), order.collateralAmount);
        aegisMinting.depositIncome(order, signature);

        emit IncomeRouted(Route.MINTING, order.collateralAsset, order.collateralAmount, 0, 0, 0, order.additionalData);
    }

    function _routeDex(
        Route route,
        address collateralAsset,
        uint256 collateralAmount,
        address dexRouter,
        bytes calldata swapCalldata,
        uint256 minYUSDOut,
        bytes memory snapshotId
    ) internal {
        if (!approvedDexRouters[dexRouter]) revert InvalidDexRouter();
        if (collateralAmount == 0) revert InvalidAmount();

        if (collateralAsset == usdt && dexRouter == curveYusdUsdt && collateralAmount > usdtCurveMaxAmount) {
            revert InvalidAmount();
        }

        // Chainlink floor: minYUSDOut must be >= Chainlink fair value for the collateral.
        // Mirrors AegisMinting._calculateMinYUSDAmount / PriceSlippage pattern.
        // If no Chainlink feed exists for the asset, the check is skipped.
        uint256 chainlinkExpected = _getMintingQuote(collateralAsset, collateralAmount);
        if (chainlinkExpected > 0 && minYUSDOut < chainlinkExpected) {
            revert PriceSlippage();
        }

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

        emit IncomeRouted(route, collateralAsset, collateralAmount, yusdReceived, rewardsAmount, insuranceFee, snapshotId);
    }

    // ============================================
    // INTERNAL — SIGNATURE / NONCE
    // ============================================

    /**
     * @dev Verifies a DEX_SWAP order against this router's EIP-712 domain and trustedSigner.
     *      Mirrors the pattern used by AegisMinting for DEPOSIT_INCOME orders.
     *
     *      Order fields for DEX_SWAP:
     *        orderType             = OrderLib.OrderType.DEX_SWAP
     *        userWallet            = msg.sender (the operator calling routeIncome)
     *        collateralAsset       = token to swap from router balance
     *        collateralAmount      = amount to swap
     *        yusdAmount            = expected YUSD (informational, used for off-chain logging)
     *        slippageAdjustedAmount = minYUSDOut — minimum YUSD the router must receive
     *        expiry                = unix timestamp after which signature is invalid
     *        nonce                 = unique nonce for replay protection
     *        additionalData        = abi.encode(address dexRouter, bytes snapshotId)
     */
    function _verifyDexOrder(OrderLib.Order calldata order, bytes calldata signature) internal {
        if (order.orderType != OrderLib.OrderType.DEX_SWAP) revert InvalidRoute();
        if (order.userWallet != msg.sender) revert OrderLib.InvalidSender();
        if (order.collateralAmount == 0) revert InvalidAmount();
        if (block.timestamp > order.expiry) revert OrderLib.SignatureExpired();

        bytes32 orderHash = OrderLib.hashOrder(order, _domainSeparator);
        address signer    = ECDSA.recover(orderHash, signature);
        if (signer != trustedSigner) revert OrderLib.InvalidSignature();

        _deduplicateOrder(order.userWallet, order.nonce);
    }

    function _deduplicateOrder(address sender, uint256 nonce) private {
        (uint256 invalidatorSlot, uint256 invalidator, uint256 invalidatorBit) = verifyNonce(sender, nonce);
        _orderBitmaps[sender][invalidatorSlot] = invalidator | invalidatorBit;
    }

    // ============================================
    // INTERNAL — HELPERS
    // ============================================

    function _getMintingQuote(address collateralAsset, uint256 amount) internal view returns (uint256) {
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
