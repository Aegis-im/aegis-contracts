// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import "./interfaces/IAegisRewards.sol";
import "./interfaces/IYUSD.sol";
import "./interfaces/IAegisMinting.sol";
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
 * @notice Routes protocol income through optimal paths to maximize YUSD deposited to AegisRewards
 * @dev Supports three income routes:
 *      2. Swap via Curve
 *      3. Swap via Uniswap V4
 */
contract AegisIncomeRouter is AccessControlDefaultAdminRules, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ============================================
    // STATE VARIABLES
    // ============================================

    /// @notice Role for executing income routing operations
    bytes32 public constant INCOME_ROUTER_ROLE = keccak256("INCOME_ROUTER_ROLE");

    /// @notice YUSD stablecoin contract
    IYUSD public immutable yusd;

    /// @notice AegisMinting contract for oracle-based minting
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
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    /// @notice Uniswap V4 Universal Router address
    address public constant UNISWAP_V4_ROUTER = 0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af;

    // ============================================
    // STRUCTS
    // ============================================

    /**
     * @notice Quote comparison for all income routes
     * @param curveOutput Expected YUSD from Curve swap
     * @param uniswapOutput Expected YUSD from Uniswap swap
     * @param mintingOutput Expected YUSD from oracle-based minting
     * @param curveRewards YUSD to rewards after 5% fee (Curve route)
     * @param uniswapRewards YUSD to rewards after 5% fee (Uniswap route)
     * @param mintingRewards YUSD to rewards after 5% fee (Minting route)
     * @param recommendedRouter Address of router with best output (address(0) = minting)
     */
    struct IncomeQuote {
        uint256 curveOutput;
        uint256 uniswapOutput;
        uint256 mintingOutput;
        uint256 curveRewards;
        uint256 uniswapRewards;
        uint256 mintingRewards;
        address recommendedRouter;
    }

    // ============================================
    // EVENTS
    // ============================================

    event TransferredToMinting(
        address indexed collateralAsset,
        uint256 amount,
        address indexed executor
    );

    event SwapAndDeposit(
        address indexed collateralAsset,
        uint256 collateralAmount,
        address indexed dexRouter,
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

    // ============================================
    // CONSTRUCTOR
    // ============================================

    /**
     * @notice Initialize the AegisIncomeRouter
     * @param _yusd YUSD token address
     * @param _aegisMinting AegisMinting contract address
     * @param _aegisRewards AegisRewards contract address
     * @param _admin Admin address
     * @param _initialDelay Delay for admin role transfer (3 days recommended)
     */
    constructor(
        address _yusd,
        address _aegisMinting,
        address _aegisRewards,
        address _admin,
        uint48 _initialDelay
    ) AccessControlDefaultAdminRules(_initialDelay, _admin) {
        if (_yusd == address(0) || _aegisMinting == address(0) || _aegisRewards == address(0)) {
            revert InvalidAddress();
        }

        yusd = IYUSD(_yusd);
        aegisMinting = IAegisMinting(_aegisMinting);
        aegisRewards = IAegisRewards(_aegisRewards);
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
    // INCOME ROUTING FUNCTIONS
    // ============================================

    /**
     * @notice Route 1: Transfer collateral to AegisMinting for oracle-based minting
     * @dev Use this route when:
     *      - DEX liquidity is poor (high slippage)
     *      - Oracle price is better than DEX price
     *      - Guaranteed zero slippage needed
     * @param collateralAsset Address of collateral token (USDC, USDT, DAI)
     * @param amount Amount of collateral to transfer
     */
    function transferToMinting(
        address collateralAsset,
        uint256 amount
    ) external nonReentrant onlyRole(INCOME_ROUTER_ROLE) whenNotPaused {
        if (amount == 0) revert InvalidAmount();

        // Transfer collateral from caller to AegisMinting
        IERC20(collateralAsset).safeTransferFrom(
            msg.sender,
            address(aegisMinting),
            amount
        );

        emit TransferredToMinting(collateralAsset, amount, msg.sender);
    }

    /**
     * @notice Route 2/3: Swap collateral to YUSD via DEX and deposit to rewards
     * @dev Use this route when:
     *      - DEX offers better rate than oracle (after gas costs)
     *      - Sufficient liquidity available
     *      - Route 2: Curve for large stablecoin swaps (lowest slippage)
     *      - Route 3: Uniswap V4 for general swaps
     * @param collateralAsset Address of collateral token
     * @param collateralAmount Amount of collateral to swap
     * @param dexRouter Address of approved DEX router (Curve or Uniswap)
     * @param swapCalldata Encoded swap function call for the DEX
     * @param minYUSDOut Minimum YUSD output (slippage protection)
     * @param snapshotId Snapshot ID for rewards distribution
     */
    function swapAndDeposit(
        address collateralAsset,
        uint256 collateralAmount,
        address dexRouter,
        bytes calldata swapCalldata,
        uint256 minYUSDOut,
        bytes calldata snapshotId
    ) external nonReentrant onlyRole(INCOME_ROUTER_ROLE) whenNotPaused {
        if (!approvedDexRouters[dexRouter]) revert InvalidDexRouter();
        if (collateralAmount == 0) revert InvalidAmount();

        // SAFETY: Prevent large USDT swaps through Curve YUSD/USDT pool
        // Pool has limited liquidity (~40k LP tokens) and becomes unusable >$10k
        address CURVE_YUSD_USDT = 0xCF908d925b21594f9a92b264167A85B0649051a8;
        address USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
        uint256 USDT_CURVE_MAX_AMOUNT = 10000e6; // $10,000 max for Curve USDT pool

        if (collateralAsset == USDT &&
            dexRouter == CURVE_YUSD_USDT &&
            collateralAmount > USDT_CURVE_MAX_AMOUNT) {
            revert InvalidAmount(); // Prevent pool drainage - use minting instead
        }

        // Transfer collateral from caller to this contract
        IERC20(collateralAsset).safeTransferFrom(
            msg.sender,
            address(this),
            collateralAmount
        );

        // For Uniswap V4, approve via Permit2 system
        if (dexRouter == UNISWAP_V4_ROUTER) {
            // Approve Permit2 to spend collateral (max approval for efficiency)
            IERC20(collateralAsset).forceApprove(PERMIT2, type(uint256).max);

            // Approve Universal Router via Permit2.approve()
            IPermit2(PERMIT2).approve(
                collateralAsset,
                UNISWAP_V4_ROUTER,
                type(uint160).max,
                uint48(block.timestamp + 1 hours)
            );
        } else {
            // For Curve and other DEXs, approve directly
            IERC20(collateralAsset).forceApprove(dexRouter, collateralAmount);
        }

        // Get YUSD balance before swap
        uint256 yusdBalanceBefore = yusd.balanceOf(address(this));

        // Execute swap via DEX
        (bool success, bytes memory returnData) = dexRouter.call(swapCalldata);
        if (!success) {
            // Bubble up the revert reason if available
            if (returnData.length > 0) {
                assembly {
                    revert(add(32, returnData), mload(returnData))
                }
            }
            revert SwapFailed();
        }

        // Calculate YUSD received
        uint256 yusdBalanceAfter = yusd.balanceOf(address(this));

        uint256 yusdReceived = yusdBalanceAfter - yusdBalanceBefore;

        if (yusdReceived < minYUSDOut) {
            revert InsufficientOutput(yusdReceived, minYUSDOut);
        }

        // Apply income fee (same as minting route)
        // Read fee parameters from AegisMinting contract
        address insuranceFund = aegisMinting.insuranceFundAddress();
        uint16 feeBP = aegisMinting.incomeFeeBP();

        // Calculate fee split
        (uint256 rewardsAmount, uint256 insuranceFee) = _calculateIncomeFee(
            yusdReceived,
            insuranceFund,
            feeBP
        );

        // Transfer fee to insurance fund if applicable
        if (insuranceFee > 0) {
            yusd.transfer(insuranceFund, insuranceFee);
        }

        // Transfer remaining YUSD to AegisRewards, then call depositRewards
        yusd.transfer(address(aegisRewards), rewardsAmount);
        aegisRewards.depositRewards(snapshotId, rewardsAmount);

        emit SwapAndDeposit(
            collateralAsset,
            collateralAmount,
            dexRouter,
            yusdReceived,
            rewardsAmount,
            insuranceFee,
            snapshotId
        );
    }

    // ============================================
    // QUOTE FUNCTIONS (VIEW)
    // ============================================

    /**
     * @notice Get quotes for all three income routes
     * @dev Only returns minting quote on-chain (oracle-based, zero gas)
     *      For Curve/Uniswap quotes, use their off-chain quoter contracts:
     *      - Curve: Call get_dy() on pool contract
     *      - Uniswap V4: Use Quoter contract
     *      This approach is more gas-efficient and avoids on-chain simulation complexity
     * @param collateralAsset Asset to deposit (USDC, USDT, DAI)
     * @param amount Amount of collateral
     * @param curveQuote Expected YUSD from Curve (calculated off-chain)
     * @param uniswapQuote Expected YUSD from Uniswap (calculated off-chain)
     * @return quote Comparison of all three routes with recommendation
     */
    function getIncomeQuote(
        address collateralAsset,
        uint256 amount,
        uint256 curveQuote,
        uint256 uniswapQuote
    ) external view returns (IncomeQuote memory quote) {
        // Use provided DEX quotes (calculated off-chain)
        quote.curveOutput = curveQuote;
        quote.uniswapOutput = uniswapQuote;

        // Get minting quote from oracle (on-chain, view function)
        quote.mintingOutput = _getMintingQuote(collateralAsset, amount);

        // Apply income fee to all routes consistently
        // Read fee parameters from AegisMinting contract
        address insuranceFund = aegisMinting.insuranceFundAddress();
        uint16 feeBP = aegisMinting.incomeFeeBP();

        // Calculate rewards after fee for each route
        (quote.curveRewards, ) = _calculateIncomeFee(quote.curveOutput, insuranceFund, feeBP);
        (quote.uniswapRewards, ) = _calculateIncomeFee(quote.uniswapOutput, insuranceFund, feeBP);
        (quote.mintingRewards, ) = _calculateIncomeFee(quote.mintingOutput, insuranceFund, feeBP);

        // Determine best route
        address curveRouter = _findRouterByType(true, collateralAsset);
        address uniswapRouter = _findRouterByType(false, collateralAsset);

        quote.recommendedRouter = _getBestRoute(
            curveRouter,
            uniswapRouter,
            quote.curveRewards,
            quote.uniswapRewards,
            quote.mintingRewards
        );
    }

    /**
     * @notice Get expected YUSD from oracle-based minting (COMPARISON ONLY)
     * @dev Duplicates AegisMinting's oracle logic for quote comparison
     *      This router does NOT execute minting - quotes are for comparison only
     * @param collateralAsset Collateral token address
     * @param amount Amount of collateral
     * @return yusdAmount Expected YUSD based on Chainlink oracle price
     */
    function _getMintingQuote(
        address collateralAsset,
        uint256 amount
    ) internal view returns (uint256 yusdAmount) {
        // Get Chainlink oracle price from AegisMinting (uses public getter)
        uint256 chainlinkPrice = aegisMinting.assetChainlinkUSDPrice(collateralAsset);

        if (chainlinkPrice == 0) {
            return 0;
        }

        // Calculate expected YUSD amount (1:1 with USD value)
        // Normalize collateral to 18 decimals, multiply by price, divide by price decimals (8)
        uint8 collateralDecimals = IERC20Metadata(collateralAsset).decimals();

        yusdAmount = Math.mulDiv(
            amount * 10 ** (18 - collateralDecimals),
            chainlinkPrice,
            10 ** 8 // Chainlink uses 8 decimals for USD prices
        );

        return yusdAmount;
    }

    /**
     * @notice Determine best route based on YUSD output to rewards
     * @param curveRouter Curve router address (address(0) if not approved)
     * @param uniswapRouter Uniswap router address (address(0) if not approved)
     * @param curveRewards YUSD to rewards from Curve route
     * @param uniswapRewards YUSD to rewards from Uniswap route
     * @param mintingRewards YUSD to rewards from minting route
     * @return bestRouter Address of best router (address(0) = use minting)
     */
    function _getBestRoute(
        address curveRouter,
        address uniswapRouter,
        uint256 curveRewards,
        uint256 uniswapRewards,
        uint256 mintingRewards
    ) internal pure returns (address bestRouter) {
        // Find maximum output
        uint256 maxOutput = mintingRewards;
        address bestAddress = address(0); // Default to minting

        if (curveRewards > maxOutput && curveRouter != address(0)) {
            maxOutput = curveRewards;
            bestAddress = curveRouter;
        }

        if (uniswapRewards > maxOutput && uniswapRouter != address(0)) {
            maxOutput = uniswapRewards;
            bestAddress = uniswapRouter;
        }

        return bestAddress;
    }

    /**
     * @notice Find router address by type (helper for quote function)
     * @dev Returns appropriate pool/router based on collateral asset and route type
     * @param isCurve True for Curve, false for Uniswap
     * @param collateralAsset The collateral asset being swapped
     * @return router Router address (address(0) if not found)
     */
    function _findRouterByType(bool isCurve, address collateralAsset) internal view returns (address router) {
        // Mainnet addresses (checksummed)
        // REAL Curve YUSD pools (factory-stable-ng)
        address CURVE_YUSD_USDC = 0x9804C30875127246AC92D72D5CDF0630aA356861; // factory-stable-ng-407
        address CURVE_YUSD_USDT = 0xCF908d925b21594f9a92b264167A85B0649051a8; // factory-stable-ng-360

        // USDC address for comparison
        address USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

        if (isCurve) {
            // Return appropriate Curve pool based on collateral asset
            if (collateralAsset == USDC && approvedDexRouters[CURVE_YUSD_USDC]) {
                return CURVE_YUSD_USDC;
            } else if (approvedDexRouters[CURVE_YUSD_USDT]) {
                // For USDT and any other stablecoins, use USDT pool
                return CURVE_YUSD_USDT;
            }
        } else if (!isCurve && approvedDexRouters[UNISWAP_V4_ROUTER]) {
            return UNISWAP_V4_ROUTER;
        }

        return address(0);
    }

    // ============================================
    // ADMIN FUNCTIONS
    // ============================================

    /**
     * @notice Approve or revoke DEX router
     * @param dexRouter DEX router address
     * @param approved True to approve, false to revoke
     */
    function setDexRouterApproval(
        address dexRouter,
        bool approved
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (dexRouter == address(0)) revert InvalidAddress();
        approvedDexRouters[dexRouter] = approved;
        emit DexRouterApprovalChanged(dexRouter, approved);
    }

    /**
     * @notice Pause or unpause the contract
     * @param _paused True to pause, false to unpause
     */
    function setPaused(bool _paused) external onlyRole(DEFAULT_ADMIN_ROLE) {
        paused = _paused;
        emit PausedChanged(_paused);
    }

    /**
     * @notice Rescue tokens accidentally sent to this contract
     * @param token Token address to rescue
     * @param to Recipient address
     * @param amount Amount to rescue
     */
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
    // INTERNAL FUNCTIONS
    // ============================================

    /**
     * @notice Calculate insurance fund fee from amount
     * @dev Duplicates logic from AegisMinting._calculateInsuranceFundFeeFromAmount
     *      This duplication is intentional to avoid external calls during swap execution
     * @param amount Total YUSD amount before fee
     * @param insuranceFund Insurance fund address from AegisMinting
     * @param feeBP Fee in basis points (read from AegisMinting, e.g. 1000 = 10%)
     * @return netAmount Amount after fee (to rewards)
     * @return fee Fee amount (to insurance fund)
     */
    function _calculateIncomeFee(
        uint256 amount,
        address insuranceFund,
        uint16 feeBP
    ) internal pure returns (uint256 netAmount, uint256 fee) {
        if (insuranceFund == address(0) || feeBP == 0) {
            return (amount, 0);
        }

        fee = (amount * feeBP) / MAX_BPS;
        netAmount = amount - fee;

        return (netAmount, fee);
    }
}
