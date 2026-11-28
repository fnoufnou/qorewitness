import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

// Load .env (QORE_MNEMONIC) when present. Hardhat resolves configuration
// variables from the environment or from `npx hardhat keystore set QORE_MNEMONIC`.
try {
  process.loadEnvFile();
} catch {
  // No .env: rely on the environment or the keystore.
}

// Seed of the Solidity fuzz and invariant runs. Fixed, so every run repeats the same inputs.
// Another seed for one run: QW_FUZZ_SEED=0x1234 pnpm test:sol (any hex string).
const FUZZ_SEED = process.env.QW_FUZZ_SEED ?? "0x7727ea51af0441c20da14dcd68a15dac8c9ebd589c5be8fa8c87c1d3720450bc";
if (!/^0x[0-9a-fA-F]{1,64}$/.test(FUZZ_SEED)) throw new Error("QW_FUZZ_SEED must be a hex string such as 0x1234");

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
  // Solidity tests in test/solidity (fuzz and invariant). Run counts and the seed are fixed here and
  // listed in docs/TESTING.md. "deep" is for `pnpm test:fuzz` and CI. Coverage uses the default profile.
  test: {
    solidity: {
      profiles: {
        default: {
          fuzz: { runs: 256, seed: FUZZ_SEED },
          invariant: { runs: 32, depth: 64 },
        },
        deep: {
          fuzz: { runs: 4096, seed: FUZZ_SEED },
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
