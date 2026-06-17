import { Contract, ZeroAddress, getAddress, type ContractRunner } from "ethers";

type CodeProvider = ContractRunner & {
  getCode(address: string): Promise<string>;
};

export type UniswapPoolCheckConfig = {
  swapRouter: string;
  weth: string;
  usdc: string;
  uniswapPool: string;
  uniswapPoolFee: number;
};

export type VerifiedUniswapPool = {
  router: string;
  factory: string;
  configuredPool: string;
  derivedPool: string;
  token0: string;
  token1: string;
  fee: number;
  poolFactory: string;
};

const ROUTER_ABI = ["function factory() view returns (address)"];
const FACTORY_ABI = ["function getPool(address,address,uint24) view returns (address)"];
const POOL_ABI = [
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function factory() view returns (address)",
];

async function requireCode(provider: CodeProvider, label: string, address: string) {
  const code = await provider.getCode(address);
  if (code === "0x") throw new Error(`${label} has no contract code at ${address}`);
}

function sameAddress(a: string, b: string) {
  return getAddress(a) === getAddress(b);
}

export async function verifyConfiguredUniswapPool(
  provider: CodeProvider,
  config: UniswapPoolCheckConfig,
): Promise<VerifiedUniswapPool> {
  const routerAddress = getAddress(config.swapRouter);
  const weth = getAddress(config.weth);
  const usdc = getAddress(config.usdc);
  const configuredPool = getAddress(config.uniswapPool);

  if (configuredPool === ZeroAddress) throw new Error("UNISWAP_WETH_USDC_POOL is zero");
  await requireCode(provider, "SwapRouter", routerAddress);
  await requireCode(provider, "Configured Uniswap pool", configuredPool);

  const router = new Contract(routerAddress, ROUTER_ABI, provider);
  const factory = getAddress(await router.factory());
  if (factory === ZeroAddress) throw new Error("SwapRouter factory is zero");
  await requireCode(provider, "SwapRouter factory", factory);

  const uniswapFactory = new Contract(factory, FACTORY_ABI, provider);
  const derivedPool = getAddress(await uniswapFactory.getPool(weth, usdc, config.uniswapPoolFee));
  if (derivedPool !== configuredPool) {
    throw new Error(
      `Configured pool mismatch: factory.getPool(WETH, USDC, ${config.uniswapPoolFee}) returned ${derivedPool}, expected ${configuredPool}`,
    );
  }

  const pool = new Contract(configuredPool, POOL_ABI, provider);
  const token0 = getAddress(await pool.token0());
  const token1 = getAddress(await pool.token1());
  const fee = Number(await pool.fee());
  const poolFactory = getAddress(await pool.factory());

  if (poolFactory !== factory) {
    throw new Error(`Pool factory mismatch: pool.factory() returned ${poolFactory}, expected ${factory}`);
  }
  if (fee !== config.uniswapPoolFee) {
    throw new Error(`Pool fee mismatch: pool.fee() returned ${fee}, expected ${config.uniswapPoolFee}`);
  }
  const validTokens = (sameAddress(token0, weth) && sameAddress(token1, usdc))
    || (sameAddress(token0, usdc) && sameAddress(token1, weth));
  if (!validTokens) {
    throw new Error(`Pool token mismatch: token0=${token0}, token1=${token1}, expected WETH/USDC`);
  }

  return {
    router: routerAddress,
    factory,
    configuredPool,
    derivedPool,
    token0,
    token1,
    fee,
    poolFactory,
  };
}

export function printVerifiedUniswapPool(verified: VerifiedUniswapPool) {
  console.log("Verified Uniswap V3 pool:");
  console.log("  router:", verified.router);
  console.log("  router.factory():", verified.factory);
  console.log("  configured pool:", verified.configuredPool);
  console.log("  factory.getPool():", verified.derivedPool);
  console.log("  pool.token0():", verified.token0);
  console.log("  pool.token1():", verified.token1);
  console.log("  pool.fee():", verified.fee);
  console.log("  pool.factory():", verified.poolFactory);
}
