import { network } from "hardhat";
import { ARBITRUM } from "./addresses.js";
import { printVerifiedUniswapPool, verifyConfiguredUniswapPool } from "./uniswap-pool.js";

const { ethers } = await network.create();

const provider = ethers.provider;
const networkInfo = await provider.getNetwork();
if (networkInfo.chainId !== ARBITRUM.chainId) {
  throw new Error(`Expected Arbitrum chainId 42161, got ${networkInfo.chainId}`);
}

const addresses = Object.entries(ARBITRUM).filter(([, value]) => typeof value === "string");
for (const [name, address] of addresses) {
  const code = await provider.getCode(address as string);
  if (code === "0x") throw new Error(`${name} has no contract code at ${address}`);
  console.log(`${name}: ${address} (${(code.length - 2) / 2} bytes)`);
}

const aavePool = new ethers.Contract(
  ARBITRUM.AAVE_POOL,
  ["function ADDRESSES_PROVIDER() view returns (address)"],
  provider,
);
const addressesProvider = await aavePool.ADDRESSES_PROVIDER();
const addressesProviderCode = await provider.getCode(addressesProvider);
if (addressesProviderCode === "0x") {
  throw new Error(`Aave ADDRESSES_PROVIDER has no contract code at ${addressesProvider}`);
}
console.log(
  `AAVE_ADDRESSES_PROVIDER: ${addressesProvider} (${(addressesProviderCode.length - 2) / 2} bytes)`,
);

const providerContract = new ethers.Contract(
  addressesProvider,
  ["function getPriceOracle() view returns (address)"],
  provider,
);
const currentOracle = await providerContract.getPriceOracle();
const currentOracleCode = await provider.getCode(currentOracle);
if (currentOracleCode === "0x") {
  throw new Error(`Current Aave oracle has no contract code at ${currentOracle}`);
}
console.log(`CURRENT_AAVE_ORACLE: ${currentOracle} (${(currentOracleCode.length - 2) / 2} bytes)`);

const verifiedPool = await verifyConfiguredUniswapPool(provider, {
  swapRouter: ARBITRUM.UNISWAP_V3_SWAP_ROUTER,
  weth: ARBITRUM.WETH,
  usdc: ARBITRUM.USDC,
  uniswapPool: ARBITRUM.UNISWAP_WETH_USDC_500_POOL,
  uniswapPoolFee: ARBITRUM.UNISWAP_WETH_USDC_500_FEE,
});
printVerifiedUniswapPool(verifiedPool);
