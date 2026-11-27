import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// Load .env (QORE_MNEMONIC) when present. Hardhat resolves configuration
// variables from the environment or from `npx hardhat keystore set QORE_MNEMONIC`.
try {
  process.loadEnvFile();
} catch {
  // No .env: rely on the environment or the keystore.
}

// Public QoreChain testnet endpoint. Testnet only: no mainnet network is configured.
export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  solidity: {
    profiles: {
      default: { version: "0.8.28" },
      production: {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    },
  },
  // Solidity tests in test/solidity (fuzz and invariant). Run counts are fixed here and listed in
  // docs/TESTING.md. The fuzz seed is Hardhat's fixed default, so runs repeat. "deep" is for
  // `pnpm test:fuzz` and CI. Coverage uses the default profile.
  test: {
    solidity: {
      profiles: {
        default: {
          fuzz: { runs: 256 },
          invariant: { runs: 32, depth: 64 },
        },
        deep: {
          fuzz: { runs: 4096 },
          invariant: { runs: 256, depth: 100 },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: { type: "edr-simulated", chainType: "l1" },
    qorechainTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 9800,
      url: "https://evm-testnet.qore.host",
      accounts: { mnemonic: configVariable("QORE_MNEMONIC") },
    },
  },
});
