# Test results generated for this package

- Hardhat: 3.9.0
- Solidity: 0.8.24, local solc-js
- `npm audit --omit=dev`: 0 known production vulnerabilities
- `npm run compile`: passing
- `npm test`: 50 passing
- `npm run typecheck`: passing
- `npm run test:all`: 50 passing, 3 pending fork tests without `ARBITRUM_RPC_URL`
- `npm run coverage`: 50 passing
- Arbitrum fork: 3 passing with `ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc`

Latest measured Solidity coverage:

- `contracts/AaveEmergencyRepayer.sol`: 92.77% line coverage and 92.21% statement coverage
- `contracts/mocks/Mocks.sol`: 93.62% line coverage and 89.95% statement coverage
- total: 93.24% line coverage and 91.16% statement coverage

The fork tests open real Aave V3 Arbitrum WETH/native-USDC positions owned by test EOAs. They verify the dynamic Aave addresses provider/current oracle path, missing and expected-only aWETH allowance reverts, keeper `checkAndRepay()` through the real Aave flash loan and real Uniswap V3 WETH/USDC pool, fixed-destination recovery of loose WETH/USDC/native ETH, owner-only `forceRepayAll()` on a looped position where borrowed USDC is swapped into additional WETH collateral, and an upper-HF-triggered close through the same keeper polling endpoint. All close paths verify owner debt is exactly zero and the contract does not own the Aave position.
