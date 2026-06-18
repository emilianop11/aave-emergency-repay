// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IAavePool {
    /// @notice Redeems Aave aTokens held by `msg.sender` into the underlying asset.
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    /// @notice Repays Aave debt for `onBehalfOf` using `asset` already approved by the caller.
    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    /// @notice Starts an Aave V3 single-asset flash loan and calls the receiver callback.
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    /// @notice Returns Aave's current flash-loan premium in basis points.
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    /// @notice Returns the Aave addresses provider backing this pool.
    function ADDRESSES_PROVIDER() external view returns (address);

    /// @notice Returns account-level Aave risk data; this contract only consumes `healthFactor`.
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );

    struct ReserveDataLegacy {
        uint256 configuration;
        uint128 liquidityIndex;
        uint128 currentLiquidityRate;
        uint128 variableBorrowIndex;
        uint128 currentVariableBorrowRate;
        uint128 currentStableBorrowRate;
        uint40 lastUpdateTimestamp;
        uint16 id;
        address aTokenAddress;
        address stableDebtTokenAddress;
        address variableDebtTokenAddress;
        address interestRateStrategyAddress;
        uint128 accruedToTreasury;
        uint128 unbacked;
        uint128 isolationModeTotalDebt;
    }

    /// @notice Returns reserve metadata, including canonical aToken and debt-token addresses.
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}

interface IAaveOracle {
    /// @notice Returns Aave's base-currency price for an asset.
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IPoolAddressesProvider {
    /// @notice Returns the current Aave oracle address.
    function getPriceOracle() external view returns (address);
}

interface IAaveReserveToken {
    /// @notice Returns the underlying asset represented by an Aave reserve token.
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);

    /// @notice Returns the Aave pool that minted/manages this reserve token.
    function POOL() external view returns (address);
}

interface IUniswapV3Factory {
    /// @notice Returns the canonical Uniswap V3 pool for a token pair and fee tier.
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    /// @notice Returns the first token in the pool's sorted token pair.
    function token0() external view returns (address);

    /// @notice Returns the second token in the pool's sorted token pair.
    function token1() external view returns (address);

    /// @notice Returns the pool fee tier.
    function fee() external view returns (uint24);

    /// @notice Returns the Uniswap V3 factory that created this pool.
    function factory() external view returns (address);
}

interface IUniswapV3SwapRouter {
    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps as little tokenIn as possible for an exact tokenOut amount.
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);

    /// @notice Returns the Uniswap V3 factory used by this router.
    function factory() external view returns (address);
}

/// @notice Emergency-only USDC debt repayer for an immutable EOA-owned Aave WETH/USDC position.
/// @dev The position remains owned by POSITION_OWNER. This contract cannot supply, borrow, loop, or withdraw
///      normal collateral. It can only atomically repay all variable USDC debt using a WETH flash loan and a
///      bounded amount of aWETH previously approved by POSITION_OWNER. This V1 assumes POSITION_OWNER is a
///      dedicated EOA whose Aave position uses only WETH collateral and variable native-USDC debt.
contract AaveEmergencyRepayer {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant VARIABLE_RATE_MODE = 2;
    uint256 private constant WETH_SCALE = 1e18;
    uint256 private constant USDC_SCALE = 1e6;
    uint256 private constant MAX_ALLOWED_SLIPPAGE_BPS = 500;
    uint256 private constant MAX_USDC_REPAY_BUFFER = 10 * USDC_SCALE;
    uint16 public constant MIN_UPPER_HEALTH_FACTOR_DISTANCE_BPS = 500;

    IAavePool public immutable AAVE_POOL;
    IPoolAddressesProvider public immutable ADDRESSES_PROVIDER;
    IUniswapV3SwapRouter public immutable SWAP_ROUTER;

    IERC20 public immutable WETH;
    IERC20 public immutable USDC;
    IERC20 public immutable A_WETH;
    IERC20 public immutable VARIABLE_DEBT_USDC;

    address public immutable POSITION_OWNER;
    address public immutable KEEPER;
    address public immutable UNISWAP_POOL;

    uint24 public immutable UNISWAP_POOL_FEE;
    uint16 public immutable MAX_SLIPPAGE_BPS;
    uint256 public immutable TRIGGER_HEALTH_FACTOR;
    uint256 public immutable USDC_REPAY_BUFFER;

    uint256 public upperHealthFactor;

    bool private flashActive;

    struct Config {
        address aavePool;
        address swapRouter;
        address weth;
        address usdc;
        address aWeth;
        address variableDebtUsdc;
        address positionOwner;
        address keeper;
        address uniswapPool;
        uint24 uniswapPoolFee;
        uint16 maxSlippageBps;
        uint256 triggerHealthFactor;
        uint256 usdcRepayBuffer;
    }

    error Unauthorized();
    error ZeroAddress();
    error InvalidActors();
    error InvalidBps();
    error InvalidRepayBuffer();
    error InvalidHealthFactor();
    error InvalidAavePool();
    error InvalidAddressesProvider();
    error InvalidCurrentOracle();
    error InvalidToken();
    error InvalidTokenDecimals();
    error InvalidAToken();
    error InvalidDebtToken();
    error InvalidSwapRouter();
    error InvalidUniswapPool();
    error UniswapPoolMismatch();
    error InvalidUniswapPoolTokens();
    error InvalidUniswapPoolFee();
    error InvalidUniswapPoolFactory();
    error NoDebt();
    error HealthFactorStillSafe(uint256 currentHealthFactor, uint256 triggerHealthFactor);
    error FlashAlreadyActive();
    error InvalidFlashCallback();
    error InvalidOraclePrice();
    error DebtRemains(uint256 remainingDebt);
    error InsufficientOwnerATokenBalance(uint256 available, uint256 required);
    error InsufficientOwnerATokenAllowance(uint256 allowance, uint256 required);
    error UnexpectedUsdcReceived(uint256 received, uint256 expected);
    error UnexpectedATokenTransferAmount(uint256 received, uint256 expected);
    error UnexpectedWithdrawAmount(uint256 withdrawn, uint256 expected);
    error NativeEthSweepFailed();
    error UpperHealthFactorTooClose(
        uint256 currentHealthFactor,
        uint256 newUpperHealthFactor,
        uint256 minimumUpperHealthFactor
    );
    error HealthFactorInRange(uint256 currentHealthFactor, uint256 lowerTrigger, uint256 upperTrigger);

    event EmergencyRepayStarted(
        address indexed positionOwner,
        uint256 healthFactor,
        uint256 debt,
        uint256 flashWethAmount
    );
    event EmergencyRepayCompleted(
        address indexed positionOwner,
        uint256 usdcRepaid,
        uint256 wethSold,
        uint256 aWethPulled,
        uint256 flashPremium,
        uint256 remainingOwnerAWeth,
        uint256 remainingOwnerDebt
    );
    event Swept(address indexed token, address indexed to, uint256 amount);
    event UpperHealthFactorUpdated(uint256 oldUpperHealthFactor, uint256 newUpperHealthFactor);

    modifier onlyPositionOwner() {
        if (msg.sender != POSITION_OWNER) revert Unauthorized();
        _;
    }

    modifier onlyKeeperOrPositionOwner() {
        if (msg.sender != KEEPER && msg.sender != POSITION_OWNER) revert Unauthorized();
        _;
    }

    /// @notice Deploys an immutable emergency repayer and validates all configured Aave/Uniswap bindings.
    /// @dev Reverts on wrong actors, missing code, wrong decimals, wrong reserve tokens, or wrong pool/fee.
    constructor(Config memory c) {
        if (
            c.aavePool == address(0) || c.swapRouter == address(0)
                || c.weth == address(0) || c.usdc == address(0) || c.aWeth == address(0)
                || c.variableDebtUsdc == address(0) || c.positionOwner == address(0) || c.keeper == address(0)
        ) revert ZeroAddress();
        if (c.positionOwner == c.keeper) revert InvalidActors();
        if (c.aavePool.code.length == 0) revert InvalidAavePool();
        if (
            c.weth.code.length == 0 || c.usdc.code.length == 0 || c.aWeth.code.length == 0
                || c.variableDebtUsdc.code.length == 0
        ) revert InvalidToken();
        if (c.uniswapPool == address(0) || c.uniswapPool.code.length == 0) revert InvalidUniswapPool();
        if (c.swapRouter.code.length == 0) revert InvalidSwapRouter();
        if (c.maxSlippageBps == 0 || c.maxSlippageBps > MAX_ALLOWED_SLIPPAGE_BPS) revert InvalidBps();
        if (c.usdcRepayBuffer == 0 || c.usdcRepayBuffer > MAX_USDC_REPAY_BUFFER) {
            revert InvalidRepayBuffer();
        }
        if (c.triggerHealthFactor <= 1e18) revert InvalidHealthFactor();
        if (
            IERC20Metadata(c.weth).decimals() != 18 || IERC20Metadata(c.aWeth).decimals() != 18
                || IERC20Metadata(c.usdc).decimals() != 6
                || IERC20Metadata(c.variableDebtUsdc).decimals() != 6
        ) revert InvalidTokenDecimals();
        _validateAToken(c.aWeth, c.weth, c.aavePool);
        _validateDebtToken(c.variableDebtUsdc, c.usdc, c.aavePool);
        _validateReserveBinding(c.aavePool, c.weth, c.aWeth, c.usdc, c.variableDebtUsdc);

        address addressesProvider = IAavePool(c.aavePool).ADDRESSES_PROVIDER();
        if (addressesProvider == address(0) || addressesProvider.code.length == 0) {
            revert InvalidAddressesProvider();
        }
        address currentOracle = IPoolAddressesProvider(addressesProvider).getPriceOracle();
        if (currentOracle == address(0) || currentOracle.code.length == 0) revert InvalidCurrentOracle();

        AAVE_POOL = IAavePool(c.aavePool);
        ADDRESSES_PROVIDER = IPoolAddressesProvider(addressesProvider);
        SWAP_ROUTER = IUniswapV3SwapRouter(c.swapRouter);
        WETH = IERC20(c.weth);
        USDC = IERC20(c.usdc);
        A_WETH = IERC20(c.aWeth);
        VARIABLE_DEBT_USDC = IERC20(c.variableDebtUsdc);
        POSITION_OWNER = c.positionOwner;
        KEEPER = c.keeper;
        UNISWAP_POOL = c.uniswapPool;
        UNISWAP_POOL_FEE = c.uniswapPoolFee;
        MAX_SLIPPAGE_BPS = c.maxSlippageBps;
        TRIGGER_HEALTH_FACTOR = c.triggerHealthFactor;
        USDC_REPAY_BUFFER = c.usdcRepayBuffer;

        address factory = IUniswapV3SwapRouter(c.swapRouter).factory();
        if (factory == address(0) || factory.code.length == 0) revert InvalidUniswapPoolFactory();

        address derivedPool = IUniswapV3Factory(factory).getPool(c.weth, c.usdc, c.uniswapPoolFee);
        if (derivedPool != c.uniswapPool) revert UniswapPoolMismatch();

        IUniswapV3Pool explicitPool = IUniswapV3Pool(c.uniswapPool);
        if (explicitPool.factory() != factory) revert InvalidUniswapPoolFactory();
        if (explicitPool.fee() != c.uniswapPoolFee) revert InvalidUniswapPoolFee();

        address token0 = explicitPool.token0();
        address token1 = explicitPool.token1();
        bool validTokens =
            (token0 == c.weth && token1 == c.usdc) || (token0 == c.usdc && token1 == c.weth);
        if (!validTokens) revert InvalidUniswapPoolTokens();
    }

    /// @notice Checks that an Aave aToken matches the expected underlying asset and pool.
    /// @dev Used at deployment to prevent configuring a fake or wrong-market aWETH.
    function _validateAToken(address token, address expectedUnderlying, address expectedPool) private view {
        try IAaveReserveToken(token).UNDERLYING_ASSET_ADDRESS() returns (address underlying) {
            if (underlying != expectedUnderlying) revert InvalidAToken();
        } catch {
            revert InvalidAToken();
        }

        try IAaveReserveToken(token).POOL() returns (address pool) {
            if (pool != expectedPool) revert InvalidAToken();
        } catch {
            revert InvalidAToken();
        }
    }

    /// @notice Checks that an Aave debt token matches the expected underlying asset and pool.
    /// @dev Used at deployment to prevent repaying the wrong USDC debt market.
    function _validateDebtToken(address token, address expectedUnderlying, address expectedPool) private view {
        try IAaveReserveToken(token).UNDERLYING_ASSET_ADDRESS() returns (address underlying) {
            if (underlying != expectedUnderlying) revert InvalidDebtToken();
        } catch {
            revert InvalidDebtToken();
        }

        try IAaveReserveToken(token).POOL() returns (address pool) {
            if (pool != expectedPool) revert InvalidDebtToken();
        } catch {
            revert InvalidDebtToken();
        }
    }

    /// @notice Checks that the Aave pool reserve registry points to the configured aToken and debt token.
    /// @dev This ties WETH to aWETH and USDC to variable-debt USDC through Aave's own reserve data.
    function _validateReserveBinding(
        address pool,
        address weth,
        address aWeth,
        address usdc,
        address variableDebtUsdc
    ) private view {
        try IAavePool(pool).getReserveData(weth) returns (IAavePool.ReserveDataLegacy memory wethReserve) {
            if (wethReserve.aTokenAddress != aWeth) revert InvalidAToken();
        } catch {
            revert InvalidAToken();
        }

        try IAavePool(pool).getReserveData(usdc) returns (IAavePool.ReserveDataLegacy memory usdcReserve) {
            if (usdcReserve.variableDebtTokenAddress != variableDebtUsdc) revert InvalidDebtToken();
        } catch {
            revert InvalidDebtToken();
        }
    }

    // -------------------------------------------------------------------------
    // Emergency path
    // -------------------------------------------------------------------------

    /// @notice Executes full repayment when owner HF is below the lower trigger or above the active upper trigger.
    /// @dev Callable only by `KEEPER` or `POSITION_OWNER`; callers cannot choose tokens, routes, or amounts.
    function checkAndRepay() external onlyKeeperOrPositionOwner {
        uint256 hf = healthFactor();
        if (!_shouldRepayAtHealthFactor(hf)) {
            if (upperHealthFactor == 0) revert HealthFactorStillSafe(hf, TRIGGER_HEALTH_FACTOR);
            revert HealthFactorInRange(hf, TRIGGER_HEALTH_FACTOR, upperHealthFactor);
        }
        _repayAllDebtWithCollateral(hf);
    }

    /// @notice Sets or disables the upper health-factor trigger used by `checkAndRepay()`.
    /// @dev A nonzero upper trigger must be at least 5% above the current live Aave HF.
    function setUpperHealthFactor(uint256 newUpperHealthFactor) external onlyKeeperOrPositionOwner {
        if (newUpperHealthFactor != 0) {
            uint256 currentHf = healthFactor();
            uint256 minimumByDistance = Math.mulDiv(
                currentHf,
                BPS + MIN_UPPER_HEALTH_FACTOR_DISTANCE_BPS,
                BPS,
                Math.Rounding.Ceil
            );
            uint256 minimumUpperHealthFactor = Math.max(minimumByDistance, TRIGGER_HEALTH_FACTOR + 1);
            if (newUpperHealthFactor < minimumUpperHealthFactor) {
                revert UpperHealthFactorTooClose(currentHf, newUpperHealthFactor, minimumUpperHealthFactor);
            }
        }

        uint256 oldUpperHealthFactor = upperHealthFactor;
        upperHealthFactor = newUpperHealthFactor;
        emit UpperHealthFactorUpdated(oldUpperHealthFactor, newUpperHealthFactor);
    }

    /// @notice Lets `POSITION_OWNER` execute the same full repayment even before the trigger is reached.
    /// @dev This is the manual override path; no keeper or HF trigger is required.
    function forceRepayAll() external onlyPositionOwner {
        _repayAllDebtWithCollateral(healthFactor());
    }

    /// @notice Starts the flash-loan repayment flow after prechecking debt, aWETH balance, and allowance.
    /// @dev Uses worst-case collateral requirements before the flash loan, then the callback pulls actual collateral.
    function _repayAllDebtWithCollateral(uint256 hf) internal {
        if (flashActive) revert FlashAlreadyActive();

        uint256 debt = VARIABLE_DEBT_USDC.balanceOf(POSITION_OWNER);
        if (debt == 0) revert NoDebt();

        uint256 usdcTarget = debt + USDC_REPAY_BUFFER;
        uint256 flashWethAmount = maxWethForUsdc(usdcTarget);
        uint256 worstCaseCollateralNeeded = worstCaseCollateralForFlash(flashWethAmount);

        uint256 ownerAWethBalance = A_WETH.balanceOf(POSITION_OWNER);
        if (ownerAWethBalance < worstCaseCollateralNeeded) {
            revert InsufficientOwnerATokenBalance(ownerAWethBalance, worstCaseCollateralNeeded);
        }

        uint256 ownerAllowance = A_WETH.allowance(POSITION_OWNER, address(this));
        if (ownerAllowance < worstCaseCollateralNeeded) {
            revert InsufficientOwnerATokenAllowance(ownerAllowance, worstCaseCollateralNeeded);
        }

        flashActive = true;
        emit EmergencyRepayStarted(POSITION_OWNER, hf, debt, flashWethAmount);

        AAVE_POOL.flashLoanSimple(
            address(this),
            address(WETH),
            flashWethAmount,
            abi.encode(usdcTarget),
            0
        );

        flashActive = false;
        WETH.forceApprove(address(AAVE_POOL), 0);
        _sweepLooseBalances();
    }

    /// @notice Returns whether the given HF should trigger a full repayment through `checkAndRepay()`.
    /// @dev The lower trigger is always active; the upper trigger is active only when nonzero.
    function _shouldRepayAtHealthFactor(uint256 hf) private view returns (bool) {
        return hf <= TRIGGER_HEALTH_FACTOR || (upperHealthFactor != 0 && hf >= upperHealthFactor);
    }

    /// @notice Aave V3 `flashLoanSimple` callback that swaps WETH, repays USDC debt, and returns flash liquidity.
    /// @dev Accepts callbacks only from the configured Aave pool, for WETH, initiated by this contract.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (
            msg.sender != address(AAVE_POOL) || initiator != address(this) || asset != address(WETH)
                || !flashActive
        ) revert InvalidFlashCallback();

        uint256 usdcTarget = abi.decode(params, (uint256));

        uint256 wethSpent = _swapWethForExactUsdc(amount, usdcTarget);
        (uint256 repaid, uint256 remainingDebt) = _repayOwnerDebt(usdcTarget);
        if (remainingDebt != 0) revert DebtRemains(remainingDebt);

        uint256 collateralToWithdraw = wethSpent + premium;
        uint256 aWethPulled = _pullAndWithdrawOwnerCollateral(collateralToWithdraw);

        WETH.forceApprove(address(AAVE_POOL), amount + premium);

        emit EmergencyRepayCompleted(
            POSITION_OWNER,
            repaid,
            wethSpent,
            aWethPulled,
            premium,
            A_WETH.balanceOf(POSITION_OWNER),
            remainingDebt
        );
        return true;
    }

    /// @notice Swaps flash-borrowed WETH for an exact amount of USDC through the fixed Uniswap V3 pool.
    /// @dev Verifies the actual USDC balance increase so execution does not rely only on router return data.
    function _swapWethForExactUsdc(uint256 amount, uint256 usdcTarget) private returns (uint256 wethSpent) {
        uint256 usdcBefore = USDC.balanceOf(address(this));
        WETH.forceApprove(address(SWAP_ROUTER), amount);
        wethSpent = SWAP_ROUTER.exactOutputSingle(
            IUniswapV3SwapRouter.ExactOutputSingleParams({
                tokenIn: address(WETH),
                tokenOut: address(USDC),
                fee: UNISWAP_POOL_FEE,
                recipient: address(this),
                deadline: block.timestamp,
                amountOut: usdcTarget,
                amountInMaximum: amount,
                sqrtPriceLimitX96: 0
            })
        );
        WETH.forceApprove(address(SWAP_ROUTER), 0);

        uint256 usdcReceived = USDC.balanceOf(address(this)) - usdcBefore;
        if (usdcReceived < usdcTarget) {
            revert UnexpectedUsdcReceived(usdcReceived, usdcTarget);
        }
    }

    /// @notice Repays the owner's variable USDC debt on Aave using the USDC held by this contract.
    /// @dev Approves Aave only for the exact target amount and clears the approval after repayment.
    function _repayOwnerDebt(uint256 usdcTarget) private returns (uint256 repaid, uint256 remainingDebt) {
        USDC.forceApprove(address(AAVE_POOL), usdcTarget);
        repaid = AAVE_POOL.repay(
            address(USDC),
            usdcTarget,
            VARIABLE_RATE_MODE,
            POSITION_OWNER
        );
        USDC.forceApprove(address(AAVE_POOL), 0);
        remainingDebt = VARIABLE_DEBT_USDC.balanceOf(POSITION_OWNER);
    }

    /// @notice Pulls the required owner aWETH and withdraws it from Aave into WETH for flash-loan repayment.
    /// @dev Rechecks balance/allowance immediately before transfer and validates received/withdrawn amounts.
    function _pullAndWithdrawOwnerCollateral(uint256 collateralToWithdraw) private returns (uint256 aWethReceived) {
        uint256 currentOwnerAWethBalance = A_WETH.balanceOf(POSITION_OWNER);
        if (currentOwnerAWethBalance < collateralToWithdraw) {
            revert InsufficientOwnerATokenBalance(currentOwnerAWethBalance, collateralToWithdraw);
        }

        uint256 currentOwnerAllowance = A_WETH.allowance(POSITION_OWNER, address(this));
        if (currentOwnerAllowance < collateralToWithdraw) {
            revert InsufficientOwnerATokenAllowance(currentOwnerAllowance, collateralToWithdraw);
        }

        uint256 aWethBefore = A_WETH.balanceOf(address(this));
        A_WETH.safeTransferFrom(POSITION_OWNER, address(this), collateralToWithdraw);
        aWethReceived = A_WETH.balanceOf(address(this)) - aWethBefore;
        if (aWethReceived < collateralToWithdraw) {
            revert UnexpectedATokenTransferAmount(aWethReceived, collateralToWithdraw);
        }

        uint256 withdrawn = AAVE_POOL.withdraw(address(WETH), aWethReceived, address(this));
        if (withdrawn < aWethReceived) {
            revert UnexpectedWithdrawAmount(withdrawn, aWethReceived);
        }
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /// @notice Returns the current Aave health factor for `POSITION_OWNER`.
    /// @dev Reads account-level data directly from the immutable Aave pool.
    function healthFactor() public view returns (uint256 hf) {
        (, , , , , hf) = AAVE_POOL.getUserAccountData(POSITION_OWNER);
    }

    /// @notice Returns the owner's current variable native-USDC debt-token balance.
    /// @dev A zero value means there is no USDC debt for this contract to repay.
    function currentDebtUsdc() public view returns (uint256) {
        return VARIABLE_DEBT_USDC.balanceOf(POSITION_OWNER);
    }

    /// @notice Returns oracle-fair WETH needed to buy `usdcAmount` USDC, with no slippage padding.
    /// @dev Resolves Aave's current oracle at call time and rounds up to avoid underestimating WETH.
    function oracleWethForUsdc(uint256 usdcAmount) public view returns (uint256) {
        address currentOracle = ADDRESSES_PROVIDER.getPriceOracle();
        if (currentOracle == address(0) || currentOracle.code.length == 0) revert InvalidCurrentOracle();

        uint256 wethPrice = IAaveOracle(currentOracle).getAssetPrice(address(WETH));
        uint256 usdcPrice = IAaveOracle(currentOracle).getAssetPrice(address(USDC));
        if (wethPrice == 0 || usdcPrice == 0) revert InvalidOraclePrice();

        return Math.mulDiv(
            usdcAmount,
            usdcPrice * WETH_SCALE,
            wethPrice * USDC_SCALE,
            Math.Rounding.Ceil
        );
    }

    /// @notice Returns the maximum WETH the emergency swap may spend for a target USDC amount.
    /// @dev Adds immutable slippage padding to the Aave-oracle fair value and rounds up.
    function maxWethForUsdc(uint256 usdcAmount) public view returns (uint256) {
        return Math.mulDiv(
            oracleWethForUsdc(usdcAmount),
            BPS + MAX_SLIPPAGE_BPS,
            BPS,
            Math.Rounding.Ceil
        );
    }

    /// @notice Returns the oracle-expected aWETH collateral needed for a USDC target plus flash premium.
    /// @dev This is informational; execution prechecks the stricter worst-case collateral amount.
    function expectedCollateralForUsdc(uint256 usdcAmount, uint256 flashWethAmount) public view returns (uint256) {
        return oracleWethForUsdc(usdcAmount) + flashPremiumFor(flashWethAmount);
    }

    /// @notice Returns worst-case aWETH collateral needed if the swap spends the full flash amount.
    /// @dev Used for prechecking owner balance and allowance before starting the flash loan.
    function worstCaseCollateralForFlash(uint256 flashWethAmount) public view returns (uint256) {
        return flashWethAmount + flashPremiumFor(flashWethAmount);
    }

    /// @notice Returns Aave flash-loan premium owed for a WETH flash-loan amount.
    /// @dev Reads Aave's current premium and rounds up.
    function flashPremiumFor(uint256 flashWethAmount) public view returns (uint256) {
        uint256 premiumBps = uint256(AAVE_POOL.FLASHLOAN_PREMIUM_TOTAL());
        return Math.mulDiv(
            flashWethAmount,
            premiumBps,
            BPS,
            Math.Rounding.Ceil
        );
    }

    /// @notice Returns all key values needed to know whether the emergency path is currently executable.
    /// @dev Frontends and keeper scripts use this to avoid sending transactions that would revert.
    function previewEmergency()
        external
        view
        returns (
            uint256 hf,
            uint256 debtUsdc,
            uint256 usdcTarget,
            uint256 maxFlashWeth,
            uint256 expectedCollateralNeeded,
            uint256 worstCaseCollateralNeeded,
            uint256 ownerAWethBalance,
            uint256 ownerAWethAllowance,
            bool triggerReached,
            bool sufficientlyFunded,
            bool sufficientlyApproved,
            bool readyToExecute
        )
    {
        hf = healthFactor();
        debtUsdc = currentDebtUsdc();
        if (debtUsdc != 0) {
            usdcTarget = debtUsdc + USDC_REPAY_BUFFER;
            maxFlashWeth = maxWethForUsdc(usdcTarget);
            expectedCollateralNeeded = expectedCollateralForUsdc(usdcTarget, maxFlashWeth);
            worstCaseCollateralNeeded = worstCaseCollateralForFlash(maxFlashWeth);
        }
        ownerAWethBalance = A_WETH.balanceOf(POSITION_OWNER);
        ownerAWethAllowance = A_WETH.allowance(POSITION_OWNER, address(this));
        triggerReached = debtUsdc != 0 && _shouldRepayAtHealthFactor(hf);
        sufficientlyFunded = ownerAWethBalance >= worstCaseCollateralNeeded;
        sufficientlyApproved = ownerAWethAllowance >= worstCaseCollateralNeeded;
        readyToExecute = triggerReached && sufficientlyFunded && sufficientlyApproved;
    }

    // -------------------------------------------------------------------------
    // Fixed-destination dust recovery
    // -------------------------------------------------------------------------

    /// @notice Sends any loose native USDC held by this contract to `POSITION_OWNER`.
    /// @dev Fixed-destination recovery only; cannot send to arbitrary recipients.
    function sweepUsdc() external onlyPositionOwner {
        uint256 amount = USDC.balanceOf(address(this));
        if (amount != 0) {
            USDC.safeTransfer(POSITION_OWNER, amount);
            emit Swept(address(USDC), POSITION_OWNER, amount);
        }
    }

    /// @notice Sends any loose WETH held by this contract to `POSITION_OWNER`.
    /// @dev Fixed-destination recovery only; cannot send to arbitrary recipients.
    function sweepWeth() external onlyPositionOwner {
        uint256 amount = WETH.balanceOf(address(this));
        if (amount != 0) {
            WETH.safeTransfer(POSITION_OWNER, amount);
            emit Swept(address(WETH), POSITION_OWNER, amount);
        }
    }

    /// @notice Sends any loose native ETH held by this contract to `POSITION_OWNER`.
    /// @dev Covers forced or accidental ETH balances; reverts if the ETH transfer fails.
    function sweepEth() external onlyPositionOwner {
        uint256 amount = address(this).balance;
        if (amount != 0) {
            (bool success,) = payable(POSITION_OWNER).call{value: amount}("");
            if (!success) revert NativeEthSweepFailed();
            emit Swept(address(0), POSITION_OWNER, amount);
        }
    }

    /// @notice Sends leftover WETH and USDC dust to `POSITION_OWNER` after a completed emergency repayment.
    /// @dev Does not sweep native ETH automatically because the emergency path does not use native ETH.
    function _sweepLooseBalances() private {
        uint256 usdcDust = USDC.balanceOf(address(this));
        if (usdcDust != 0) {
            USDC.safeTransfer(POSITION_OWNER, usdcDust);
            emit Swept(address(USDC), POSITION_OWNER, usdcDust);
        }

        uint256 wethDust = WETH.balanceOf(address(this));
        if (wethDust != 0) {
            WETH.safeTransfer(POSITION_OWNER, wethDust);
            emit Swept(address(WETH), POSITION_OWNER, wethDust);
        }
    }
}
