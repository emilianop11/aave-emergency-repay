import "dotenv/config";
import { expect } from "chai";
import { network } from "hardhat";
import { ARBITRUM } from "../../scripts/addresses.js";
import { verifyConfiguredUniswapPool } from "../../scripts/uniswap-pool.js";

const runFork = Boolean(process.env.ARBITRUM_RPC_URL);
const describeFork = runFork ? describe : describe.skip;

describeFork("AaveEmergencyRepayer — Arbitrum fork", function () {
  this.timeout(180_000);

  it("repays a real EOA-owned Aave WETH/USDC position through the real Uniswap pool", async function () {
    const { ethers, networkHelpers } = await network.create({
      network: "hardhatArbitrumFork",
      chainType: "generic",
    });
    const [positionOwner, keeper] = await ethers.getSigners();
    await networkHelpers.setBalance(positionOwner.address, ethers.parseEther("100"));

    const configuredUniswapPool = process.env.UNISWAP_WETH_USDC_POOL;
    if (!configuredUniswapPool) throw new Error("Missing UNISWAP_WETH_USDC_POOL");

    const codeChecks = [
      ARBITRUM.AAVE_POOL,
      ARBITRUM.WETH,
      ARBITRUM.A_WETH,
      ARBITRUM.USDC,
      ARBITRUM.VARIABLE_DEBT_USDC,
      ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      configuredUniswapPool,
    ];
    for (const address of codeChecks) {
      expect(await ethers.provider.getCode(address)).not.to.equal("0x");
    }

    const aavePoolView = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      ["function ADDRESSES_PROVIDER() view returns (address)"],
      ethers.provider,
    );
    const addressesProvider = await aavePoolView.ADDRESSES_PROVIDER();
    expect(await ethers.provider.getCode(addressesProvider)).not.to.equal("0x");
    const addressesProviderContract = new ethers.Contract(
      addressesProvider,
      ["function getPriceOracle() view returns (address)"],
      ethers.provider,
    );
    const currentOracle = await addressesProviderContract.getPriceOracle();
    expect(await ethers.provider.getCode(currentOracle)).not.to.equal("0x");

    const verifiedPool = await verifyConfiguredUniswapPool(ethers.provider, {
      swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      weth: ARBITRUM.WETH,
      usdc: ARBITRUM.USDC,
      uniswapPool: configuredUniswapPool,
      uniswapPoolFee: 500,
    });
    expect(verifiedPool.configuredPool).to.equal(ethers.getAddress(configuredUniswapPool));
    expect(verifiedPool.derivedPool).to.equal(verifiedPool.configuredPool);
    expect(verifiedPool.poolFactory).to.equal(verifiedPool.factory);
    expect(verifiedPool.fee).to.equal(500);

    const config = {
      aavePool: ARBITRUM.AAVE_POOL,
      swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      weth: ARBITRUM.WETH,
      usdc: ARBITRUM.USDC,
      aWeth: ARBITRUM.A_WETH,
      variableDebtUsdc: ARBITRUM.VARIABLE_DEBT_USDC,
      positionOwner: positionOwner.address,
      keeper: keeper.address,
      uniswapPool: ethers.getAddress(configuredUniswapPool),
      uniswapPoolFee: 500,
      maxSlippageBps: 300,
      // Deliberately high on the fork so checkAndRepay can be exercised without oracle manipulation.
      triggerHealthFactor: ethers.parseUnits("10", 18),
      usdcRepayBuffer: ethers.parseUnits("1", 6),
    };

    const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config], positionOwner);
    const repayerAddress = await repayer.getAddress();
    expect(await repayer.ADDRESSES_PROVIDER()).to.equal(addressesProvider);
    const weth = new ethers.Contract(
      ARBITRUM.WETH,
      [
        "function deposit() payable",
        "function approve(address,uint256) returns (bool)",
        "function transfer(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const usdc = new ethers.Contract(
      ARBITRUM.USDC,
      [
        "function transfer(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const pool = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      [
        "function supply(address,uint256,address,uint16)",
        "function borrow(address,uint256,uint256,uint16,address)",
      ],
      positionOwner,
    );
    const aWeth = new ethers.Contract(
      ARBITRUM.A_WETH,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)",
      ],
      positionOwner,
    );
    const debtToken = new ethers.Contract(
      ARBITRUM.VARIABLE_DEBT_USDC,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider,
    );

    const collateral = ethers.parseEther("10");
    const debt = ethers.parseUnits("8000", 6);
    await weth.deposit({ value: collateral });
    await weth.approve(ARBITRUM.AAVE_POOL, collateral);
    await pool.supply(ARBITRUM.WETH, collateral, positionOwner.address, 0);
    await pool.borrow(ARBITRUM.USDC, debt, 2, 0, positionOwner.address);

    const looseUsdc = ethers.parseUnits("3", 6);
    const looseWeth = ethers.parseEther("0.01");
    const looseEth = ethers.parseEther("0.02");
    await usdc.transfer(repayerAddress, looseUsdc);
    await weth.deposit({ value: looseWeth });
    await weth.transfer(repayerAddress, looseWeth);
    await networkHelpers.setBalance(repayerAddress, looseEth);
    expect(await usdc.balanceOf(repayerAddress)).to.equal(looseUsdc);
    expect(await weth.balanceOf(repayerAddress)).to.equal(looseWeth);
    expect(await ethers.provider.getBalance(repayerAddress)).to.equal(looseEth);

    const ownerDebtBefore = await debtToken.balanceOf(positionOwner.address);
    const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);
    expect(ownerDebtBefore).to.be.gte(debt);
    expect(ownerAWethBefore).to.be.gte(collateral);
    expect(await debtToken.balanceOf(repayerAddress)).to.equal(0n);
    expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);

    await expect(repayer.connect(keeper).checkAndRepay({ gasLimit: 3_000_000n }))
      .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance");

    const preview = await repayer.previewEmergency();
    expect(preview.worstCaseCollateralNeeded).to.be.gt(preview.expectedCollateralNeeded);
    expect(preview.sufficientlyFunded).to.equal(true);
    expect(preview.sufficientlyApproved).to.equal(false);
    await aWeth.approve(repayerAddress, preview.expectedCollateralNeeded);
    const underApprovedPreview = await repayer.previewEmergency();
    expect(underApprovedPreview.ownerAWethAllowance).to.equal(preview.expectedCollateralNeeded);
    expect(underApprovedPreview.sufficientlyApproved).to.equal(false);
    await expect(repayer.connect(keeper).checkAndRepay({ gasLimit: 3_000_000n }))
      .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance");

    await aWeth.approve(repayerAddress, ethers.MaxUint256);
    const readyPreview = await repayer.previewEmergency();
    expect(readyPreview.triggerReached).to.equal(true);
    expect(readyPreview.readyToExecute).to.equal(true);

    await repayer.connect(keeper).checkAndRepay({ gasLimit: 3_500_000n });

    expect(await debtToken.balanceOf(positionOwner.address)).to.equal(0n);
    expect(await aWeth.balanceOf(positionOwner.address)).to.be.lt(ownerAWethBefore);
    expect(await aWeth.balanceOf(positionOwner.address)).to.be.gt(0n);
    expect(await debtToken.balanceOf(repayerAddress)).to.equal(0n);
    expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await usdc.balanceOf(repayerAddress)).to.equal(0n);
    expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await ethers.provider.getBalance(repayerAddress)).to.equal(looseEth);
    await expect(repayer.connect(keeper).sweepEth())
      .to.be.revertedWithCustomError(repayer, "Unauthorized");
    await expect(repayer.connect(positionOwner).sweepEth())
      .to.changeEtherBalances(ethers, [repayer, positionOwner], [-looseEth, looseEth]);
    expect(await ethers.provider.getBalance(repayerAddress)).to.equal(0n);

    const manualUsdcDust = ethers.parseUnits("1", 6);
    const manualWethDust = ethers.parseEther("0.005");
    await usdc.transfer(repayerAddress, manualUsdcDust);
    await weth.deposit({ value: manualWethDust });
    await weth.transfer(repayerAddress, manualWethDust);
    await repayer.connect(positionOwner).sweepUsdc();
    await repayer.connect(positionOwner).sweepWeth();
    expect(await usdc.balanceOf(repayerAddress)).to.equal(0n);
    expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await repayer.currentDebtUsdc()).to.equal(0n);
  });

  it("lets POSITION_OWNER force-repay a looped Aave WETH/USDC position", async function () {
    const { ethers, networkHelpers } = await network.create({
      network: "hardhatArbitrumFork",
      chainType: "generic",
    });
    const [positionOwner, keeper] = await ethers.getSigners();
    await networkHelpers.setBalance(positionOwner.address, ethers.parseEther("100"));

    const configuredUniswapPool = process.env.UNISWAP_WETH_USDC_POOL;
    if (!configuredUniswapPool) throw new Error("Missing UNISWAP_WETH_USDC_POOL");

    const aavePoolView = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      ["function ADDRESSES_PROVIDER() view returns (address)"],
      ethers.provider,
    );
    const addressesProvider = await aavePoolView.ADDRESSES_PROVIDER();
    const config = {
      aavePool: ARBITRUM.AAVE_POOL,
      swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      weth: ARBITRUM.WETH,
      usdc: ARBITRUM.USDC,
      aWeth: ARBITRUM.A_WETH,
      variableDebtUsdc: ARBITRUM.VARIABLE_DEBT_USDC,
      positionOwner: positionOwner.address,
      keeper: keeper.address,
      uniswapPool: ethers.getAddress(configuredUniswapPool),
      uniswapPoolFee: 500,
      maxSlippageBps: 300,
      triggerHealthFactor: ethers.parseUnits("1.10", 18),
      usdcRepayBuffer: ethers.parseUnits("1", 6),
    };

    const verifiedPool = await verifyConfiguredUniswapPool(ethers.provider, config);
    expect(verifiedPool.configuredPool).to.equal(ethers.getAddress(configuredUniswapPool));

    const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config], positionOwner);
    const repayerAddress = await repayer.getAddress();
    expect(await repayer.ADDRESSES_PROVIDER()).to.equal(addressesProvider);

    const weth = new ethers.Contract(
      ARBITRUM.WETH,
      [
        "function deposit() payable",
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const usdc = new ethers.Contract(
      ARBITRUM.USDC,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const pool = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      [
        "function supply(address,uint256,address,uint16)",
        "function borrow(address,uint256,uint256,uint16,address)",
      ],
      positionOwner,
    );
    const swapRouter = new ethers.Contract(
      ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      [
        "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
      ],
      positionOwner,
    );
    const aWeth = new ethers.Contract(
      ARBITRUM.A_WETH,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const debtToken = new ethers.Contract(
      ARBITRUM.VARIABLE_DEBT_USDC,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider,
    );

    const initialCollateral = ethers.parseEther("10");
    const loopBorrow = ethers.parseUnits("6000", 6);
    await weth.deposit({ value: initialCollateral });
    await weth.approve(ARBITRUM.AAVE_POOL, initialCollateral);
    await pool.supply(ARBITRUM.WETH, initialCollateral, positionOwner.address, 0);
    await pool.borrow(ARBITRUM.USDC, loopBorrow, 2, 0, positionOwner.address);

    expect(await usdc.balanceOf(positionOwner.address)).to.be.gte(loopBorrow);
    await usdc.approve(ARBITRUM.UNISWAP_V3_SWAP_ROUTER, loopBorrow);
    const wethBeforeLoopSwap = await weth.balanceOf(positionOwner.address);
    await swapRouter.exactInputSingle({
      tokenIn: ARBITRUM.USDC,
      tokenOut: ARBITRUM.WETH,
      fee: 500,
      recipient: positionOwner.address,
      deadline: ethers.MaxUint256,
      amountIn: loopBorrow,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    const loopedWeth = (await weth.balanceOf(positionOwner.address)) - wethBeforeLoopSwap;
    expect(loopedWeth).to.be.gt(0n);

    await weth.approve(ARBITRUM.AAVE_POOL, loopedWeth);
    await pool.supply(ARBITRUM.WETH, loopedWeth, positionOwner.address, 0);

    const loopedAWethBefore = await aWeth.balanceOf(positionOwner.address);
    const loopedDebtBefore = await debtToken.balanceOf(positionOwner.address);
    expect(loopedAWethBefore).to.be.gt(initialCollateral);
    expect(loopedDebtBefore).to.be.gte(loopBorrow);

    const previewBeforeApproval = await repayer.previewEmergency();
    expect(previewBeforeApproval.triggerReached).to.equal(false);
    await expect(repayer.connect(keeper).checkAndRepay({ gasLimit: 3_000_000n }))
      .to.be.revertedWithCustomError(repayer, "HealthFactorStillSafe");

    await aWeth.approve(repayerAddress, ethers.MaxUint256);
    const readyPreview = await repayer.previewEmergency();
    expect(readyPreview.sufficientlyFunded).to.equal(true);
    expect(readyPreview.sufficientlyApproved).to.equal(true);
    const ownerAWethBeforeClose = await aWeth.balanceOf(positionOwner.address);

    await repayer.connect(positionOwner).forceRepayAll({ gasLimit: 4_000_000n });

    expect(await debtToken.balanceOf(positionOwner.address)).to.equal(0n);
    const ownerAWethAfterClose = await aWeth.balanceOf(positionOwner.address);
    expect(ownerAWethAfterClose).to.be.gte(ownerAWethBeforeClose - readyPreview.worstCaseCollateralNeeded);
    expect(ownerAWethAfterClose).to.be.lt(loopedAWethBefore);
    expect(ownerAWethAfterClose).to.be.gt(0n);
    expect(await debtToken.balanceOf(repayerAddress)).to.equal(0n);
    expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await repayer.currentDebtUsdc()).to.equal(0n);
  });

  it("lets keeper close through checkAndRepay when the live upper HF trigger is reached", async function () {
    const { ethers, networkHelpers } = await network.create({
      network: "hardhatArbitrumFork",
      chainType: "generic",
    });
    const [positionOwner, keeper] = await ethers.getSigners();
    await networkHelpers.setBalance(positionOwner.address, ethers.parseEther("100"));

    const configuredUniswapPool = process.env.UNISWAP_WETH_USDC_POOL;
    if (!configuredUniswapPool) throw new Error("Missing UNISWAP_WETH_USDC_POOL");

    const config = {
      aavePool: ARBITRUM.AAVE_POOL,
      swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      weth: ARBITRUM.WETH,
      usdc: ARBITRUM.USDC,
      aWeth: ARBITRUM.A_WETH,
      variableDebtUsdc: ARBITRUM.VARIABLE_DEBT_USDC,
      positionOwner: positionOwner.address,
      keeper: keeper.address,
      uniswapPool: ethers.getAddress(configuredUniswapPool),
      uniswapPoolFee: 500,
      maxSlippageBps: 300,
      triggerHealthFactor: ethers.parseUnits("1.10", 18),
      usdcRepayBuffer: ethers.parseUnits("1", 6),
    };

    await verifyConfiguredUniswapPool(ethers.provider, config);
    const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config], positionOwner);
    const repayerAddress = await repayer.getAddress();

    const weth = new ethers.Contract(
      ARBITRUM.WETH,
      [
        "function deposit() payable",
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const pool = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      [
        "function supply(address,uint256,address,uint16)",
        "function borrow(address,uint256,uint256,uint16,address)",
      ],
      positionOwner,
    );
    const aWeth = new ethers.Contract(
      ARBITRUM.A_WETH,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const debtToken = new ethers.Contract(
      ARBITRUM.VARIABLE_DEBT_USDC,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider,
    );

    const collateral = ethers.parseEther("10");
    const debt = ethers.parseUnits("8000", 6);
    await weth.deposit({ value: collateral });
    await weth.approve(ARBITRUM.AAVE_POOL, collateral);
    await pool.supply(ARBITRUM.WETH, collateral, positionOwner.address, 0);
    await pool.borrow(ARBITRUM.USDC, debt, 2, 0, positionOwner.address);

    const currentHf = await repayer.healthFactor();
    const upperHf = (currentHf * 10_500n + 9_999n) / 10_000n;
    await repayer.connect(keeper).setUpperHealthFactor(upperHf);
    expect(await repayer.upperHealthFactor()).to.equal(upperHf);
    expect((await repayer.previewEmergency()).triggerReached).to.equal(false);

    const extraCollateral = ethers.parseEther("2");
    await weth.deposit({ value: extraCollateral });
    await weth.approve(ARBITRUM.AAVE_POOL, extraCollateral);
    await pool.supply(ARBITRUM.WETH, extraCollateral, positionOwner.address, 0);
    expect(await repayer.healthFactor()).to.be.gte(upperHf);

    await aWeth.approve(repayerAddress, ethers.MaxUint256);
    expect((await repayer.previewEmergency()).triggerReached).to.equal(true);
    await repayer.connect(keeper).checkAndRepay({ gasLimit: 3_500_000n });

    expect(await debtToken.balanceOf(positionOwner.address)).to.equal(0n);
    expect(await debtToken.balanceOf(repayerAddress)).to.equal(0n);
    expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await repayer.currentDebtUsdc()).to.equal(0n);
  });

  it("lets keeper close a looped Aave WETH/USDC position when the lower HF trigger is reached", async function () {
    const { ethers, networkHelpers } = await network.create({
      network: "hardhatArbitrumFork",
      chainType: "generic",
    });
    const [positionOwner, keeper] = await ethers.getSigners();
    await networkHelpers.setBalance(positionOwner.address, ethers.parseEther("100"));

    const configuredUniswapPool = process.env.UNISWAP_WETH_USDC_POOL;
    if (!configuredUniswapPool) throw new Error("Missing UNISWAP_WETH_USDC_POOL");

    const config = {
      aavePool: ARBITRUM.AAVE_POOL,
      swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      weth: ARBITRUM.WETH,
      usdc: ARBITRUM.USDC,
      aWeth: ARBITRUM.A_WETH,
      variableDebtUsdc: ARBITRUM.VARIABLE_DEBT_USDC,
      positionOwner: positionOwner.address,
      keeper: keeper.address,
      uniswapPool: ethers.getAddress(configuredUniswapPool),
      uniswapPoolFee: 500,
      maxSlippageBps: 300,
      // Deliberately high on the fork so the lower-trigger path is exercised without oracle manipulation.
      triggerHealthFactor: ethers.parseUnits("10", 18),
      usdcRepayBuffer: ethers.parseUnits("1", 6),
    };

    await verifyConfiguredUniswapPool(ethers.provider, config);
    const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config], positionOwner);
    const repayerAddress = await repayer.getAddress();

    const weth = new ethers.Contract(
      ARBITRUM.WETH,
      [
        "function deposit() payable",
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const usdc = new ethers.Contract(
      ARBITRUM.USDC,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const pool = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      [
        "function supply(address,uint256,address,uint16)",
        "function borrow(address,uint256,uint256,uint16,address)",
      ],
      positionOwner,
    );
    const swapRouter = new ethers.Contract(
      ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      [
        "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
      ],
      positionOwner,
    );
    const aWeth = new ethers.Contract(
      ARBITRUM.A_WETH,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const debtToken = new ethers.Contract(
      ARBITRUM.VARIABLE_DEBT_USDC,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider,
    );

    const initialCollateral = ethers.parseEther("10");
    const loopBorrow = ethers.parseUnits("6000", 6);
    await weth.deposit({ value: initialCollateral });
    await weth.approve(ARBITRUM.AAVE_POOL, initialCollateral);
    await pool.supply(ARBITRUM.WETH, initialCollateral, positionOwner.address, 0);
    await pool.borrow(ARBITRUM.USDC, loopBorrow, 2, 0, positionOwner.address);

    await usdc.approve(ARBITRUM.UNISWAP_V3_SWAP_ROUTER, loopBorrow);
    const wethBeforeLoopSwap = await weth.balanceOf(positionOwner.address);
    await swapRouter.exactInputSingle({
      tokenIn: ARBITRUM.USDC,
      tokenOut: ARBITRUM.WETH,
      fee: 500,
      recipient: positionOwner.address,
      deadline: ethers.MaxUint256,
      amountIn: loopBorrow,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    const loopedWeth = (await weth.balanceOf(positionOwner.address)) - wethBeforeLoopSwap;
    expect(loopedWeth).to.be.gt(0n);

    await weth.approve(ARBITRUM.AAVE_POOL, loopedWeth);
    await pool.supply(ARBITRUM.WETH, loopedWeth, positionOwner.address, 0);

    const loopedAWethBefore = await aWeth.balanceOf(positionOwner.address);
    expect(loopedAWethBefore).to.be.gt(initialCollateral);
    expect(await debtToken.balanceOf(positionOwner.address)).to.be.gte(loopBorrow);
    expect(await repayer.healthFactor()).to.be.lte(config.triggerHealthFactor);

    await aWeth.approve(repayerAddress, ethers.MaxUint256);
    const readyPreview = await repayer.previewEmergency();
    expect(readyPreview.triggerReached).to.equal(true);
    expect(readyPreview.readyToExecute).to.equal(true);
    const ownerAWethBeforeClose = await aWeth.balanceOf(positionOwner.address);

    await repayer.connect(keeper).checkAndRepay({ gasLimit: 4_000_000n });

    expect(await debtToken.balanceOf(positionOwner.address)).to.equal(0n);
    const ownerAWethAfterClose = await aWeth.balanceOf(positionOwner.address);
    expect(ownerAWethAfterClose).to.be.gte(ownerAWethBeforeClose - readyPreview.worstCaseCollateralNeeded);
    expect(ownerAWethAfterClose).to.be.lt(loopedAWethBefore);
    expect(ownerAWethAfterClose).to.be.gt(0n);
    expect(await debtToken.balanceOf(repayerAddress)).to.equal(0n);
    expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await repayer.currentDebtUsdc()).to.equal(0n);
  });

  it("lets keeper close a looped Aave WETH/USDC position when the live upper HF trigger is reached", async function () {
    const { ethers, networkHelpers } = await network.create({
      network: "hardhatArbitrumFork",
      chainType: "generic",
    });
    const [positionOwner, keeper] = await ethers.getSigners();
    await networkHelpers.setBalance(positionOwner.address, ethers.parseEther("100"));

    const configuredUniswapPool = process.env.UNISWAP_WETH_USDC_POOL;
    if (!configuredUniswapPool) throw new Error("Missing UNISWAP_WETH_USDC_POOL");

    const config = {
      aavePool: ARBITRUM.AAVE_POOL,
      swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      weth: ARBITRUM.WETH,
      usdc: ARBITRUM.USDC,
      aWeth: ARBITRUM.A_WETH,
      variableDebtUsdc: ARBITRUM.VARIABLE_DEBT_USDC,
      positionOwner: positionOwner.address,
      keeper: keeper.address,
      uniswapPool: ethers.getAddress(configuredUniswapPool),
      uniswapPoolFee: 500,
      maxSlippageBps: 300,
      triggerHealthFactor: ethers.parseUnits("1.10", 18),
      usdcRepayBuffer: ethers.parseUnits("1", 6),
    };

    await verifyConfiguredUniswapPool(ethers.provider, config);
    const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config], positionOwner);
    const repayerAddress = await repayer.getAddress();

    const weth = new ethers.Contract(
      ARBITRUM.WETH,
      [
        "function deposit() payable",
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const usdc = new ethers.Contract(
      ARBITRUM.USDC,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const pool = new ethers.Contract(
      ARBITRUM.AAVE_POOL,
      [
        "function supply(address,uint256,address,uint16)",
        "function borrow(address,uint256,uint256,uint16,address)",
      ],
      positionOwner,
    );
    const swapRouter = new ethers.Contract(
      ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
      [
        "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
      ],
      positionOwner,
    );
    const aWeth = new ethers.Contract(
      ARBITRUM.A_WETH,
      [
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
      ],
      positionOwner,
    );
    const debtToken = new ethers.Contract(
      ARBITRUM.VARIABLE_DEBT_USDC,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider,
    );

    const initialCollateral = ethers.parseEther("10");
    const loopBorrow = ethers.parseUnits("6000", 6);
    await weth.deposit({ value: initialCollateral });
    await weth.approve(ARBITRUM.AAVE_POOL, initialCollateral);
    await pool.supply(ARBITRUM.WETH, initialCollateral, positionOwner.address, 0);
    await pool.borrow(ARBITRUM.USDC, loopBorrow, 2, 0, positionOwner.address);

    await usdc.approve(ARBITRUM.UNISWAP_V3_SWAP_ROUTER, loopBorrow);
    const wethBeforeLoopSwap = await weth.balanceOf(positionOwner.address);
    await swapRouter.exactInputSingle({
      tokenIn: ARBITRUM.USDC,
      tokenOut: ARBITRUM.WETH,
      fee: 500,
      recipient: positionOwner.address,
      deadline: ethers.MaxUint256,
      amountIn: loopBorrow,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    });
    const loopedWeth = (await weth.balanceOf(positionOwner.address)) - wethBeforeLoopSwap;
    expect(loopedWeth).to.be.gt(0n);

    await weth.approve(ARBITRUM.AAVE_POOL, loopedWeth);
    await pool.supply(ARBITRUM.WETH, loopedWeth, positionOwner.address, 0);

    const loopedAWethBefore = await aWeth.balanceOf(positionOwner.address);
    expect(loopedAWethBefore).to.be.gt(initialCollateral);
    expect(await debtToken.balanceOf(positionOwner.address)).to.be.gte(loopBorrow);

    const currentHf = await repayer.healthFactor();
    const upperHf = (currentHf * 10_500n + 9_999n) / 10_000n;
    await repayer.connect(keeper).setUpperHealthFactor(upperHf);
    expect(await repayer.upperHealthFactor()).to.equal(upperHf);
    expect((await repayer.previewEmergency()).triggerReached).to.equal(false);

    const extraCollateral = ethers.parseEther("2");
    await weth.deposit({ value: extraCollateral });
    await weth.approve(ARBITRUM.AAVE_POOL, extraCollateral);
    await pool.supply(ARBITRUM.WETH, extraCollateral, positionOwner.address, 0);
    expect(await repayer.healthFactor()).to.be.gte(upperHf);

    await aWeth.approve(repayerAddress, ethers.MaxUint256);
    const readyPreview = await repayer.previewEmergency();
    expect(readyPreview.triggerReached).to.equal(true);
    expect(readyPreview.readyToExecute).to.equal(true);
    const ownerAWethBeforeClose = await aWeth.balanceOf(positionOwner.address);

    await repayer.connect(keeper).checkAndRepay({ gasLimit: 4_000_000n });

    expect(await debtToken.balanceOf(positionOwner.address)).to.equal(0n);
    const ownerAWethAfterClose = await aWeth.balanceOf(positionOwner.address);
    expect(ownerAWethAfterClose).to.be.gte(ownerAWethBeforeClose - readyPreview.worstCaseCollateralNeeded);
    expect(ownerAWethAfterClose).to.be.lt(ownerAWethBeforeClose);
    expect(ownerAWethAfterClose).to.be.gt(0n);
    expect(await debtToken.balanceOf(repayerAddress)).to.equal(0n);
    expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
    expect(await repayer.currentDebtUsdc()).to.equal(0n);
  });
});
