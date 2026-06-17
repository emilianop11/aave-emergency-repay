import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import hardhatEthersChaiMatchers from "@nomicfoundation/hardhat-ethers-chai-matchers";
import hardhatMocha from "@nomicfoundation/hardhat-mocha";
import hardhatNetworkHelpers from "@nomicfoundation/hardhat-network-helpers";
import hardhatTypechain from "@nomicfoundation/hardhat-typechain";
import { configVariable, defineConfig } from "hardhat/config";
import { fileURLToPath } from "node:url";

const localSolc = fileURLToPath(
  new URL("./node_modules/solc/soljson.js", import.meta.url),
);

export default defineConfig({
  plugins: [hardhatEthers, hardhatEthersChaiMatchers, hardhatMocha, hardhatNetworkHelpers, hardhatTypechain],
  solidity: {
    profiles: {
      default: {
        version: "0.8.24",
        path: localSolc,
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "cancun",
        },
      },
      production: {
        version: "0.8.24",
        path: localSolc,
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "cancun",
          metadata: {
            bytecodeHash: "none",
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatArbitrumFork: {
      type: "edr-simulated",
      chainType: "generic",
      hardfork: "cancun",
      forking: {
        url: configVariable("ARBITRUM_RPC_URL"),
      },
    },
    arbitrum: {
      type: "http",
      chainType: "generic",
      url: configVariable("ARBITRUM_RPC_URL"),
    },
  },
  chainDescriptors: {
    42161: {
      name: "Arbitrum One",
      chainType: "generic",
      hardforkHistory: {
        cancun: {
          blockNumber: 0,
        },
      },
    },
  },
});
