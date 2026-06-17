import "dotenv/config";
import { network } from "hardhat";
import { repayerAddress } from "./config.js";

const { ethers } = await network.create();
const privateKey = process.env.KEEPER_PRIVATE_KEY;
if (!privateKey) throw new Error("Missing KEEPER_PRIVATE_KEY");
const keeper = new ethers.Wallet(privateKey, ethers.provider);
const repayer = await ethers.getContractAt("AaveEmergencyRepayer", repayerAddress(), keeper);

const [
  hf,
  debtUsdc,
  usdcTarget,
  maxFlashWeth,
  expectedCollateralNeeded,
  worstCaseCollateralNeeded,
  ownerAWethBalance,
  ownerAWethAllowance,
  triggerReached,
  sufficientlyFunded,
  sufficientlyApproved,
  readyToExecute,
] =
  await repayer.previewEmergency();

console.log({
  keeper: keeper.address,
  repayer: await repayer.getAddress(),
  positionOwner: await repayer.POSITION_OWNER(),
  healthFactor: ethers.formatUnits(hf, 18),
  debtUsdc: ethers.formatUnits(debtUsdc, 6),
  usdcTarget: ethers.formatUnits(usdcTarget, 6),
  maxFlashWeth: ethers.formatEther(maxFlashWeth),
  expectedCollateralNeeded: ethers.formatEther(expectedCollateralNeeded),
  worstCaseCollateralNeeded: ethers.formatEther(worstCaseCollateralNeeded),
  ownerAWethBalance: ethers.formatEther(ownerAWethBalance),
  ownerAWethAllowance: ethers.formatEther(ownerAWethAllowance),
  triggerReached,
  sufficientlyFunded,
  sufficientlyApproved,
  readyToExecute,
});

if (!triggerReached) {
  console.log("No action: trigger has not been reached.");
  process.exit(0);
}

if (!sufficientlyFunded) {
  console.log("No action: POSITION_OWNER aWETH balance is insufficient for worst-case collateral.");
  process.exit(0);
}

if (!sufficientlyApproved) {
  console.log("No action: POSITION_OWNER aWETH allowance is insufficient for worst-case collateral.");
  process.exit(0);
}

const tx = await repayer.checkAndRepay({
  gasLimit: BigInt(process.env.KEEPER_GAS_LIMIT ?? "2500000"),
});
console.log("Submitted:", tx.hash);
const receipt = await tx.wait();
console.log("Confirmed in block:", receipt?.blockNumber);
