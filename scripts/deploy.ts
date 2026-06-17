import "dotenv/config";
import { network } from "hardhat";
import { deploymentConfig } from "./config.js";
import { printVerifiedUniswapPool, verifyConfiguredUniswapPool } from "./uniswap-pool.js";

const { ethers } = await network.create();
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey) throw new Error("Missing DEPLOYER_PRIVATE_KEY");
const deployer = new ethers.Wallet(privateKey, ethers.provider);
const config = deploymentConfig();

console.log("Deployer:", deployer.address);
console.log("Immutable config:", config);

const verifiedPool = await verifyConfiguredUniswapPool(ethers.provider, config);
printVerifiedUniswapPool(verifiedPool);

const repayer = await ethers.deployContract("AaveEmergencyRepayer", [config], deployer);
await repayer.waitForDeployment();

const addressesProvider = await repayer.ADDRESSES_PROVIDER();
const addressesProviderCode = await ethers.provider.getCode(addressesProvider);
if (addressesProviderCode === "0x") {
  throw new Error(`Aave addresses provider has no code at ${addressesProvider}`);
}
const providerContract = new ethers.Contract(
  addressesProvider,
  ["function getPriceOracle() view returns (address)"],
  ethers.provider,
);
const currentOracle = await providerContract.getPriceOracle();
const currentOracleCode = await ethers.provider.getCode(currentOracle);
if (currentOracleCode === "0x") {
  throw new Error(`Current Aave oracle has no code at ${currentOracle}`);
}

console.log("AaveEmergencyRepayer:", await repayer.getAddress());
console.log("Aave addresses provider:", addressesProvider);
console.log("Current Aave oracle:", currentOracle);
console.log("Configured Uniswap pool:", await repayer.UNISWAP_POOL());
console.log("Position owner:", await repayer.POSITION_OWNER());
console.log("Keeper:", await repayer.KEEPER());
