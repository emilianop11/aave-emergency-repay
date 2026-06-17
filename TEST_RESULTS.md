# Test results generated for this package

- Hardhat: 3.9.0
- Solidity: 0.8.24, local solc-js
- `npm audit --omit=dev`: 0 known production vulnerabilities
- `npm run compile`: passing
- `npm test`: 45 passing
- `npm run typecheck`: passing
- `npm run test:all`: 45 passing, 2 pending fork tests without `ARBITRUM_RPC_URL`
- `npm run coverage`: 45 passing
- Arbitrum fork: 2 passing with `ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc`

Latest measured Solidity coverage:

- `contracts/AaveEmergencyRepayer.sol`: 92.54% line coverage and 91.90% statement coverage
- `contracts/mocks/Mocks.sol`: 93.54% line coverage and 89.64% statement coverage
- total: 93.10% line coverage and 90.82% statement coverage

The fork tests open real Aave V3 Arbitrum WETH/native-USDC positions owned by test EOAs. They verify the dynamic Aave addresses provider/current oracle path, missing and expected-only aWETH allowance reverts, keeper `checkAndRepay()` through the real Aave flash loan and real Uniswap V3 WETH/USDC pool, and owner-only `forceRepayAll()` on a looped position where borrowed USDC is swapped into additional WETH collateral. Both paths verify owner debt is exactly zero and the contract does not own the Aave position.
