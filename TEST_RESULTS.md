# Test results generated for this package

- Hardhat: 3.9.0
- Solidity: 0.8.24, local solc-js
- `npm audit --omit=dev`: 0 known production vulnerabilities
- `npm run compile`: passing
- `npm test`: 46 passing
- `npm run typecheck`: passing
- `npm run test:all`: 46 passing, 2 pending fork tests without `ARBITRUM_RPC_URL`
- `npm run coverage`: 46 passing
- Arbitrum fork: 2 passing with `ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc`

Latest measured Solidity coverage:

- `contracts/AaveEmergencyRepayer.sol`: 92.27% line coverage and 91.71% statement coverage
- `contracts/mocks/Mocks.sol`: 93.58% line coverage and 89.80% statement coverage
- total: 93.01% line coverage and 90.80% statement coverage

The fork tests open real Aave V3 Arbitrum WETH/native-USDC positions owned by test EOAs. They verify the dynamic Aave addresses provider/current oracle path, missing and expected-only aWETH allowance reverts, keeper `checkAndRepay()` through the real Aave flash loan and real Uniswap V3 WETH/USDC pool, fixed-destination recovery of loose WETH/USDC/native ETH, and owner-only `forceRepayAll()` on a looped position where borrowed USDC is swapped into additional WETH collateral. Both paths verify owner debt is exactly zero and the contract does not own the Aave position.
