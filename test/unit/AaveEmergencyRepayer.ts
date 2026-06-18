import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const HF_SAFE = ethers.parseUnits("2", 18);
const HF_TRIGGER = ethers.parseUnits("1.10", 18);
const HF_DANGER = ethers.parseUnits("1.05", 18);
const TEN_WETH = ethers.parseEther("10");
const DEBT = ethers.parseUnits("8000", 6);
const BUFFER = ethers.parseUnits("1", 6);
const UNISWAP_FEE = 500;

async function deployFixture() {
  const [positionOwner, keeper, stranger] = await ethers.getSigners();

  const weth = await ethers.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
  const usdc = await ethers.deployContract("MockERC20", ["USD Coin", "USDC", 6]);
  const aWeth = await ethers.deployContract("MockAaveToken", [
    "Aave WETH",
    "aWETH",
    18,
    await weth.getAddress(),
    ethers.ZeroAddress,
  ]);
  const variableDebtUsdc = await ethers.deployContract("MockAaveToken", [
    "Variable Debt USDC",
    "vUSDC",
    6,
    await usdc.getAddress(),
    ethers.ZeroAddress,
  ]);
  const oracle = await ethers.deployContract("MockOracle");
  const addressesProvider = await ethers.deployContract("MockAddressesProvider", [
    await oracle.getAddress(),
  ]);
  const factory = await ethers.deployContract("MockFactory");
  const uniswapPool = await ethers.deployContract("MockUniswapV3Pool", [
    await weth.getAddress(),
    await usdc.getAddress(),
    UNISWAP_FEE,
    await factory.getAddress(),
  ]);
  await factory.setPool(
    await weth.getAddress(),
    await usdc.getAddress(),
    UNISWAP_FEE,
    await uniswapPool.getAddress(),
  );
  const router = await ethers.deployContract("MockRouter", [
    await factory.getAddress(),
    await weth.getAddress(),
    await usdc.getAddress(),
    UNISWAP_FEE,
  ]);
  const pool = await ethers.deployContract("MockAavePool", [
    await weth.getAddress(),
    await usdc.getAddress(),
    await aWeth.getAddress(),
    await variableDebtUsdc.getAddress(),
    await addressesProvider.getAddress(),
  ]);
  await aWeth.setAaveBinding(await weth.getAddress(), await pool.getAddress());
  await variableDebtUsdc.setAaveBinding(await usdc.getAddress(), await pool.getAddress());

  await oracle.setPrice(await weth.getAddress(), 2_000n * 10n ** 8n);
  await oracle.setPrice(await usdc.getAddress(), 1n * 10n ** 8n);

  const config = {
    aavePool: await pool.getAddress(),
    swapRouter: await router.getAddress(),
    weth: await weth.getAddress(),
    usdc: await usdc.getAddress(),
    aWeth: await aWeth.getAddress(),
    variableDebtUsdc: await variableDebtUsdc.getAddress(),
    positionOwner: positionOwner.address,
    keeper: keeper.address,
    uniswapPool: await uniswapPool.getAddress(),
    uniswapPoolFee: UNISWAP_FEE,
    maxSlippageBps: 200,
    triggerHealthFactor: HF_TRIGGER,
    usdcRepayBuffer: BUFFER,
  };

  const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config]);

  await weth.mint(positionOwner.address, ethers.parseEther("100"));
  await usdc.mint(await pool.getAddress(), ethers.parseUnits("1000000", 6));
  await usdc.mint(await router.getAddress(), ethers.parseUnits("1000000", 6));
  await weth.mint(await pool.getAddress(), ethers.parseEther("1000000"));
  await weth.mint(await router.getAddress(), ethers.parseEther("1000000"));

  async function openOwnerPosition(collateral = TEN_WETH, debt = DEBT) {
    await weth.connect(positionOwner).approve(await pool.getAddress(), collateral);
    await pool.connect(positionOwner).supply(await weth.getAddress(), collateral, positionOwner.address, 0);
    await pool.connect(positionOwner).borrow(await usdc.getAddress(), debt, 2, 0, positionOwner.address);
    await pool.resetOperationFlags();
  }

  async function approveWorstCaseCollateral(multiplier = 1n) {
    const preview = await repayer.previewEmergency();
    const allowance = preview.worstCaseCollateralNeeded * multiplier;
    await aWeth.connect(positionOwner).approve(await repayer.getAddress(), allowance);
    return allowance;
  }

  async function approveMaxCollateral() {
    await aWeth.connect(positionOwner).approve(await repayer.getAddress(), ethers.MaxUint256);
  }

  return {
    positionOwner,
    keeper,
    stranger,
    weth,
    usdc,
    aWeth,
    variableDebtUsdc,
    oracle,
    factory,
    uniswapPool,
    router,
    pool,
    addressesProvider,
    repayer,
    config,
    openOwnerPosition,
    approveWorstCaseCollateral,
    approveMaxCollateral,
  };
}

describe("AaveEmergencyRepayer", function () {
  describe("deployment and immutable configuration", function () {
    it("stores immutable actors, venues, pair, and trigger", async function () {
      const { repayer, positionOwner, keeper, pool, addressesProvider, router, uniswapPool } =
        await networkHelpers.loadFixture(deployFixture);

      expect(await repayer.POSITION_OWNER()).to.equal(positionOwner.address);
      expect(await repayer.KEEPER()).to.equal(keeper.address);
      expect(await repayer.AAVE_POOL()).to.equal(await pool.getAddress());
      expect(await repayer.ADDRESSES_PROVIDER()).to.equal(await addressesProvider.getAddress());
      expect(await repayer.SWAP_ROUTER()).to.equal(await router.getAddress());
      expect(await repayer.UNISWAP_POOL()).to.equal(await uniswapPool.getAddress());
      expect(await repayer.UNISWAP_POOL_FEE()).to.equal(BigInt(UNISWAP_FEE));
      expect(await repayer.TRIGGER_HEALTH_FACTOR()).to.equal(HF_TRIGGER);
      expect(await repayer.MAX_SLIPPAGE_BPS()).to.equal(200n);
      expect(await repayer.USDC_REPAY_BUFFER()).to.equal(BUFFER);
      expect(await repayer.MIN_UPPER_HEALTH_FACTOR_DISTANCE_BPS()).to.equal(500n);
      expect(await repayer.upperHealthFactor()).to.equal(0n);
    });

    it("rejects zero addresses and identical owner/keeper", async function () {
      const { config } = await networkHelpers.loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("AaveEmergencyRepayer");

      await expect(factory.deploy({ ...config, positionOwner: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy({ ...config, keeper: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(factory, "ZeroAddress");
      await expect(factory.deploy({ ...config, keeper: config.positionOwner }))
        .to.be.revertedWithCustomError(factory, "InvalidActors");
    });

    it("rejects critical Aave, token, router, and pool addresses with no code", async function () {
      const { config, stranger } = await networkHelpers.loadFixture(deployFixture);
      const factory = await ethers.getContractFactory("AaveEmergencyRepayer");

      await expect(factory.deploy({ ...config, aavePool: stranger.address }))
        .to.be.revertedWithCustomError(factory, "InvalidAavePool");
      await expect(factory.deploy({ ...config, weth: stranger.address }))
        .to.be.revertedWithCustomError(factory, "InvalidToken");
      await expect(factory.deploy({ ...config, swapRouter: stranger.address }))
        .to.be.revertedWithCustomError(factory, "InvalidSwapRouter");
      await expect(factory.deploy({ ...config, uniswapPool: stranger.address }))
        .to.be.revertedWithCustomError(factory, "InvalidUniswapPool");
    });

    it("rejects Aave pools whose addresses provider is zero or has no code", async function () {
      const { config, weth, usdc, stranger } = await networkHelpers.loadFixture(deployFixture);
      const repayerFactory = await ethers.getContractFactory("AaveEmergencyRepayer");

      async function deployPoolWithProvider(addressesProvider: string) {
        const badAWeth = await ethers.deployContract("MockAaveToken", [
          "Bad aWETH",
          "baWETH",
          18,
          await weth.getAddress(),
          ethers.ZeroAddress,
        ]);
        const badDebt = await ethers.deployContract("MockAaveToken", [
          "Bad Variable Debt USDC",
          "bvUSDC",
          6,
          await usdc.getAddress(),
          ethers.ZeroAddress,
        ]);
        const badPool = await ethers.deployContract("MockAavePool", [
          await weth.getAddress(),
          await usdc.getAddress(),
          await badAWeth.getAddress(),
          await badDebt.getAddress(),
          addressesProvider,
        ]);
        await badAWeth.setAaveBinding(await weth.getAddress(), await badPool.getAddress());
        await badDebt.setAaveBinding(await usdc.getAddress(), await badPool.getAddress());
        return {
          aavePool: await badPool.getAddress(),
          aWeth: await badAWeth.getAddress(),
          variableDebtUsdc: await badDebt.getAddress(),
        };
      }

      await expect(
        repayerFactory.deploy({ ...config, ...(await deployPoolWithProvider(ethers.ZeroAddress)) }),
      ).to.be.revertedWithCustomError(repayerFactory, "InvalidAddressesProvider");
      await expect(
        repayerFactory.deploy({ ...config, ...(await deployPoolWithProvider(stranger.address)) }),
      ).to.be.revertedWithCustomError(repayerFactory, "InvalidAddressesProvider");
    });

    it("rejects Aave pools whose current oracle is zero or has no code at deployment", async function () {
      const { config, addressesProvider, stranger } = await networkHelpers.loadFixture(deployFixture);
      const repayerFactory = await ethers.getContractFactory("AaveEmergencyRepayer");

      await addressesProvider.setPriceOracle(ethers.ZeroAddress);
      await expect(repayerFactory.deploy(config))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidCurrentOracle");

      await addressesProvider.setPriceOracle(stranger.address);
      await expect(repayerFactory.deploy(config))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidCurrentOracle");
    });

    it("rejects invalid pool configuration, token decimals, and token bindings", async function () {
      const { config, weth, usdc, pool, factory, router } =
        await networkHelpers.loadFixture(deployFixture);
      const repayerFactory = await ethers.getContractFactory("AaveEmergencyRepayer");

      const wrongDecimals = await ethers.deployContract("MockAaveToken", [
        "Bad aWETH",
        "baWETH",
        6,
        await weth.getAddress(),
        await pool.getAddress(),
      ]);
      await expect(repayerFactory.deploy({ ...config, aWeth: await wrongDecimals.getAddress() }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidTokenDecimals");

      const wrongUnderlying = await ethers.deployContract("MockAaveToken", [
        "Bad aWETH",
        "baWETH",
        18,
        await usdc.getAddress(),
        await pool.getAddress(),
      ]);
      await expect(repayerFactory.deploy({ ...config, aWeth: await wrongUnderlying.getAddress() }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidAToken");

      const badPool = await ethers.deployContract("MockUniswapV3Pool", [
        await weth.getAddress(),
        await usdc.getAddress(),
        3000,
        await factory.getAddress(),
      ]);
      await expect(repayerFactory.deploy({ ...config, uniswapPool: await badPool.getAddress() }))
        .to.be.revertedWithCustomError(repayerFactory, "UniswapPoolMismatch");

      await expect(repayerFactory.deploy({ ...config, maxSlippageBps: 0 }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidBps");
      await expect(repayerFactory.deploy({ ...config, maxSlippageBps: 501 }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidBps");
      await expect(repayerFactory.deploy({ ...config, usdcRepayBuffer: 0n }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidRepayBuffer");
      await expect(repayerFactory.deploy({ ...config, usdcRepayBuffer: ethers.parseUnits("10", 6) + 1n }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidRepayBuffer");
      await expect(repayerFactory.deploy({ ...config, triggerHealthFactor: ethers.parseEther("1") }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidHealthFactor");

      expect(await router.factory()).to.equal(await factory.getAddress());
    });

    it("rejects a configured Uniswap pool whose own factory differs from the router factory", async function () {
      const { config, weth, usdc, factory } = await networkHelpers.loadFixture(deployFixture);
      const repayerFactory = await ethers.getContractFactory("AaveEmergencyRepayer");
      const wrongFactory = await ethers.deployContract("MockFactory");
      const poolWithWrongFactory = await ethers.deployContract("MockUniswapV3Pool", [
        await weth.getAddress(),
        await usdc.getAddress(),
        UNISWAP_FEE,
        await wrongFactory.getAddress(),
      ]);
      await factory.setPool(
        await weth.getAddress(),
        await usdc.getAddress(),
        UNISWAP_FEE,
        await poolWithWrongFactory.getAddress(),
      );

      await expect(repayerFactory.deploy({ ...config, uniswapPool: await poolWithWrongFactory.getAddress() }))
        .to.be.revertedWithCustomError(repayerFactory, "InvalidUniswapPoolFactory");
    });

    it("does not expose normal Aave position-management functions or mutable setters beyond upper HF policy", async function () {
      const factory = await ethers.getContractFactory("AaveEmergencyRepayer");
      const names: string[] = [];
      factory.interface.forEachFunction((fragment) => names.push(fragment.name));

      expect(names).not.to.include.members([
        "repayExistingUsdc",
        "withdrawWeth",
        "deleverWithCollateral",
        "loopExistingWeth",
        "borrowUsdc",
        "supplyExistingWeth",
      ]);
      expect(names.filter((name) => name.startsWith("set"))).to.deep.equal(["setUpperHealthFactor"]);
      expect(factory.interface.getFunction("checkAndRepay")?.inputs).to.have.length(0);
    });
  });

  describe("EOA-owned Aave position", function () {
    it("keeps aWETH and variable debt on POSITION_OWNER, never on the contract", async function () {
      const { positionOwner, repayer, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      const repayerAddress = await repayer.getAddress();
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
      expect(await variableDebtUsdc.balanceOf(repayerAddress)).to.equal(0n);
    });

    it("reads health factor and debt from POSITION_OWNER", async function () {
      const { positionOwner, repayer, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await pool.setHealthFactor(HF_SAFE);
      await pool.setUserHealthFactor(positionOwner.address, HF_DANGER);

      expect(await repayer.healthFactor()).to.equal(HF_DANGER);
      expect(await repayer.currentDebtUsdc()).to.equal(DEBT);
    });

    it("lets the owner operate the Aave position independently of the emergency contract", async function () {
      const { positionOwner, repayer, weth, usdc, aWeth, variableDebtUsdc, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      const extraCollateral = ethers.parseEther("1");
      await weth.connect(positionOwner).approve(await pool.getAddress(), extraCollateral);
      await pool.connect(positionOwner).supply(await weth.getAddress(), extraCollateral, positionOwner.address, 0);
      await pool.connect(positionOwner).borrow(await usdc.getAddress(), ethers.parseUnits("500", 6), 2, 0, positionOwner.address);

      const repay = ethers.parseUnits("250", 6);
      await usdc.connect(positionOwner).approve(await pool.getAddress(), repay);
      await pool.connect(positionOwner).repay(await usdc.getAddress(), repay, 2, positionOwner.address);

      const withdraw = ethers.parseEther("0.5");
      await pool.connect(positionOwner).withdraw(await weth.getAddress(), withdraw, positionOwner.address);

      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH + extraCollateral - withdraw);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT + ethers.parseUnits("250", 6));
      expect(await aWeth.balanceOf(await repayer.getAddress())).to.equal(0n);
      expect(await variableDebtUsdc.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("previews owner metrics, collateral need, allowance, and trigger state", async function () {
      const { positionOwner, repayer, aWeth, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await pool.setUserHealthFactor(positionOwner.address, HF_DANGER);

      let preview = await repayer.previewEmergency();
      expect(preview.hf).to.equal(HF_DANGER);
      expect(preview.debtUsdc).to.equal(DEBT);
      expect(preview.usdcTarget).to.equal(DEBT + BUFFER);
      expect(preview.maxFlashWeth).to.equal(await repayer.maxWethForUsdc(DEBT + BUFFER));
      expect(preview.expectedCollateralNeeded).to.equal(
        (await repayer.oracleWethForUsdc(DEBT + BUFFER)) + (await repayer.flashPremiumFor(preview.maxFlashWeth)),
      );
      expect(preview.worstCaseCollateralNeeded).to.equal(
        preview.maxFlashWeth + (await repayer.flashPremiumFor(preview.maxFlashWeth)),
      );
      expect(preview.worstCaseCollateralNeeded).to.be.gt(preview.expectedCollateralNeeded);
      expect(preview.ownerAWethBalance).to.equal(TEN_WETH);
      expect(preview.ownerAWethAllowance).to.equal(0n);
      expect(preview.triggerReached).to.equal(true);
      expect(preview.sufficientlyFunded).to.equal(true);
      expect(preview.sufficientlyApproved).to.equal(false);
      expect(preview.readyToExecute).to.equal(false);

      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      preview = await repayer.previewEmergency();
      expect(preview.sufficientlyApproved).to.equal(true);
      expect(preview.readyToExecute).to.equal(true);
    });

    it("uses the current oracle from the Aave addresses provider on every preview", async function () {
      const { repayer, addressesProvider, oracle, weth, usdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      expect(await repayer.oracleWethForUsdc(DEBT)).to.equal(ethers.parseEther("4"));

      const newOracle = await ethers.deployContract("MockOracle");
      await newOracle.setPrice(await weth.getAddress(), 1_000n * 10n ** 8n);
      await newOracle.setPrice(await usdc.getAddress(), 1n * 10n ** 8n);
      await addressesProvider.setPriceOracle(await newOracle.getAddress());

      const preview = await repayer.previewEmergency();
      expect(await oracle.getAssetPrice(await weth.getAddress())).to.equal(2_000n * 10n ** 8n);
      expect(await repayer.oracleWethForUsdc(DEBT)).to.equal(ethers.parseEther("8"));
      expect(preview.maxFlashWeth).to.equal(await repayer.maxWethForUsdc(DEBT + BUFFER));
    });

    it("rejects a current Aave oracle that is zero or has no code", async function () {
      const { repayer, addressesProvider, stranger, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      await addressesProvider.setPriceOracle(ethers.ZeroAddress);
      await expect(repayer.previewEmergency())
        .to.be.revertedWithCustomError(repayer, "InvalidCurrentOracle");

      await addressesProvider.setPriceOracle(stranger.address);
      await expect(repayer.maxWethForUsdc(DEBT))
        .to.be.revertedWithCustomError(repayer, "InvalidCurrentOracle");
    });
  });

  describe("emergency close", function () {
    async function openApproveAndTrigger() {
      const fixture = await networkHelpers.loadFixture(deployFixture);
      await fixture.openOwnerPosition();
      await fixture.pool.setUserHealthFactor(fixture.positionOwner.address, HF_DANGER);
      const preview = await fixture.repayer.previewEmergency();
      await fixture.aWeth
        .connect(fixture.positionOwner)
        .approve(await fixture.repayer.getAddress(), preview.worstCaseCollateralNeeded);
      return { ...fixture, preview };
    }

    it("reverts when health factor is still above the immutable trigger", async function () {
      const { keeper, repayer, openOwnerPosition, approveWorstCaseCollateral } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();

      await expect(repayer.connect(keeper).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "HealthFactorStillSafe")
        .withArgs(HF_SAFE, HF_TRIGGER);
    });

    it("lets keeper configure an upper HF only when it is at least 5% above current HF", async function () {
      const { positionOwner, keeper, stranger, repayer, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const currentHf = ethers.parseUnits("1.50", 18);
      const minimumUpper = ethers.parseUnits("1.575", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);

      await expect(repayer.connect(stranger).setUpperHealthFactor(minimumUpper))
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      await expect(repayer.connect(keeper).setUpperHealthFactor(minimumUpper - 1n))
        .to.be.revertedWithCustomError(repayer, "UpperHealthFactorTooClose")
        .withArgs(currentHf, minimumUpper - 1n, minimumUpper);

      await expect(repayer.connect(keeper).setUpperHealthFactor(minimumUpper))
        .to.emit(repayer, "UpperHealthFactorUpdated")
        .withArgs(0n, minimumUpper);
      expect(await repayer.upperHealthFactor()).to.equal(minimumUpper);
    });

    it("lets checkAndRepay use the active upper HF trigger through the same polling endpoint", async function () {
      const { positionOwner, keeper, repayer, aWeth, variableDebtUsdc, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      const currentHf = ethers.parseUnits("1.50", 18);
      const upperHf = ethers.parseUnits("1.575", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);
      await repayer.connect(keeper).setUpperHealthFactor(upperHf);
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), ethers.MaxUint256);

      let preview = await repayer.previewEmergency();
      expect(preview.triggerReached).to.equal(false);
      expect(await repayer.upperHealthFactor()).to.equal(upperHf);
      await expect(repayer.connect(keeper).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "HealthFactorInRange")
        .withArgs(currentHf, HF_TRIGGER, upperHf);

      await pool.setUserHealthFactor(positionOwner.address, upperHf);
      preview = await repayer.previewEmergency();
      expect(preview.triggerReached).to.equal(true);

      await repayer.connect(keeper).checkAndRepay();
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
    });

    it("starts with the upper HF trigger disabled and lets keeper disable it again", async function () {
      const { positionOwner, keeper, repayer, pool, openOwnerPosition, approveWorstCaseCollateral } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();

      const currentHf = ethers.parseUnits("1.50", 18);
      const upperHf = ethers.parseUnits("1.575", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);
      await repayer.connect(keeper).setUpperHealthFactor(upperHf);
      await expect(repayer.connect(keeper).setUpperHealthFactor(0n))
        .to.emit(repayer, "UpperHealthFactorUpdated")
        .withArgs(upperHf, 0n);

      const preview = await repayer.previewEmergency();
      expect(await repayer.upperHealthFactor()).to.equal(0n);
      expect(preview.triggerReached).to.equal(false);
      await expect(repayer.connect(keeper).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "HealthFactorStillSafe")
        .withArgs(currentHf, HF_TRIGGER);
    });

    it("allows an absurdly high upper HF without creating an immediate close path", async function () {
      const { positionOwner, keeper, repayer, pool, openOwnerPosition, approveWorstCaseCollateral } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();

      const currentHf = ethers.parseUnits("1.50", 18);
      const absurdUpperHf = ethers.parseUnits("100", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);
      await repayer.connect(keeper).setUpperHealthFactor(absurdUpperHf);

      expect(await repayer.upperHealthFactor()).to.equal(absurdUpperHf);
      expect((await repayer.previewEmergency()).triggerReached).to.equal(false);
      await expect(repayer.connect(keeper).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "HealthFactorInRange")
        .withArgs(currentHf, HF_TRIGGER, absurdUpperHf);
    });

    it("uses lower trigger plus one as the upper HF floor when current HF is deeply unsafe", async function () {
      const { positionOwner, keeper, repayer, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      const unsafeHf = ethers.parseUnits("0.90", 18);
      const minimumUpper = HF_TRIGGER + 1n;
      await pool.setUserHealthFactor(positionOwner.address, unsafeHf);

      await expect(repayer.connect(keeper).setUpperHealthFactor(HF_TRIGGER))
        .to.be.revertedWithCustomError(repayer, "UpperHealthFactorTooClose")
        .withArgs(unsafeHf, HF_TRIGGER, minimumUpper);
      await repayer.connect(keeper).setUpperHealthFactor(minimumUpper);
      expect(await repayer.upperHealthFactor()).to.equal(minimumUpper);
    });

    it("reverts with NoDebt when upper trigger is reached but the owner has no USDC debt", async function () {
      const { keeper, repayer, pool, positionOwner } = await networkHelpers.loadFixture(deployFixture);
      const currentHf = ethers.parseUnits("2", 18);
      const upperHf = ethers.parseUnits("2.10", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);
      await repayer.connect(keeper).setUpperHealthFactor(upperHf);
      await pool.setUserHealthFactor(positionOwner.address, upperHf);

      await expect(repayer.connect(keeper).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "NoDebt");
    });

    it("reverts before flash loan when upper trigger is reached but owner aWETH allowance is missing", async function () {
      const { positionOwner, keeper, repayer, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      const currentHf = ethers.parseUnits("1.50", 18);
      const upperHf = ethers.parseUnits("1.575", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);
      await repayer.connect(keeper).setUpperHealthFactor(upperHf);
      await pool.setUserHealthFactor(positionOwner.address, upperHf);
      const preview = await repayer.previewEmergency();

      await expect(repayer.connect(keeper).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(0n, preview.worstCaseCollateralNeeded);
      expect(await pool.lastFlashAmount()).to.equal(0n);
    });

    it("enforces the same slippage ceiling when repayment is triggered by upper HF", async function () {
      const { positionOwner, keeper, repayer, router, aWeth, variableDebtUsdc, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();

      const currentHf = ethers.parseUnits("1.50", 18);
      const upperHf = ethers.parseUnits("1.575", 18);
      await pool.setUserHealthFactor(positionOwner.address, currentHf);
      await repayer.connect(keeper).setUpperHealthFactor(upperHf);
      await pool.setUserHealthFactor(positionOwner.address, upperHf);
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), ethers.MaxUint256);
      await router.setUsdcPerWeth(1_500n * 10n ** 6n);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(keeper).checkAndRepay()).to.be.revertedWith("TOO_MUCH_IN");
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
    });

    it("enforces keeper/owner access for checkAndRepay and owner-only access for forceRepayAll", async function () {
      const { positionOwner, keeper, stranger, repayer, pool, openOwnerPosition, approveWorstCaseCollateral } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await pool.setUserHealthFactor(positionOwner.address, HF_DANGER);
      await approveWorstCaseCollateral();

      await expect(repayer.connect(stranger).checkAndRepay())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      await expect(repayer.connect(stranger).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");

      await repayer.connect(keeper).checkAndRepay();
    });

    it("lets POSITION_OWNER force the same full close before the trigger", async function () {
      const { positionOwner, repayer, variableDebtUsdc, openOwnerPosition, approveWorstCaseCollateral } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();

      await repayer.connect(positionOwner).forceRepayAll();
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
    });

    it("reverts when no owner debt exists", async function () {
      const { positionOwner, repayer } = await networkHelpers.loadFixture(deployFixture);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "NoDebt");
    });

    it("reverts before flash loan when owner aWETH allowance is missing or insufficient", async function () {
      const { positionOwner, repayer, aWeth, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(0n, preview.worstCaseCollateralNeeded);

      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded - 1n);
      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(preview.worstCaseCollateralNeeded - 1n, preview.worstCaseCollateralNeeded);
    });

    it("does not start the flash loan when approval covers expected collateral but not worst case", async function () {
      const { positionOwner, repayer, aWeth, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      expect(preview.expectedCollateralNeeded).to.be.lt(preview.worstCaseCollateralNeeded);

      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.expectedCollateralNeeded);
      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(preview.expectedCollateralNeeded, preview.worstCaseCollateralNeeded);
      expect(await pool.lastFlashAmount()).to.equal(0n);
    });

    it("rechecks flash premium after preview and rejects a stale aWETH approval before flash loan", async function () {
      const { positionOwner, repayer, aWeth, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);

      await pool.setFlashLoanPremiumTotal(100);
      const freshPreview = await repayer.previewEmergency();
      expect(freshPreview.worstCaseCollateralNeeded).to.be.gt(preview.worstCaseCollateralNeeded);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(preview.worstCaseCollateralNeeded, freshPreview.worstCaseCollateralNeeded);
      expect(await pool.lastFlashAmount()).to.equal(0n);
    });

    it("rechecks the current oracle after preview and rejects stale collateral approval if WETH price worsens", async function () {
      const { positionOwner, repayer, aWeth, pool, oracle, weth, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);

      await oracle.setPrice(await weth.getAddress(), 1_000n * 10n ** 8n);
      const freshPreview = await repayer.previewEmergency();
      expect(freshPreview.worstCaseCollateralNeeded).to.be.gt(preview.worstCaseCollateralNeeded);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(preview.worstCaseCollateralNeeded, freshPreview.worstCaseCollateralNeeded);
      expect(await pool.lastFlashAmount()).to.equal(0n);
    });

    it("reverts before flash loan when owner aWETH balance is insufficient", async function () {
      const { positionOwner, repayer, aWeth, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition(ethers.parseEther("1"), DEBT);
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), ethers.MaxUint256);
      const preview = await repayer.previewEmergency();

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenBalance")
        .withArgs(ethers.parseEther("1"), preview.worstCaseCollateralNeeded);
    });

    it("requires worst-case owner balance even when expected collateral would be available", async function () {
      const { positionOwner, repayer, aWeth, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition(ethers.parseEther("4.01"), DEBT);
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), ethers.MaxUint256);
      const preview = await repayer.previewEmergency();
      const ownerBalance = await aWeth.balanceOf(positionOwner.address);

      expect(ownerBalance).to.be.gt(preview.expectedCollateralNeeded);
      expect(ownerBalance).to.be.lt(preview.worstCaseCollateralNeeded);
      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InsufficientOwnerATokenBalance")
        .withArgs(ownerBalance, preview.worstCaseCollateralNeeded);
    });

    it("atomically repays owner debt, pulls exact aWETH, withdraws WETH, and leaves owner collateral residual", async function () {
      const {
        positionOwner,
        keeper,
        repayer,
        weth,
        usdc,
        aWeth,
        variableDebtUsdc,
        router,
        pool,
        preview,
      } = await openApproveAndTrigger();
      const repayerAddress = await repayer.getAddress();
      const fairWethSpent = await repayer.oracleWethForUsdc(DEBT + BUFFER);
      const premium = (preview.maxFlashWeth * 5n + 9_999n) / 10_000n;
      const aWethPulled = fairWethSpent + premium;
      const ownerUsdcBefore = await usdc.balanceOf(positionOwner.address);

      const tx = repayer.connect(keeper).checkAndRepay();

      await expect(tx)
        .to.emit(repayer, "EmergencyRepayStarted")
        .withArgs(positionOwner.address, HF_DANGER, DEBT, preview.maxFlashWeth);
      await expect(tx)
        .to.emit(repayer, "EmergencyRepayCompleted")
        .withArgs(positionOwner.address, DEBT, fairWethSpent, aWethPulled, premium, TEN_WETH - aWethPulled, 0n);

      expect(await pool.lastFlashAsset()).to.equal(await weth.getAddress());
      expect(await pool.lastFlashAmount()).to.equal(preview.maxFlashWeth);
      expect(await router.lastExactOutputAmountOut()).to.equal(DEBT + BUFFER);
      expect(await router.lastExactOutputAmountInMaximum()).to.equal(preview.maxFlashWeth);
      expect(await pool.lastRepayOnBehalfOf()).to.equal(positionOwner.address);
      expect(await pool.lastRepayAmount()).to.equal(DEBT + BUFFER);
      expect(await pool.withdrawBeforeRepay()).to.equal(false);
      expect(await pool.lastWithdrawCaller()).to.equal(repayerAddress);
      expect(await pool.lastWithdrawAmount()).to.equal(aWethPulled);

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH - aWethPulled);
      expect(await aWeth.balanceOf(repayerAddress)).to.equal(0n);
      expect(await aWeth.allowance(positionOwner.address, repayerAddress))
        .to.equal(preview.worstCaseCollateralNeeded - aWethPulled);
      expect(await variableDebtUsdc.balanceOf(repayerAddress)).to.equal(0n);
      expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
      expect(await usdc.balanceOf(repayerAddress)).to.equal(0n);
      expect(await usdc.balanceOf(positionOwner.address)).to.equal(ownerUsdcBefore + BUFFER);
      expect(await weth.allowance(repayerAddress, await router.getAddress())).to.equal(0n);
      expect(await usdc.allowance(repayerAddress, await pool.getAddress())).to.equal(0n);
      expect(await weth.allowance(repayerAddress, await pool.getAddress())).to.equal(0n);
    });

    it("accepts Aave repaying less than the buffered target when the owner's debt is fully cleared", async function () {
      const { positionOwner, repayer, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      const smallDebt = ethers.parseUnits("1000", 6);
      await openOwnerPosition(TEN_WETH, smallDebt);
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);

      const fairWethSpent = await repayer.oracleWethForUsdc(smallDebt + BUFFER);
      const premium = await repayer.flashPremiumFor(preview.maxFlashWeth);
      const aWethPulled = fairWethSpent + premium;

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.emit(repayer, "EmergencyRepayCompleted")
        .withArgs(positionOwner.address, smallDebt, fairWethSpent, aWethPulled, premium, TEN_WETH - aWethPulled, 0n);

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
      expect(smallDebt).to.be.lt(smallDebt + BUFFER);
    });

    it("sweeps the unused USDC repay buffer to POSITION_OWNER after the debt is cleared", async function () {
      const { positionOwner, repayer, usdc, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      const smallDebt = ethers.parseUnits("1000", 6);
      await openOwnerPosition(TEN_WETH, smallDebt);
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      const ownerUsdcBefore = await usdc.balanceOf(positionOwner.address);

      await repayer.connect(positionOwner).forceRepayAll();

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
      expect(await usdc.balanceOf(positionOwner.address)).to.equal(ownerUsdcBefore + BUFFER);
      expect(await usdc.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("succeeds at a worse-but-allowed swap price and pulls no more than worst-case collateral", async function () {
      const { positionOwner, repayer, router, aWeth, variableDebtUsdc, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await router.setUsdcPerWeth(1_970n * 10n ** 6n);
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);

      await repayer.connect(positionOwner).forceRepayAll();

      const pulledCollateral = await pool.lastWithdrawAmount();
      expect(pulledCollateral).to.be.gt(preview.expectedCollateralNeeded);
      expect(pulledCollateral).to.be.lte(preview.worstCaseCollateralNeeded);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH - pulledCollateral);
    });

    it("accepts slight aWETH and withdraw overages, reports real aWETH pulled, and sweeps extra WETH", async function () {
      const { positionOwner, repayer, weth, aWeth, variableDebtUsdc, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);

      const fairWethSpent = await repayer.oracleWethForUsdc(DEBT + BUFFER);
      const premium = await repayer.flashPremiumFor(preview.maxFlashWeth);
      const collateralToWithdraw = fairWethSpent + premium;
      const aWethBonus = 2n;
      const withdrawBonus = 3n;
      const ownerWethBefore = await weth.balanceOf(positionOwner.address);
      await aWeth.setTransferFromBonus(aWethBonus);
      await pool.setWithdrawBonus(withdrawBonus);

      const tx = repayer.connect(positionOwner).forceRepayAll();
      await expect(tx)
        .to.emit(repayer, "EmergencyRepayCompleted")
        .withArgs(
          positionOwner.address,
          DEBT,
          fairWethSpent,
          collateralToWithdraw + aWethBonus,
          premium,
          TEN_WETH - collateralToWithdraw - aWethBonus,
          0n,
        );

      expect(await pool.lastWithdrawAmount()).to.equal(collateralToWithdraw + aWethBonus + withdrawBonus);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH - collateralToWithdraw - aWethBonus);
      expect(await aWeth.balanceOf(await repayer.getAddress())).to.equal(0n);
      expect(await weth.balanceOf(positionOwner.address)).to.equal(ownerWethBefore + aWethBonus + withdrawBonus);
      expect(await weth.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("sends pre-existing loose WETH and USDC only to POSITION_OWNER after a keeper execution", async function () {
      const { positionOwner, keeper, repayer, weth, usdc } = await openApproveAndTrigger();
      const repayerAddress = await repayer.getAddress();
      const wethDust = ethers.parseEther("0.25");
      const usdcDust = ethers.parseUnits("77", 6);
      await weth.mint(repayerAddress, wethDust);
      await usdc.mint(repayerAddress, usdcDust);
      const ownerWethBefore = await weth.balanceOf(positionOwner.address);
      const ownerUsdcBefore = await usdc.balanceOf(positionOwner.address);

      await repayer.connect(keeper).checkAndRepay();

      expect(await weth.balanceOf(positionOwner.address)).to.equal(ownerWethBefore + wethDust);
      expect(await usdc.balanceOf(positionOwner.address)).to.equal(ownerUsdcBefore + BUFFER + usdcDust);
      expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
      expect(await usdc.balanceOf(repayerAddress)).to.equal(0n);
    });

    it("does not let pre-existing USDC dust mask a router shortpay", async function () {
      const { positionOwner, repayer, router, usdc, aWeth, variableDebtUsdc, approveWorstCaseCollateral, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();
      const repayerAddress = await repayer.getAddress();
      const usdcDust = ethers.parseUnits("25", 6);
      await usdc.mint(repayerAddress, usdcDust);
      await router.setUsdcShortfall(1n);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "UnexpectedUsdcReceived")
        .withArgs(DEBT + BUFFER - 1n, DEBT + BUFFER);

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
      expect(await usdc.balanceOf(repayerAddress)).to.equal(usdcDust);
    });

    it("can use pre-existing WETH dust to cover a router underreported WETH spend without trapping funds", async function () {
      const { positionOwner, repayer, router, weth, aWeth, variableDebtUsdc, pool, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      const repayerAddress = await repayer.getAddress();
      const fairWethSpent = await repayer.oracleWethForUsdc(DEBT + BUFFER);
      const underreportedWeth = ethers.parseEther("0.1");
      const premium = await repayer.flashPremiumFor(preview.maxFlashWeth);
      const aWethPulled = fairWethSpent - underreportedWeth + premium;
      await weth.mint(repayerAddress, underreportedWeth);
      await router.setUnderreportWeth(underreportedWeth);

      await repayer.connect(positionOwner).forceRepayAll();

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
      expect(await pool.lastWithdrawAmount()).to.equal(aWethPulled);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH - aWethPulled);
      expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
    });

    it("reverts atomically when swap price exceeds the oracle slippage ceiling", async function () {
      const { positionOwner, repayer, router, aWeth, variableDebtUsdc, approveMaxCollateral, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveMaxCollateral();
      await router.setUsdcPerWeth(1_500n * 10n ** 6n);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll()).to.be.revertedWith("TOO_MUCH_IN");

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
      expect(await aWeth.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("reverts atomically if the router reports exact output but sends less USDC than requested", async function () {
      const { positionOwner, repayer, router, aWeth, variableDebtUsdc, approveWorstCaseCollateral, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();
      await router.setUsdcShortfall(1n);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "UnexpectedUsdcReceived")
        .withArgs(DEBT + BUFFER - 1n, DEBT + BUFFER);

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
      expect(await aWeth.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("reverts atomically if owner aWETH transferFrom fails after repay", async function () {
      const { positionOwner, repayer, aWeth, variableDebtUsdc, approveWorstCaseCollateral, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();
      await aWeth.setFailTransferFrom(true);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll()).to.be.revertedWith("TRANSFER_FROM_FAILED");

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
      expect(await aWeth.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("reverts atomically if Aave withdraw reverts or returns less WETH than requested", async function () {
      const fixture = await networkHelpers.loadFixture(deployFixture);
      await fixture.openOwnerPosition();
      await fixture.approveWorstCaseCollateral();
      const ownerAWethBefore = await fixture.aWeth.balanceOf(fixture.positionOwner.address);

      await fixture.pool.setForceWithdrawRevert(true);
      await expect(fixture.repayer.connect(fixture.positionOwner).forceRepayAll())
        .to.be.revertedWith("WITHDRAW_REVERT");
      expect(await fixture.variableDebtUsdc.balanceOf(fixture.positionOwner.address)).to.equal(DEBT);
      expect(await fixture.aWeth.balanceOf(fixture.positionOwner.address)).to.equal(ownerAWethBefore);

      await fixture.pool.setForceWithdrawRevert(false);
      await fixture.pool.setWithdrawShortfall(1n);
      await expect(fixture.repayer.connect(fixture.positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(fixture.repayer, "UnexpectedWithdrawAmount");
      expect(await fixture.variableDebtUsdc.balanceOf(fixture.positionOwner.address)).to.equal(DEBT);
      expect(await fixture.aWeth.balanceOf(fixture.positionOwner.address)).to.equal(ownerAWethBefore);
    });

    it("reverts if Aave withdraw returns less WETH than the actual aWETH pulled", async function () {
      const { positionOwner, repayer, aWeth, pool, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);

      const fairWethSpent = await repayer.oracleWethForUsdc(DEBT + BUFFER);
      const premium = await repayer.flashPremiumFor(preview.maxFlashWeth);
      const collateralToWithdraw = fairWethSpent + premium;
      const aWethBonus = 2n;
      const withdrawShortfall = 1n;
      await aWeth.setTransferFromBonus(aWethBonus);
      await pool.setWithdrawShortfall(withdrawShortfall);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "UnexpectedWithdrawAmount")
        .withArgs(
          collateralToWithdraw + aWethBonus - withdrawShortfall,
          collateralToWithdraw + aWethBonus,
        );
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
    });

    it("reverts atomically when any owner debt remains after repay", async function () {
      const { positionOwner, repayer, pool, aWeth, variableDebtUsdc, approveWorstCaseCollateral, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();
      await pool.setRepayDustToLeave(100n);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "DebtRemains")
        .withArgs(100n);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
    });

    it("covers debt growth inside the USDC repay buffer", async function () {
      const { positionOwner, repayer, pool, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      await pool.setDebtIncreaseBeforeRepay(BUFFER - 1n);

      await repayer.connect(positionOwner).forceRepayAll();

      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);
    });

    it("reverts atomically when debt grows beyond the USDC repay buffer", async function () {
      const { positionOwner, repayer, pool, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      await pool.setDebtIncreaseBeforeRepay(BUFFER + 100n);
      const ownerAWethBefore = await aWeth.balanceOf(positionOwner.address);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "DebtRemains")
        .withArgs(100n);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(ownerAWethBefore);
    });

    it("rechecks owner aWETH allowance and balance immediately before transferFrom", async function () {
      const fixture = await networkHelpers.loadFixture(deployFixture);
      await fixture.openOwnerPosition();
      let preview = await fixture.repayer.previewEmergency();
      const actualCollateral = preview.expectedCollateralNeeded;
      await fixture.aWeth
        .connect(fixture.positionOwner)
        .approve(await fixture.repayer.getAddress(), preview.worstCaseCollateralNeeded);
      await fixture.pool.setATokenAllowanceOnRepay(actualCollateral - 1n, true);

      await expect(fixture.repayer.connect(fixture.positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(fixture.repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(actualCollateral - 1n, actualCollateral);
      expect(await fixture.variableDebtUsdc.balanceOf(fixture.positionOwner.address)).to.equal(DEBT);
      expect(await fixture.aWeth.balanceOf(fixture.positionOwner.address)).to.equal(TEN_WETH);

      const fresh = await networkHelpers.loadFixture(deployFixture);
      await fresh.openOwnerPosition();
      preview = await fresh.repayer.previewEmergency();
      const freshActualCollateral = preview.expectedCollateralNeeded;
      await fresh.aWeth
        .connect(fresh.positionOwner)
        .approve(await fresh.repayer.getAddress(), preview.worstCaseCollateralNeeded);
      await fresh.pool.setATokenBurnOnRepay(TEN_WETH - freshActualCollateral + 1n);

      await expect(fresh.repayer.connect(fresh.positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(fresh.repayer, "InsufficientOwnerATokenBalance")
        .withArgs(freshActualCollateral - 1n, freshActualCollateral);
      expect(await fresh.variableDebtUsdc.balanceOf(fresh.positionOwner.address)).to.equal(DEBT);
      expect(await fresh.aWeth.balanceOf(fresh.positionOwner.address)).to.equal(TEN_WETH);
    });

    it("reverts atomically if aWETH transferFrom reports success but transfers too little", async function () {
      const { positionOwner, repayer, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();
      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      await aWeth.setTransferFromShortfall(1n);

      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "UnexpectedATokenTransferAmount")
        .withArgs(preview.expectedCollateralNeeded - 1n, preview.expectedCollateralNeeded);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
      expect(await aWeth.balanceOf(positionOwner.address)).to.equal(TEN_WETH);
      expect(await aWeth.balanceOf(await repayer.getAddress())).to.equal(0n);
    });

    it("rejects forged callbacks, wrong initiator, wrong asset, and malformed params", async function () {
      const { positionOwner, stranger, repayer, pool, weth, variableDebtUsdc, approveWorstCaseCollateral, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      await approveWorstCaseCollateral();

      await expect(
        repayer
          .connect(stranger)
          .executeOperation(await weth.getAddress(), 1n, 0n, await repayer.getAddress(), "0x"),
      ).to.be.revertedWithCustomError(repayer, "InvalidFlashCallback");
      await expect(
        pool.callExecuteOperation(
          await repayer.getAddress(),
          await weth.getAddress(),
          1n,
          0n,
          stranger.address,
          "0x",
        ),
      ).to.be.revertedWithCustomError(repayer, "InvalidFlashCallback");

      await pool.setCallbackWrongAsset(true);
      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InvalidFlashCallback");
      await pool.setCallbackWrongAsset(false);

      await pool.setCallbackWrongInitiator(true);
      await expect(repayer.connect(positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(repayer, "InvalidFlashCallback");
      await pool.setCallbackWrongInitiator(false);

      await pool.setCallbackMalformedParams(true);
      await expect(repayer.connect(positionOwner).forceRepayAll()).to.be.revert(ethers);
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(DEBT);
    });

    it("limited aWETH approval works if it covers worst-case collateral, and revoking disables the airbag", async function () {
      const { positionOwner, repayer, aWeth, variableDebtUsdc, openOwnerPosition } =
        await networkHelpers.loadFixture(deployFixture);
      await openOwnerPosition();
      const preview = await repayer.previewEmergency();

      await aWeth.connect(positionOwner).approve(await repayer.getAddress(), preview.worstCaseCollateralNeeded);
      await repayer.connect(positionOwner).forceRepayAll();
      expect(await variableDebtUsdc.balanceOf(positionOwner.address)).to.equal(0n);

      const fresh = await networkHelpers.loadFixture(deployFixture);
      await fresh.openOwnerPosition();
      const freshPreview = await fresh.repayer.previewEmergency();
      await fresh.aWeth
        .connect(fresh.positionOwner)
        .approve(await fresh.repayer.getAddress(), freshPreview.worstCaseCollateralNeeded);
      await fresh.aWeth.connect(fresh.positionOwner).approve(await fresh.repayer.getAddress(), 0n);
      await expect(fresh.repayer.connect(fresh.positionOwner).forceRepayAll())
        .to.be.revertedWithCustomError(fresh.repayer, "InsufficientOwnerATokenAllowance")
        .withArgs(0n, freshPreview.worstCaseCollateralNeeded);
    });

    for (const [mode, label] of [
      [1, "sweepWeth"],
      [2, "sweepUsdc"],
      [3, "forceRepayAll"],
      [4, "checkAndRepay"],
      [5, "executeOperation"],
      [6, "deleted deleverWithCollateral"],
      [7, "sweepEth"],
      [8, "setUpperHealthFactor"],
      [9, "setUpperHealthFactor with a valid-looking value"],
    ] as const) {
      it(`does not let a malicious router reenter ${label} during the swap`, async function () {
        const { keeper, repayer, router, variableDebtUsdc } = await openApproveAndTrigger();
        await router.setReentryAttack(await repayer.getAddress(), mode);

        await repayer.connect(keeper).checkAndRepay();

        expect(await router.lastReentrySuccess()).to.equal(false);
        expect(await variableDebtUsdc.balanceOf(await repayer.POSITION_OWNER())).to.equal(0n);
      });
    }
  });

  describe("fixed-destination dust recovery", function () {
    it("lets only POSITION_OWNER sweep loose WETH, USDC, and native ETH to itself", async function () {
      const { positionOwner, stranger, repayer, weth, usdc } =
        await networkHelpers.loadFixture(deployFixture);
      const repayerAddress = await repayer.getAddress();
      const wethDust = ethers.parseEther("0.2");
      const usdcDust = ethers.parseUnits("50", 6);
      const ethDust = ethers.parseEther("0.05");
      await weth.mint(repayerAddress, wethDust);
      await usdc.mint(repayerAddress, usdcDust);
      await networkHelpers.setBalance(repayerAddress, ethDust);

      await expect(repayer.connect(stranger).sweepWeth())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      await expect(repayer.connect(stranger).sweepUsdc())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      await expect(repayer.connect(stranger).sweepEth())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");

      const wethBefore = await weth.balanceOf(positionOwner.address);
      const usdcBefore = await usdc.balanceOf(positionOwner.address);
      await repayer.connect(positionOwner).sweepWeth();
      await repayer.connect(positionOwner).sweepUsdc();
      await expect(repayer.connect(positionOwner).sweepEth())
        .to.changeEtherBalances(ethers, [repayer, positionOwner], [-ethDust, ethDust]);

      expect(await weth.balanceOf(positionOwner.address)).to.equal(wethBefore + wethDust);
      expect(await usdc.balanceOf(positionOwner.address)).to.equal(usdcBefore + usdcDust);
      expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
      expect(await usdc.balanceOf(repayerAddress)).to.equal(0n);
      expect(await ethers.provider.getBalance(repayerAddress)).to.equal(0n);
    });

    it("does not accept native ETH through a plain transfer", async function () {
      const { positionOwner, repayer } = await networkHelpers.loadFixture(deployFixture);
      const repayerAddress = await repayer.getAddress();

      await expect(positionOwner.sendTransaction({ to: repayerAddress, value: 1n })).to.be.revert(ethers);
      expect(await ethers.provider.getBalance(repayerAddress)).to.equal(0n);
    });

    it("reverts sweepEth without losing forced ETH if POSITION_OWNER rejects native ETH", async function () {
      const { config } = await networkHelpers.loadFixture(deployFixture);
      const rejectingOwner = await ethers.deployContract("RejectingEthOwner");
      const repayer = await ethers.deployContract("AaveEmergencyRepayer", [
        { ...config, positionOwner: await rejectingOwner.getAddress() },
      ]);
      const repayerAddress = await repayer.getAddress();
      const ethDust = ethers.parseEther("0.05");
      await networkHelpers.setBalance(repayerAddress, ethDust);

      await expect(rejectingOwner.callSweepEth(repayerAddress))
        .to.be.revertedWithCustomError(repayer, "NativeEthSweepFailed");
      expect(await ethers.provider.getBalance(repayerAddress)).to.equal(ethDust);
    });

    it("keeps ETH, USDC, and WETH recovery fixed to POSITION_OWNER during sweepEth reentry", async function () {
      const { config, weth, usdc } = await networkHelpers.loadFixture(deployFixture);
      const reenteringOwner = await ethers.deployContract("ReenteringEthOwner");
      const repayer = await ethers.deployContract("AaveEmergencyRepayer", [
        { ...config, positionOwner: await reenteringOwner.getAddress() },
      ]);
      const ownerAddress = await reenteringOwner.getAddress();
      const repayerAddress = await repayer.getAddress();
      const wethDust = ethers.parseEther("0.2");
      const usdcDust = ethers.parseUnits("50", 6);
      const ethDust = ethers.parseEther("0.05");
      await weth.mint(repayerAddress, wethDust);
      await usdc.mint(repayerAddress, usdcDust);
      await networkHelpers.setBalance(repayerAddress, ethDust);

      await expect(reenteringOwner.callSweepEth(repayerAddress))
        .to.changeEtherBalances(ethers, [repayer, reenteringOwner], [-ethDust, ethDust]);

      expect(await reenteringOwner.reentered()).to.equal(true);
      expect(await weth.balanceOf(ownerAddress)).to.equal(wethDust);
      expect(await usdc.balanceOf(ownerAddress)).to.equal(usdcDust);
      expect(await weth.balanceOf(repayerAddress)).to.equal(0n);
      expect(await usdc.balanceOf(repayerAddress)).to.equal(0n);
      expect(await ethers.provider.getBalance(repayerAddress)).to.equal(0n);
    });

    it("does not let the keeper move loose funds directly", async function () {
      const { keeper, repayer, weth, usdc } = await networkHelpers.loadFixture(deployFixture);
      await weth.mint(await repayer.getAddress(), ethers.parseEther("1"));
      await usdc.mint(await repayer.getAddress(), ethers.parseUnits("1", 6));
      await networkHelpers.setBalance(await repayer.getAddress(), ethers.parseEther("0.01"));

      await expect(repayer.connect(keeper).sweepWeth())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      await expect(repayer.connect(keeper).sweepUsdc())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      await expect(repayer.connect(keeper).sweepEth())
        .to.be.revertedWithCustomError(repayer, "Unauthorized");
      expect(await weth.balanceOf(await repayer.getAddress())).to.equal(ethers.parseEther("1"));
      expect(await usdc.balanceOf(await repayer.getAddress())).to.equal(ethers.parseUnits("1", 6));
      expect(await ethers.provider.getBalance(await repayer.getAddress())).to.equal(ethers.parseEther("0.01"));
    });
  });
});
