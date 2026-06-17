# Security notes

## Trusted external contracts

The emergency controller intentionally depends on only:

1. the configured Aave V3 Pool;
2. the Aave addresses provider returned by the configured Pool;
3. the current Aave Oracle returned by that provider;
4. the configured Uniswap V3 SwapRouter;
5. the explicitly configured WETH/USDC pool verified against the SwapRouter factory and immutable fee tier;
6. canonical WETH, aWETH, native USDC and variable-debt USDC tokens.

There is no ParaSwap, Augustus, generic aggregator, proxy, upgradeable controller, arbitrary external call, dynamic route, or caller-provided calldata.

## Critical invariants

- `POSITION_OWNER` owns the Aave position.
- The contract normally owns no aWETH and no variable USDC debt.
- Only keeper or `POSITION_OWNER` can call `checkAndRepay()`.
- `checkAndRepay()` has no parameters.
- Only `POSITION_OWNER` can call `forceRepayAll()` and sweeps.
- Emergency execution is blocked while `POSITION_OWNER` Aave HF is above the trigger.
- Only WETH can be flash-borrowed.
- Only WETH can be sold and only native USDC can be received.
- The swap recipient is the controller itself.
- The controller verifies that the swap increased its USDC balance by at least the exact repay target.
- Debt repayment is `onBehalfOf = POSITION_OWNER`.
- Any remaining native-USDC variable debt after repayment reverts.
- The controller pulls aWETH only after debt repayment and debt verification.
- The controller rechecks owner aWETH balance and allowance immediately before pulling.
- Pre-flight balance and allowance must cover worst-case collateral: `maxFlashWeth + maxPremium`.
- The aWETH transfer requests `wethSpent + flashPremium`; if aToken rounding makes the received amount slightly higher, the higher received amount is withdrawn and reported.
- The controller verifies that the Aave withdraw returned at least the full aWETH amount received by the controller.
- All WETH/USDC dust goes only to `POSITION_OWNER`.

## Principal failure modes

### Missing aWETH allowance

The emergency path requires prior `aWETH.approve(emergencyContract, amount)` by `POSITION_OWNER`. The allowance must cover `previewEmergency().worstCaseCollateralNeeded`; approving only the oracle-expected collateral is intentionally insufficient. Revoking allowance to zero disables the airbag.

### Keeper unavailable

The emergency transaction is not autonomous. RPC outage, server failure, insufficient gas, nonce problems, or a lost keeper key can prevent execution. `POSITION_OWNER` remains able to call `checkAndRepay()` and `forceRepayAll()`.

### Aave liquidation

If HF falls below Aave liquidation before this transaction lands, third-party liquidators can liquidate via Aave. This is protocol behavior, not a controller withdrawal path.

### Fixed Uniswap pool unavailable

If the configured pool has insufficient liquidity or exceeds `MAX_SLIPPAGE_BPS` relative to Aave's oracle, the operation reverts instead of accepting an unlimited price.
The deployment cap for `MAX_SLIPPAGE_BPS` is 500.

### Oracle/market dislocation

The current Aave Oracle, resolved through Aave's addresses provider, is used for the HF trigger and maximum swap input. A rapid DEX/oracle divergence can cause the transaction to revert.

### Additional assets in the Aave account

The controller is designed for a dedicated `POSITION_OWNER` EOA with WETH collateral and native-USDC variable debt. Additional collateral or debt on the same Aave account can make account-level HF and debt economics different even if the calls still execute.

### Configuration error

All important values are immutable. A wrong `POSITION_OWNER`, keeper, token, router, pool, fee tier, trigger, slippage or debt token requires redeployment and a new aWETH approval. The current oracle is intentionally resolved from Aave's addresses provider instead of being configured directly.
`USDC_REPAY_BUFFER` is immutable, must be greater than zero, and is capped at 10 native USDC.

## Review recommendations

- run unit, coverage, and fork tests;
- inspect every constructor value in deployment output;
- verify the Aave addresses provider and current oracle printed by deployment/verification scripts;
- compare addresses against official registries;
- test with a small EOA-owned Aave position first;
- verify aWETH allowance from the owner wallet;
- simulate adverse DEX/oracle divergence;
- use a private transaction endpoint for emergency execution where possible;
- monitor `POSITION_OWNER` HF and keeper ETH balance independently.
