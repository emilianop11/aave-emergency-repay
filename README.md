# Aave Emergency Repayer — Hardhat 3

Minimal, non-upgradeable emergency controller for an **EOA-owned** Aave V3 WETH/native-USDC position on Arbitrum.

The Aave position always remains in `POSITION_OWNER`:

- `POSITION_OWNER` holds the aWETH collateral;
- `POSITION_OWNER` holds the variable native-USDC debt;
- `POSITION_OWNER` can continue using the official Aave interface normally;
- this contract only performs a full emergency repay when called by `KEEPER` or `POSITION_OWNER`.

There is no supply, borrow, loop, partial delever, or normal withdrawal function in the contract.

## Emergency Flow

```text
keeper calls checkAndRepay()
        ↓
contract reads Aave HF for POSITION_OWNER
        ↓
HF in safe strategy band → revert
HF at/below lower trigger or at/above active upper trigger → continue
        ↓
read POSITION_OWNER variable USDC debt
        ↓
pre-check POSITION_OWNER aWETH balance and allowance
for worst-case collateral consumption
        ↓
flash-borrow WETH from Aave
        ↓
Uniswap V3 exactOutputSingle(WETH → exact USDC target)
        ↓
verify the contract actually received the exact USDC target
        ↓
repay USDC debt onBehalfOf POSITION_OWNER
        ↓
verify remaining POSITION_OWNER debt is exactly zero
        ↓
transfer at least wethSpent + premium aWETH from POSITION_OWNER
        ↓
withdraw the received aWETH to WETH in this contract
        ↓
Aave pulls flash principal + premium
        ↓
remaining aWETH stays in POSITION_OWNER
```

The order is intentional: the contract never takes aWETH before the debt repay succeeds. Any failure reverts the whole transaction.
The pre-check is conservative and requires enough owner aWETH balance/allowance for `maxFlashWeth + maxPremium`; the callback rechecks balance/allowance and requests only the actual `wethSpent + premium`. If aToken rounding makes the received/withdrawn amount slightly higher, the extra WETH is swept to `POSITION_OWNER`.
The callback also validates token balance deltas around the swap and withdraw, so execution does not rely only on external return values.
Loose WETH and USDC are swept to `POSITION_OWNER` after emergency execution. `POSITION_OWNER` can also manually recover loose WETH, USDC, or native ETH through fixed-destination sweep functions; there is still no generic arbitrary-token sweep.

## Security Model

### Immutable

- `POSITION_OWNER`;
- `KEEPER`;
- Aave Pool and Aave addresses provider;
- WETH, aWETH, native USDC and variable-debt native USDC;
- Uniswap V3 SwapRouter, explicit WETH/USDC pool and fee tier;
- trigger Health Factor;
- maximum slippage, capped at 500 bps;
- USDC repay buffer, capped at 10 native USDC.

The lower trigger and all fund-flow parameters are immutable. The upper health-factor trigger starts disabled and can be updated by `KEEPER` or `POSITION_OWNER`; every nonzero value must be at least 5% above the current live Aave HF. There are no upgrades, arbitrary calls, dynamic routes, external calldata, ParaSwap, Augustus, generic token sweeps, or keeper-provided recipients.

The Aave price oracle is not stored as an immutable deployment parameter. The contract resolves the current oracle through `AAVE_POOL.ADDRESSES_PROVIDER().getPriceOracle()` whenever it needs oracle pricing, and rejects a zero or non-contract current oracle.

Deployment also checks that the current oracle behind Aave's addresses provider exists and has contract code, but the oracle address is still not stored.

### Dedicated EOA Assumption

`POSITION_OWNER` should be a dedicated EOA for this strategy:

- WETH/aWETH should be the intended collateral asset;
- native USDC variable debt should be the intended debt asset;
- the same Aave account should not be reused for unrelated collateral/debt unless you explicitly accept that the account-level HF and debt economics can change;
- the emergency path repays the account's native USDC variable debt and consumes approved aWETH collateral from that same account.

### Keeper Authority

The keeper can only call:

```solidity
checkAndRepay()
setUpperHealthFactor(uint256)
```

It cannot choose tokens, amounts, routes, pools, routers, recipients, calldata, slippage, or a withdrawal address. If the keeper key is compromised, it can configure the upper HF trigger only at least 5% above the current live HF, and it can execute `checkAndRepay()` only when the HF is at/below the immutable lower trigger or at/above the active upper trigger.

`POSITION_OWNER` can also call `checkAndRepay()` and can call `forceRepayAll()` before the trigger.

### Upper Health Factor Trigger

`upperHealthFactor` is `0` at deployment, which disables upper-triggered closes. `KEEPER` or `POSITION_OWNER` can set it with:

```solidity
setUpperHealthFactor(newUpperHealthFactor)
```

For any nonzero value, the contract reads the current Aave HF and requires:

```text
newUpperHealthFactor >= currentHF * 1.05
newUpperHealthFactor > lower trigger
```

The same `checkAndRepay()` endpoint is used for polling. It closes the position when HF falls below the lower emergency trigger or rises above the active upper strategy trigger.

### aWETH Allowance

`POSITION_OWNER` arms the airbag by approving aWETH to the deployed contract:

```solidity
aWETH.approve(emergencyContract, allowanceAmount);
```

This approval does not transfer collateral. It only lets the emergency contract pull the exact aWETH amount needed after the debt has already been repaid in the flash-loan callback.

Approve at least `previewEmergency().worstCaseCollateralNeeded`, or approve max if you want the airbag to stay armed as debt and oracle prices move. Approving only `expectedCollateralNeeded` is intentionally insufficient because the actual Uniswap execution may spend up to the configured oracle-plus-slippage flash amount.

To disable the airbag:

```solidity
aWETH.approve(emergencyContract, 0);
```

Generate calldata without using the main private key:

```bash
REPAYER_ADDRESS=0x... AWETH_APPROVAL_AMOUNT=max npm run approve-aweth-calldata
REPAYER_ADDRESS=0x... AWETH_APPROVAL_AMOUNT=0 npm run approve-aweth-calldata
```

Submit the printed calldata to the aWETH contract from a hardware wallet, Arbiscan, or a connected wallet.

## Explicit Uniswap Pool Invariant

The WETH/USDC pool address is configured explicitly as `UNISWAP_WETH_USDC_POOL`.

The constructor verifies:

- router and pool contain code;
- `router.factory()` contains code;
- `factory.getPool(WETH, USDC, fee)` equals the configured pool;
- `pool.factory()` equals `router.factory()`;
- `pool.fee()` equals the configured fee tier;
- `pool.token0()` and `pool.token1()` are exactly WETH and native USDC, in either order.

Runtime swaps still use `SwapRouter.exactOutputSingle()` with immutable token pair and fee.

## Project Structure

```text
contracts/
  AaveEmergencyRepayer.sol
  mocks/Mocks.sol
scripts/
  addresses.ts
  approve-aweth-calldata.ts
  config.ts
  deploy.ts
  keeper-check.ts
  verify-config.ts
test/
  unit/AaveEmergencyRepayer.ts
  fork/AaveEmergencyRepayer.arbitrum.ts
```

## Install

```bash
npm ci
cp .env.example .env
```

## Compile, Test, Coverage

```bash
npm run compile
npm test
npm run typecheck
npm run coverage
```

## Arbitrum Fork Test

Set `ARBITRUM_RPC_URL` and run:

```bash
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc \
UNISWAP_WETH_USDC_POOL=0xC6962004f452bE9203591991D15f6b388e09E8D0 \
npm run test:fork
```

The fork tests create real Aave positions owned by test EOAs. They cover a simple WETH/native-USDC position repaid by keeper `checkAndRepay()`, fixed-destination recovery of loose WETH/USDC/native ETH, a looped position where borrowed USDC is swapped into more WETH collateral and then fully repaid by owner-only `forceRepayAll()`, an upper-HF-triggered close through the same keeper polling endpoint, and looped-position closes by keeper for both lower-HF and upper-HF triggers.

## Current Arbitrum Configuration

- Aave Pool: `0x794a61358D6845594F94dc1DB02A252b5b4814aD`
- Aave price oracle: resolved dynamically from the pool's `ADDRESSES_PROVIDER`
- WETH: `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1`
- aWETH: `0xe50fA9b3c56FfB159cB0FCA61F5c9D750e8128c8`
- native USDC: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- variable-debt native USDC: `0xf611aEb5013fD2c0511c9CD55c7dc5C1140741A6`
- Uniswap V3 SwapRouter: `0xE592427A0AEce92De3Edee1F18E0157C05861564`
- Uniswap V3 WETH/USDC 0.05% pool: `0xC6962004f452bE9203591991D15f6b388e09E8D0`

## Deploy

Populate:

```dotenv
ARBITRUM_RPC_URL=
DEPLOYER_PRIVATE_KEY=
POSITION_OWNER_ADDRESS=
KEEPER_ADDRESS=
UNISWAP_WETH_USDC_POOL=0xC6962004f452bE9203591991D15f6b388e09E8D0
UNISWAP_POOL_FEE=500
MAX_SLIPPAGE_BPS=300
USDC_REPAY_BUFFER=1
```

Verify dependencies:

```bash
npm run verify:arbitrum
```

Deploy:

```bash
npm run deploy:arbitrum
```

After deployment, set:

```dotenv
REPAYER_ADDRESS=
```

Then approve aWETH from `POSITION_OWNER`.

## Keeper

Populate:

```dotenv
ARBITRUM_RPC_URL=
KEEPER_PRIVATE_KEY=
REPAYER_ADDRESS=
```

Run:

```bash
npm run keeper:arbitrum
```

The script first calls `previewEmergency()`. It sends `checkAndRepay()` only when the lower or upper trigger is reached and the aWETH balance/allowance cover worst-case collateral.

## Important Limitations

- This is specifically WETH collateral and native USDC variable debt.
- `POSITION_OWNER` should be a dedicated EOA for this strategy, not a general-purpose Aave account.
- The contract assumes WETH/aWETH use 18 decimals and USDC/debt token use 6.
- `POSITION_OWNER` must approve enough aWETH before the emergency, based on worst-case collateral.
- `USDC_REPAY_BUFFER` must be greater than zero and at most 10 native USDC; any residual native-USDC variable debt after repay reverts.
- If HF falls below Aave liquidation before the keeper executes, third-party liquidators can still liquidate through Aave.
- If the fixed Uniswap pool exceeds `MAX_SLIPPAGE_BPS` relative to the Aave oracle, the emergency transaction reverts. `MAX_SLIPPAGE_BPS` cannot exceed 500.
- Additional collateral/debt assets on the same Aave account can change the account economics; this controller only repays native USDC debt using WETH collateral.
