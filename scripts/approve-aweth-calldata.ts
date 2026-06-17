import "dotenv/config";
import { ethers } from "ethers";
import { ARBITRUM } from "./addresses.js";
import { repayerAddress } from "./config.js";

const amountArg = process.env.AWETH_APPROVAL_AMOUNT ?? "max";
const amount = amountArg === "max"
  ? ethers.MaxUint256
  : ethers.parseEther(amountArg);

const iface = new ethers.Interface([
  "function approve(address spender,uint256 amount) returns (bool)",
]);
const calldata = iface.encodeFunctionData("approve", [repayerAddress(), amount]);

console.log({
  to: ARBITRUM.A_WETH,
  spender: repayerAddress(),
  amount: amount.toString(),
  calldata,
});
