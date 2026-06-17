// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IAavePool {
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);

    function repay(
        address asset,
        uint256 amount,
        uint256 interestRateMode,
        address onBehalfOf
    ) external returns (uint256);

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);

    function ADDRESSES_PROVIDER() external view returns (address);

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

    function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}

interface IAaveOracle {
    function getAssetPrice(address asset) external view returns (uint256);
}

interface IPoolAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface IAaveReserveToken {
    function UNDERLYING_ASSET_ADDRESS() external view returns (address);

    function POOL() external view returns (address);
}

interface IUniswapV3Factory {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

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

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);

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

    modifier onlyPositionOwner() {
        if (msg.sender != POSITION_OWNER) revert Unauthorized();
        _;
    }

    modifier onlyKeeperOrPositionOwner() {
        if (msg.sender != KEEPER && msg.sender != POSITION_OWNER) revert Unauthorized();
        _;
    }

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

    /// @notice Called by the disposable keeper or position owner. Reverts unless owner HF is at/below trigger.
    function checkAndRepay() external onlyKeeperOrPositionOwner {
        uint256 hf = healthFactor();
        if (hf > TRIGGER_HEALTH_FACTOR) {
            revert HealthFactorStillSafe(hf, TRIGGER_HEALTH_FACTOR);
        }
        _repayAllDebtWithCollateral(hf);
    }

    /// @notice Allows POSITION_OWNER to execute the same emergency close before the trigger is reached.
    function forceRepayAll() external onlyPositionOwner {
        _repayAllDebtWithCollateral(healthFactor());
    }

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

    /// @notice Aave V3 flashLoanSimple callback.
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

    function healthFactor() public view returns (uint256 hf) {
        (, , , , , hf) = AAVE_POOL.getUserAccountData(POSITION_OWNER);
    }

    function currentDebtUsdc() public view returns (uint256) {
        return VARIABLE_DEBT_USDC.balanceOf(POSITION_OWNER);
    }

    /// @notice Oracle-fair WETH (no slippage padding) required to buy `usdcAmount` USDC, rounded up.
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

    /// @notice Maximum WETH the emergency swap may spend, based on Aave's oracle plus immutable slippage.
    function maxWethForUsdc(uint256 usdcAmount) public view returns (uint256) {
        return Math.mulDiv(
            oracleWethForUsdc(usdcAmount),
            BPS + MAX_SLIPPAGE_BPS,
            BPS,
            Math.Rounding.Ceil
        );
    }

    function expectedCollateralForUsdc(uint256 usdcAmount, uint256 flashWethAmount) public view returns (uint256) {
        return oracleWethForUsdc(usdcAmount) + flashPremiumFor(flashWethAmount);
    }

    function worstCaseCollateralForFlash(uint256 flashWethAmount) public view returns (uint256) {
        return flashWethAmount + flashPremiumFor(flashWethAmount);
    }

    function flashPremiumFor(uint256 flashWethAmount) public view returns (uint256) {
        uint256 premiumBps = uint256(AAVE_POOL.FLASHLOAN_PREMIUM_TOTAL());
        return Math.mulDiv(
            flashWethAmount,
            premiumBps,
            BPS,
            Math.Rounding.Ceil
        );
    }

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
        triggerReached = debtUsdc != 0 && hf <= TRIGGER_HEALTH_FACTOR;
        sufficientlyFunded = ownerAWethBalance >= worstCaseCollateralNeeded;
        sufficientlyApproved = ownerAWethAllowance >= worstCaseCollateralNeeded;
        readyToExecute = triggerReached && sufficientlyFunded && sufficientlyApproved;
    }

    // -------------------------------------------------------------------------
    // Fixed-destination dust recovery
    // -------------------------------------------------------------------------

    function sweepUsdc() external onlyPositionOwner {
        uint256 amount = USDC.balanceOf(address(this));
        if (amount != 0) {
            USDC.safeTransfer(POSITION_OWNER, amount);
            emit Swept(address(USDC), POSITION_OWNER, amount);
        }
    }

    function sweepWeth() external onlyPositionOwner {
        uint256 amount = WETH.balanceOf(address(this));
        if (amount != 0) {
            WETH.safeTransfer(POSITION_OWNER, amount);
            emit Swept(address(WETH), POSITION_OWNER, amount);
        }
    }

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
