import "dotenv/config";
import { ethers } from "ethers";
import { ARBITRUM } from "./addresses.js";

const MAX_ALLOWED_SLIPPAGE_BPS = 500;
const MAX_USDC_REPAY_BUFFER = ethers.parseUnits("10", 6);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export function deploymentConfig() {
  const positionOwner = ethers.getAddress(required("POSITION_OWNER_ADDRESS"));
  const keeper = ethers.getAddress(required("KEEPER_ADDRESS"));
  if (positionOwner === keeper) {
    throw new Error("POSITION_OWNER_ADDRESS and KEEPER_ADDRESS must be different");
  }
  const maxSlippageBps = Number(process.env.MAX_SLIPPAGE_BPS ?? "300");
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps <= 0 || maxSlippageBps > MAX_ALLOWED_SLIPPAGE_BPS) {
    throw new Error(`MAX_SLIPPAGE_BPS must be an integer between 1 and ${MAX_ALLOWED_SLIPPAGE_BPS}`);
  }
  const usdcRepayBuffer = ethers.parseUnits(process.env.USDC_REPAY_BUFFER ?? "1", 6);
  if (usdcRepayBuffer === 0n || usdcRepayBuffer > MAX_USDC_REPAY_BUFFER) {
    throw new Error("USDC_REPAY_BUFFER must be greater than 0 and at most 10 native USDC");
  }

  return {
    aavePool: ARBITRUM.AAVE_POOL,
    swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
    weth: ARBITRUM.WETH,
    usdc: ARBITRUM.USDC,
    aWeth: ARBITRUM.A_WETH,
    variableDebtUsdc: ARBITRUM.VARIABLE_DEBT_USDC,
    positionOwner,
    keeper,
    uniswapPool: configuredUniswapPool(),
    uniswapPoolFee: Number(process.env.UNISWAP_POOL_FEE ?? "500"),
    maxSlippageBps,
    triggerHealthFactor: ethers.parseUnits(process.env.TRIGGER_HF ?? "1.10", 18),
    usdcRepayBuffer,
  };
}

export function configuredUniswapPool(): string {
  return ethers.getAddress(required("UNISWAP_WETH_USDC_POOL"));
}

export function repayerAddress(): string {
  return ethers.getAddress(required("REPAYER_ADDRESS"));
}
