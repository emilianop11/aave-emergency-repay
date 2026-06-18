// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IFlashReceiverLike {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

interface IRepayerSweepLike {
    function sweepEth() external;

    function sweepUsdc() external;

    function sweepWeth() external;
}

contract MockERC20 is ERC20 {
    uint8 private immutable customDecimals;
    bool public failTransferFrom;
    uint256 public transferFromShortfall;
    uint256 public transferFromBonus;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        customDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return customDecimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setFailTransferFrom(bool value) external {
        failTransferFrom = value;
    }

    function setTransferFromShortfall(uint256 amount) external {
        transferFromShortfall = amount;
    }

    function setTransferFromBonus(uint256 amount) external {
        transferFromBonus = amount;
    }

    function forceApproveFor(address owner, address spender, uint256 value) external {
        _approve(owner, spender, value);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        require(!failTransferFrom, "TRANSFER_FROM_FAILED");
        if (transferFromShortfall != 0) {
            require(transferFromShortfall < value, "BAD_TRANSFER_FROM_SHORTFALL");
            _spendAllowance(from, msg.sender, value);
            _transfer(from, to, value - transferFromShortfall);
            return true;
        }
        if (transferFromBonus != 0) {
            _spendAllowance(from, msg.sender, value);
            _transfer(from, to, value + transferFromBonus);
            return true;
        }
        return super.transferFrom(from, to, value);
    }
}

contract MockAaveToken is MockERC20 {
    address public UNDERLYING_ASSET_ADDRESS;
    address public POOL;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address underlying_,
        address pool_
    ) MockERC20(name_, symbol_, decimals_) {
        UNDERLYING_ASSET_ADDRESS = underlying_;
        POOL = pool_;
    }

    function setAaveBinding(address underlying_, address pool_) external {
        UNDERLYING_ASSET_ADDRESS = underlying_;
        POOL = pool_;
    }
}

contract MockOracle {
    mapping(address => uint256) public price;

    function setPrice(address asset, uint256 newPrice) external {
        price[asset] = newPrice;
    }

    function getAssetPrice(address asset) external view returns (uint256) {
        return price[asset];
    }
}

contract MockAddressesProvider {
    address public priceOracle;

    constructor(address priceOracle_) {
        priceOracle = priceOracle_;
    }

    function setPriceOracle(address priceOracle_) external {
        priceOracle = priceOracle_;
    }

    function getPriceOracle() external view returns (address) {
        return priceOracle;
    }
}

contract MockUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    address public immutable factory;

    constructor(address token0_, address token1_, uint24 fee_, address factory_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        factory = factory_;
    }
}

contract MockFactory {
    mapping(bytes32 => address) public pools;

    function setPool(address tokenA, address tokenB, uint24 fee, address newPool) external {
        pools[_key(tokenA, tokenB, fee)] = newPool;
    }

    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address) {
        return pools[_key(tokenA, tokenB, fee)];
    }

    function _key(address tokenA, address tokenB, uint24 fee) private pure returns (bytes32) {
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        return keccak256(abi.encode(token0, token1, fee));
    }
}

contract MockRouter {
    using Math for uint256;

    address public immutable factory;
    IERC20 public immutable weth;
    IERC20 public immutable usdc;
    uint24 public immutable expectedFee;

    // USDC base units received per 1 WETH. 2_000e6 means 1 WETH = 2,000 USDC.
    uint256 public usdcPerWeth = 2_000e6;
    bool public forceRevert;
    uint24 public lastFee;
    uint256 public lastExactOutputAmountOut;
    uint256 public lastExactOutputAmountInMaximum;
    address public reentryTarget;
    uint8 public reentryMode;
    bool public lastReentrySuccess;
    uint256 public underreportWeth;
    uint256 public usdcShortfall;

    constructor(address factory_, address weth_, address usdc_, uint24 expectedFee_) {
        factory = factory_;
        weth = IERC20(weth_);
        usdc = IERC20(usdc_);
        expectedFee = expectedFee_;
    }

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

    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function setUsdcPerWeth(uint256 newRate) external {
        usdcPerWeth = newRate;
    }

    function setForceRevert(bool value) external {
        forceRevert = value;
    }

    function setReentryAttack(address target, uint8 mode) external {
        reentryTarget = target;
        reentryMode = mode;
        lastReentrySuccess = false;
    }

    function setUnderreportWeth(uint256 amount) external {
        underreportWeth = amount;
    }

    function setUsdcShortfall(uint256 amount) external {
        usdcShortfall = amount;
    }

    function exactOutputSingle(ExactOutputSingleParams calldata p) external returns (uint256 amountIn) {
        require(!forceRevert, "FORCED_REVERT");
        require(p.tokenIn == address(weth) && p.tokenOut == address(usdc), "PAIR");
        require(p.fee == expectedFee, "FEE");
        require(p.recipient == msg.sender, "RECIPIENT");
        require(p.deadline >= block.timestamp, "DEADLINE");
        lastFee = p.fee;
        lastExactOutputAmountOut = p.amountOut;
        lastExactOutputAmountInMaximum = p.amountInMaximum;

        amountIn = Math.mulDiv(p.amountOut, 1e18, usdcPerWeth, Math.Rounding.Ceil);
        require(amountIn <= p.amountInMaximum, "TOO_MUCH_IN");

        _tryReentry();

        weth.transferFrom(msg.sender, address(this), amountIn);
        usdc.transfer(p.recipient, p.amountOut - usdcShortfall);

        if (underreportWeth != 0) {
            require(underreportWeth < amountIn, "BAD_UNDERREPORT");
            amountIn -= underreportWeth;
        }
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external returns (uint256 amountOut) {
        require(!forceRevert, "FORCED_REVERT");
        require(p.tokenIn == address(usdc) && p.tokenOut == address(weth), "PAIR");
        require(p.fee == expectedFee, "FEE");
        require(p.recipient == msg.sender, "RECIPIENT");
        require(p.deadline >= block.timestamp, "DEADLINE");
        lastFee = p.fee;

        amountOut = Math.mulDiv(p.amountIn, 1e18, usdcPerWeth);
        require(amountOut >= p.amountOutMinimum, "TOO_LITTLE_OUT");

        _tryReentry();

        usdc.transferFrom(msg.sender, address(this), p.amountIn);
        weth.transfer(p.recipient, amountOut);
    }

    function _tryReentry() private {
        if (reentryMode == 0) return;

        bytes memory data;
        if (reentryMode == 1) data = abi.encodeWithSignature("sweepWeth()");
        else if (reentryMode == 2) data = abi.encodeWithSignature("sweepUsdc()");
        else if (reentryMode == 3) data = abi.encodeWithSignature("forceRepayAll()");
        else if (reentryMode == 4) data = abi.encodeWithSignature("checkAndRepay()");
        else if (reentryMode == 5) {
            data = abi.encodeWithSignature(
                "executeOperation(address,uint256,uint256,address,bytes)",
                address(weth),
                1,
                0,
                reentryTarget,
                ""
            );
        } else if (reentryMode == 6) {
            data = abi.encodeWithSignature("deleverWithCollateral(uint256)", 1);
        } else if (reentryMode == 7) {
            data = abi.encodeWithSignature("sweepEth()");
        } else if (reentryMode == 8) {
            data = abi.encodeWithSignature("setUpperHealthFactor(uint256)", 1);
        } else if (reentryMode == 9) {
            data = abi.encodeWithSignature("setUpperHealthFactor(uint256)", 3e18);
        }
        (lastReentrySuccess,) = reentryTarget.call(data);
    }
}

contract RejectingEthOwner {
    function callSweepEth(address target) external {
        IRepayerSweepLike(target).sweepEth();
    }

    receive() external payable {
        revert("REJECT_ETH");
    }
}

contract ReenteringEthOwner {
    address public repayer;
    bool public reentered;

    function callSweepEth(address target) external {
        repayer = target;
        IRepayerSweepLike(target).sweepEth();
    }

    receive() external payable {
        if (reentered) return;
        reentered = true;
        IRepayerSweepLike(repayer).sweepUsdc();
        IRepayerSweepLike(repayer).sweepWeth();
    }
}

contract MockAavePool {
    IERC20 public immutable weth;
    IERC20 public immutable usdc;
    MockERC20 public immutable aWeth;
    MockERC20 public immutable variableDebtUsdc;
    address public ADDRESSES_PROVIDER;

    uint128 public FLASHLOAN_PREMIUM_TOTAL = 5; // 0.05%
    uint256 public healthFactor = 2e18;
    uint256 public repayDustToLeave;
    uint256 public debtIncreaseBeforeRepay;
    uint256 public aTokenBurnOnRepay;
    bool public overrideATokenAllowanceOnRepay;
    uint256 public aTokenAllowanceOnRepay;
    mapping(address => uint256) public userHealthFactor;
    address public lastRepayOnBehalfOf;
    uint256 public lastRepayAmount;
    address public lastWithdrawCaller;
    uint256 public lastWithdrawAmount;
    address public lastFlashAsset;
    uint256 public lastFlashAmount;
    bool public repayCalled;
    bool public withdrawBeforeRepay;
    bool public forceWithdrawRevert;
    uint256 public withdrawShortfall;
    uint256 public withdrawBonus;
    bool public callbackWrongAsset;
    bool public callbackWrongInitiator;
    bool public callbackMalformedParams;
    bool public useCallbackAmountOverride;
    uint256 public callbackAmountOverride;

    constructor(address weth_, address usdc_, address aWeth_, address debt_, address addressesProvider_) {
        weth = IERC20(weth_);
        usdc = IERC20(usdc_);
        aWeth = MockERC20(aWeth_);
        variableDebtUsdc = MockERC20(debt_);
        ADDRESSES_PROVIDER = addressesProvider_;
    }

    function setHealthFactor(uint256 hf) external {
        healthFactor = hf;
    }

    function setUserHealthFactor(address user, uint256 hf) external {
        userHealthFactor[user] = hf;
    }

    function setFlashLoanPremiumTotal(uint128 premiumBps) external {
        FLASHLOAN_PREMIUM_TOTAL = premiumBps;
    }

    function setRepayDustToLeave(uint256 dust) external {
        repayDustToLeave = dust;
    }

    function setDebtIncreaseBeforeRepay(uint256 amount) external {
        debtIncreaseBeforeRepay = amount;
    }

    function setATokenBurnOnRepay(uint256 amount) external {
        aTokenBurnOnRepay = amount;
    }

    function setATokenAllowanceOnRepay(uint256 amount, bool enabled) external {
        aTokenAllowanceOnRepay = amount;
        overrideATokenAllowanceOnRepay = enabled;
    }

    function setCallbackWrongAsset(bool value) external {
        callbackWrongAsset = value;
    }

    function setCallbackWrongInitiator(bool value) external {
        callbackWrongInitiator = value;
    }

    function setCallbackMalformedParams(bool value) external {
        callbackMalformedParams = value;
    }

    function setCallbackAmountOverride(uint256 amount, bool enabled) external {
        callbackAmountOverride = amount;
        useCallbackAmountOverride = enabled;
    }

    function setForceWithdrawRevert(bool value) external {
        forceWithdrawRevert = value;
    }

    function setWithdrawShortfall(uint256 amount) external {
        withdrawShortfall = amount;
    }

    function setWithdrawBonus(uint256 amount) external {
        withdrawBonus = amount;
    }

    function resetOperationFlags() external {
        lastRepayOnBehalfOf = address(0);
        lastRepayAmount = 0;
        lastWithdrawCaller = address(0);
        lastWithdrawAmount = 0;
        lastFlashAsset = address(0);
        lastFlashAmount = 0;
        repayCalled = false;
        withdrawBeforeRepay = false;
    }

    function supply(address asset, uint256 amount, address onBehalfOf, uint16) external {
        require(asset == address(weth), "ASSET");
        weth.transferFrom(msg.sender, address(this), amount);
        aWeth.mint(onBehalfOf, amount);
    }

    function withdraw(address asset, uint256 amount, address to) external returns (uint256) {
        require(asset == address(weth), "ASSET");
        require(!forceWithdrawRevert, "WITHDRAW_REVERT");
        if (!repayCalled) withdrawBeforeRepay = true;
        uint256 actual = amount == type(uint256).max ? aWeth.balanceOf(msg.sender) : amount;
        if (withdrawShortfall != 0) {
            require(withdrawShortfall < actual, "BAD_WITHDRAW_SHORTFALL");
            actual -= withdrawShortfall;
        }
        if (withdrawBonus != 0) {
            actual += withdrawBonus;
        }
        lastWithdrawCaller = msg.sender;
        lastWithdrawAmount = actual;
        aWeth.burn(msg.sender, amount == type(uint256).max ? actual : amount);
        weth.transfer(to, actual);
        return actual;
    }

    function borrow(address asset, uint256 amount, uint256, uint16, address onBehalfOf) external {
        require(asset == address(usdc), "ASSET");
        variableDebtUsdc.mint(onBehalfOf, amount);
        usdc.transfer(msg.sender, amount);
    }

    function repay(address asset, uint256 amount, uint256, address onBehalfOf) external returns (uint256) {
        require(asset == address(usdc), "ASSET");
        repayCalled = true;
        lastRepayOnBehalfOf = onBehalfOf;
        lastRepayAmount = amount;
        if (debtIncreaseBeforeRepay != 0) {
            variableDebtUsdc.mint(onBehalfOf, debtIncreaseBeforeRepay);
            debtIncreaseBeforeRepay = 0;
        }
        uint256 debt = variableDebtUsdc.balanceOf(onBehalfOf);
        uint256 maxRepayable = debt > repayDustToLeave ? debt - repayDustToLeave : 0;
        uint256 actual = amount == type(uint256).max || amount > maxRepayable ? maxRepayable : amount;
        if (actual != 0) {
            usdc.transferFrom(msg.sender, address(this), actual);
            variableDebtUsdc.burn(onBehalfOf, actual);
        }
        if (aTokenBurnOnRepay != 0) {
            aWeth.burn(onBehalfOf, aTokenBurnOnRepay);
            aTokenBurnOnRepay = 0;
        }
        if (overrideATokenAllowanceOnRepay) {
            aWeth.forceApproveFor(onBehalfOf, msg.sender, aTokenAllowanceOnRepay);
            overrideATokenAllowanceOnRepay = false;
        }
        return actual;
    }

    function flashLoanSimple(
        address receiver,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        require(asset == address(weth), "ASSET");
        lastFlashAsset = asset;
        lastFlashAmount = amount;
        uint256 premium = Math.mulDiv(amount, FLASHLOAN_PREMIUM_TOTAL, 10_000, Math.Rounding.Ceil);
        address callbackAsset = callbackWrongAsset ? address(usdc) : asset;
        address callbackInitiator = callbackWrongInitiator ? address(0xBEEF) : msg.sender;
        uint256 callbackAmount = useCallbackAmountOverride ? callbackAmountOverride : amount;
        bytes memory callbackParams = params;
        if (callbackMalformedParams) callbackParams = abi.encodePacked(uint8(0xde));
        weth.transfer(receiver, amount);
        require(
            IFlashReceiverLike(receiver).executeOperation(
                callbackAsset,
                callbackAmount,
                premium,
                callbackInitiator,
                callbackParams
            ),
            "CALLBACK"
        );
        weth.transferFrom(receiver, address(this), amount + premium);
    }

    function getUserAccountData(address user)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256)
    {
        uint256 hf = userHealthFactor[user] == 0 ? healthFactor : userHealthFactor[user];
        return (0, 0, 0, 0, 0, hf);
    }

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

    // Mirrors Aave V3's reserve registry: each reserve maps to its canonical aToken / variable-debt token.
    function getReserveData(address asset) external view returns (ReserveDataLegacy memory data) {
        if (asset == address(weth)) {
            data.aTokenAddress = address(aWeth);
        } else if (asset == address(usdc)) {
            data.variableDebtTokenAddress = address(variableDebtUsdc);
        }
    }

    function callExecuteOperation(
        address receiver,
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        return IFlashReceiverLike(receiver).executeOperation(asset, amount, premium, initiator, params);
    }
}
