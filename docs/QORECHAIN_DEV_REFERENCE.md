# QoreChain Developer Reference for QoreWitness

Compiled 2026-11-09 for the QoreChain Developer Fest ("Build Before Q-Day"). Target: category "Post-Quantum dApp", stretch "Encrypted Apps".

Status: PoC project. Shortcuts and gaps are flagged. Hypersolid defaults apply: TypeScript, `pnpm add --ignore-scripts` and `pnpm install --ignore-scripts`, secrets in env vars only.

Style note: prose has no semicolons. Code blocks keep the semicolons that Solidity and TypeScript need.

Legend
- [V] verified on a page I read. Source URL given.
- [U] unverified, inferred, or my own design suggestion.
- Docs say rules, prizes and dates "are not final" (https://build.qorechain.io/rules).

---

## 0. Read this first (top gotchas)

1. `pqcVerify` exists as a precompile at `0x0000000000000000000000000000000000000A01`. It is active on testnet only. It is NOT active on mainnet. [V] https://docs.qorechain.io/developer-guide/evm-precompiles
2. Calls to an inactive precompile succeed with empty data (`0x`). Typed Solidity interface calls revert on that. A raw `staticcall` must check `ret.length`. [V] same page.
3. Every EVM tx needs a registered ML-DSA-87 key AND an open EVM authorisation window. Reads, `eth_call` and gas estimation need neither. Refusal codes are in codespace `pqc`: 26, 27, 28. [V] https://docs.qorechain.io/developer-guide/evm-development
4. Opening a window advances the account nonce. Open the window first, then read the nonce, then sign. [V] same page.
5. Contract deployment counts as a tx in the window. A window with `allowed_targets` refuses contract creation. So deploy first (unscoped or native-free window), then switch to a scoped window. [V] evm-development page. The ordering advice is my inference [U].
6. The testnet can reset without notice. Anchors on testnet may vanish. Keep the OpenTimestamps anchor and local copies as the durable proof. [V] https://docs.qorechain.io/getting-started/connecting-to-testnet
7. Foundry and Hardhat cannot run the `0x...0A01` precompile locally. Use a mock via `vm.etch` for unit tests and a live testnet script for integration. [U] inference from the precompile being a chain-native static precompile.
8. "Two-stage QCAI audit" is not defined on any page I could read. See section 9.
9. `gh` access to the `qorechain` org was refused in this session (repo-scoped sessions only). GitHub facts below come from WebFetch of github.com pages. `latest.json` at download.qore.host was blocked by a permission timeout and not read.

---

## 1. Endpoints and network facts

### 1.1 Testnet `qorechain-diana`

| Item | Value | Source |
|---|---|---|
| Cosmos chain ID | `qorechain-diana` | https://docs.qorechain.io/getting-started/connecting-to-testnet |
| EVM chain ID | `9800` | same |
| Consensus RPC | `https://rpc-testnet.qore.host` | same |
| Consensus WebSocket | `wss://rpc-testnet.qore.host/websocket` | same |
| Cosmos REST (LCD) | `https://api-testnet.qore.host` | same |
| EVM JSON-RPC | `https://evm-testnet.qore.host` | same |
| EVM WebSocket | `wss://evm-ws-testnet.qore.host` | same |
| SVM JSON-RPC | `https://svm-testnet.qore.host` (read only, SVM tx lane closed network-wide) | same |
| gRPC | No public endpoint listed. Local node only, port 9090 | same |
| Explorer | `https://explore.qore.network` (toggle to Testnet) | same |
| Live genesis | `https://rpc-testnet.qore.host/genesis` | same |
| Release manifest | `https://download.qore.host/testnet/latest.json` (not read, blocked) | same |
| Faucet | `https://dashboard.qorechain.io/faucet` (sign-in required) | https://docs.qorechain.io/dashboard/faucet |
| Bech32 prefix, denom | `qor`, `uqor`, 6 decimals | https://docs.qorechain.io/getting-started/wallet-setup |
| EVM currency | QOR, 18 decimals. `x/precisebank` converts. 1 uqor = 10^12 wei | evm-development page, templates page |
| Testnet version | v3.2.7 (applied 2026-11-06, height 9,594,600) | connecting-to-testnet |
| Block time | about 1.3 s on testnet | evm-development page |
| Minimum gas price | `0.1uqor` per gas. In wei terms that is 100 gwei [U derived] | wallet-setup page |
| Rate limits on public endpoints | Not stated [U] | connecting-to-testnet |
| Public JSON-RPC namespaces | `eth_`, `web3_`, `net_`. `txpool` opt-in. `debug_*` unavailable on public endpoints | evm-development, https://docs.qorechain.io/developer-tools/chain-dev-sdk |
| Node-side JSON-RPC limits (v3.2.4+, `app.toml`) | Body over 256 KiB gives HTTP 413. Over 256 concurrent gives 503. `eth_getLogs` max 4 topic positions, 1000 alternatives, 1000 addresses | evm-development |
| CORS on public endpoints | Not documented [U]. Test from the browser verifier early | n/a |

Mainnet for reference (not a target): `qorechain-vladi`, EVM chain ID 9801, `https://evm.qore.host`, `https://api.qore.host`, `https://rpc.qore.host`. Version v3.2.6 per wallet-setup page. pqcVerify is not active there.

### 1.2 Other protocol facts

- Fest test tokens on testnet (no value): fUSD `0x97143B771D34ddb9130b807b135Ae675A5a963CA`, fETH `0x02292293c13880a26242690eb70a0e42B8E91c28`, fBTC `0x4604e7E45b2ecdbfbDc157103f5B2b62cb16451A`. [V] faucet page.
- EVM rules: blob tx (type 3) refused. Pre-EIP-155 tx refused. PREVRANDAO is a constant. [V] chain-dev-sdk page and evm-development page.
- EVM block gas limit, max contract size and max tx size: not documented [U]. Check with `eth_getBlockByNumber` and a test deploy.
- Release binary note: only the official `qorechaind` release binary from download.qore.host can create ML-DSA signatures. A source build cannot ("requires the full build"). [V] https://docs.qorechain.io/getting-started/quickstart. The docs mention `qorechaind-v3.2.7-b3-linux-amd64.tar.gz` as a snapshot. macOS and Windows builds are [U].
- You do NOT need the binary if you use the TypeScript SDK. The SDK signs hybrid in pure JS. [V] https://docs.qorechain.io/sdk/quickstart

---

## 2. Packages

Versions read from npm with `npm view` on 2026-11-09 unless marked. Kits page: https://build.qorechain.io/kits

| Package | Version | Published (npm) | Purpose | Link |
|---|---|---|---|---|
| `@qorechain/sdk` | 0.12.0 | 2026-10-30 | Core SDK. Accounts, REST client, hybrid signing, PQC registration, EVM window messages. Needs Node 20+ | https://www.npmjs.com/package/@qorechain/sdk |
| `@qorechain/evm` | 0.12.0 | 2026-10-30 | viem adapter. Chain defs `qorechain`, `qorechainTestnet`, `createEvmClient`, `simulateWithRiskScore`, `precompiles`, window helpers. Peer: `viem` | https://www.npmjs.com/package/@qorechain/evm |
| `@qorechain/react` | 0.12.0 | 2026-10-30 | React provider, hooks, `ConnectButton`, `PqcStatusBadge` | https://www.npmjs.com/package/@qorechain/react |
| `create-qorechain-dapp` | 0.12.0 | 2026-10-30 | Scaffolder. 7 templates. Node 20+ | https://www.npmjs.com/package/create-qorechain-dapp |
| `@qorechain/pqc` | 0.2.3 | 2026-10-20 | ML-DSA, ML-KEM, SHAKE-256, hybrid sign-bytes. Pure JS on `@noble/post-quantum`. Runs in browsers, no WASM | https://www.npmjs.com/package/@qorechain/pqc |
| `@qorechain/qoresign` | 0.1.1 | 2026-10-27 | Hybrid key derivation, `signHybrid`, `verifyHybridTx`, Sign In With QoreChain. Pre-1.0 | https://www.npmjs.com/package/@qorechain/qoresign |
| `@qorechain/qoreseal` | 0.1.0 | 2026-10-29 | ML-KEM-1024 sealed envelopes to QoreChain accounts. Draft, pending external review | https://www.npmjs.com/package/@qorechain/qoreseal |
| `@qorechain/wallet-adapter` | 0.4.0 | 2026-10-20 | Adds ML-DSA-87 hybrid signing to Keplr, Leap and Cosmostation. `addQoreEvmToWallet`. Peer cosmjs ^0.32 conflicts with SDK cosmjs 0.39 | https://www.npmjs.com/package/@qorechain/wallet-adapter |
| `@qorechain/mcp` | 0.1.0 | 2026-10-27 | Read-only MCP server. Cannot sign or broadcast | https://www.npmjs.com/package/@qorechain/mcp |
| `@qorechain/qore-cli` | 0.1.0 | 2026-10-27 | `qore` CLI with the same tools as MCP | https://www.npmjs.com/package/@qorechain/qore-cli |
| `@qorechain/qorex-types` | 0.1.0 | 2026-10-27 | QoreX wallet types | https://www.npmjs.com/package/@qorechain/qorex-types |
| `@qorechain/qorex-rainbowkit` | 0.1.0 | 2026-10-27 | QoreX connector for RainbowKit and wagmi | https://www.npmjs.com/package/@qorechain/qorex-rainbowkit |
| `@qorechain/qorex-wallet-mock` | 0.1.0 | 2026-10-27 | Wallet mock for tests | https://www.npmjs.com/package/@qorechain/qorex-wallet-mock |
| `@qorechain/chain-bridge` | 0.2.3 | 2026-10-20 | Server-side worker. Licences, deploy, hybrid signing | https://www.npmjs.com/package/@qorechain/chain-bridge |
| `@qorechain/handles` | 0.1.0 | not checked ([U] modified 2026-08-24) | @handle resolution | https://www.npmjs.com/package/@qorechain/handles |
| `@qorechain/connect` | 0.2.1 | n/a | DEPRECATED. Use qorex-* and qoresign | https://www.npmjs.com/package/@qorechain/connect |
| `@qorechain/svm`, `qorex-cosmos-kit`, `qorex-interchain-kit`, `qorex-synpress`, `rdk`, `rdk-cli`, `asset-kit`, `qorescan`, `pq-light-client` | 0.1.0 to 0.8.0 per kits page | not checked | Not needed for QoreWitness | https://build.qorechain.io/kits |

Other languages (kits page): `pip install qorechain-sdk` 0.12.0 (import `qorsdk`). `pip install qorechain-pqc` 0.2.3 (import `qorpqc`). PyPI versions confirmed with `pip index versions`. Rust, Go, Java, Swift, Kotlin packages are listed on the kits page. [V] https://build.qorechain.io/kits

Dependency notes [V] https://docs.qorechain.io/sdk/install
- SDK versions below 0.8.0 sign a form the networks refuse. Use 0.8.1 or later. Use 0.12.0.
- `@qorechain/wallet-adapter` and `@qorechain/sdk` cannot share one project without `--legacy-peer-deps`. Prefer the SDK only, or keep the adapter in a separate package.
- `@qorechain/rdk` pulls a nested older SDK. Not relevant here.
- `create-qorechain-dapp --version` prints 0.5.1 although the package is 0.12.0. Ignore.

### 2.1 GitHub org `qorechain` (26 public repos)

Source: https://github.com/orgs/qorechain/repositories?type=all (WebFetch, "last updated" as shown on the page). `gh` was refused. Licence "none shown" means the listing did not display one.

| Repo | Description | Lang | Last updated | Licence |
|---|---|---|---|---|
| qorechain-core | Quantum-safe, AI-native Layer 1 | Go | 2026-10-23 | Apache-2.0 |
| qorechain-sdk | Multi-language SDK and dev kit | TypeScript | 2026-10-27 | Apache-2.0 |
| qorechain-pqc | PQC primitives in six languages | Java | 2026-10-20 | Apache-2.0 |
| qoresign | Hybrid ML-DSA-87 signing, SIWQ | Rust | 2026-10-27 | Apache-2.0 |
| qoreseal | ML-KEM-1024 encryption to accounts | Kotlin | 2026-10-27 | Apache-2.0 |
| qorechain-mcp | MCP server and CLI, read only | TypeScript | 2026-10-27 | Apache-2.0 |
| qorechain-custody-kit | Custodian and exchange kit | Java | 2026-10-27 | Apache-2.0 |
| qorechain-wallet-adapter | Cosmos, EVM, SVM wallet adapter | JavaScript | 2026-10-20 | Apache-2.0 |
| qorex-integrations | QoreX packages and test tooling | TypeScript | 2026-10-27 | Apache-2.0 |
| qorechain-rdk | Rollup Development Kit | TypeScript | 2026-10-28 | Apache-2.0 |
| qorechain-docs | Docusaurus docs site | TypeScript | 2026-10-28 | none shown |
| qorechain-asset-kit | Tokenized assets tooling | TypeScript | 2026-10-27 | Apache-2.0 |
| qorechain-pq-light-client | ML-DSA-87 checkpoint light client spec | Rust | 2026-10-27 | Apache-2.0 |
| qorescan | Crypto inventory (CBOM) | Go | 2026-10-27 | Apache-2.0 |
| qorechain-lightnode | Light node | Go | 2026-10-27 | Apache-2.0 |
| QORel | IBC relayer, Hermes fork | Rust | 2026-10-27 | Apache-2.0 |
| qorechain-explorer | Explorer | TypeScript | 2026-10-25 | none shown |
| homebrew-tap | Homebrew formulae | Ruby | 2026-10-27 | none shown |
| cosmos-chain-registry | Chain registry fork | Python | 2026-10-27 | CC-BY-4.0 |
| cosmos, devnet, testnet, qore-web3, qore-wallet-provider | No or short description | n/a | 2026-10-27 | none shown |
| 6ssfkcjrj7 | "maven verification" (test repo) | n/a | 2026-10-27 | none shown |
| circl | CIRCL mod QC | Go | 2025-08-01 | MIT |

Note: an earlier fetch of github.com/qorechain showed July dates and 16 repos. That looked cached. The repositories page above is newer.

README facts read:
- qorechain-pqc: API `keygen`, `keygenFromSeed(seed32)`, `sign(sk, msg)`, `verify(pk, msg, sig)`, `kem.*`, `shake256`, `pubkeyHash`, `hybridSignBytes`. Sign is deterministic by default. "QoreChain's on-chain verifier accepts only deterministic signatures" (README) but the signing docs say the chain accepts hedged and deterministic FIPS-204 signatures. These two statements conflict. [V] but conflicting. Use deterministic signing and test on the precompile. Sources: https://github.com/qorechain/qorechain-pqc and https://docs.qorechain.io/developer-guide/post-quantum-signing/
- qorechain-sdk README is stale (says 0.7.x). Trust npm and docs.
- qoreseal README says the TypeScript package is "not yet on npm". npm now shows 0.1.0 (2026-10-29). Trust npm. Browser support unverified.
- qoresign: signatures below. Browser support not stated.
- qorechain-mcp: tools in section 6.4.

---

## 3. Accounts, keys, hybrid signing

### 3.1 Model [V] https://docs.qorechain.io/architecture/post-quantum-security

| Algorithm | Role | Public key | Private key | Signature or ciphertext |
|---|---|---|---|---|
| ML-DSA-87 (Dilithium-5, FIPS 204) | Signature | 2,592 B | 4,896 B | 4,627 B |
| ML-KEM-1024 (FIPS 203) | KEM | 1,568 B | 3,168 B | 1,568 B ciphertext, 32 B shared secret |

- Cosmos-lane tx (native) carry secp256k1 signature plus ML-DSA-87 signature. The PQC part is an extension `/qorechain.pqc.v1.PQCHybridSignature` with `algorithm_id=1`, `pqc_signature`, optional `pqc_public_key`.
- Network default `hybrid_signature_mode = required (2)` and `allow_classical_fallback = false`.
- EVM-lane tx cannot carry a second signature. They stay classical ECDSA. The "EVM authorisation window" gates them (section 3.3).
- Sign-bytes v2 (what both networks use):
```text
"qorechain-pqc-hybrid-v2" || BE64(len(chainId)) || chainId || BE32(len(B0)) || B0 || BE32(len(authInfo)) || authInfo
```
`B0` is the tx body without the PQC extension. Source: https://docs.qorechain.io/developer-guide/post-quantum-signing/
- Key derivation (recoverable): `seed = SHAKE-256("qorechain:pqc:v1|" + cosmosAddress + "|" + mnemonic)` then `mldsa.keygen(seed)`. SDK helper `derivePqcCanonical(address, mnemonic)`.
- Key registration is never automatic on chain. QoreX and the SDK register for you. `register-key-v2` adds a proof of possession (v3.2.3+). Weak, degenerate and reused keys are refused. Key types `hybrid` and `pqc_only` are valid, `classical_only` is refused.
- Errors: `pqc` code 21 = `hybrid_verify_failed`. Causes: wrong sign-bytes version, chain ID mismatch, stale PQC library (use pqc 0.1.1+, ideally 0.2.1+), unregistered key or wrong key. Source: https://docs.qorechain.io/sdk/guides/quantum-safe
- Wallet-adapter note: on code 21 call `refreshSignBytesVersion()` and sign once more. Source: https://docs.qorechain.io/developer-tools/wallet-adapter

### 3.2 Register an ML-DSA-87 key

SDK path [V] https://docs.qorechain.io/sdk/guides/quantum-safe
```ts
const account = await deriveNativeAccount(mnemonic);
const signer = await directSignerFromPrivateKey(account.privateKey, "qor");
const pqcKeypair = derivePqcCanonical(account.address, mnemonic);
const tx = await client.connectTx(signer, { pqcKeypair }); // signs hybrid
const res = await ensurePqcRegistered(tx, {
  pqcKeypair,
  rest: client.network.endpoints.rest,
  fee: { amount: [{ denom: "uqor", amount: "60000" }], gas: "600000" },
}); // { alreadyRegistered: boolean, txHash?: string }
```
- `ensurePqcRegistered` is idempotent. It reads status first. It throws `PqcKeyMismatchError` if a different key is registered. `force: true` skips the check.
- Cost: about 600,000 gas, 60,000 uqor. The registration tx is signed classically and is exempt from the hybrid rule (only for accounts with no key).
- Status: `isPqcRegistered(client, address)`, `getPqcStatus(client, address)`, REST `GET /qorechain/pqc/v1/account/{address}`.
- Unified eth-native accounts (one key gives `qor1...`, `0x...`, base58) use `EthNativeSigner` with `signMode: "classical"` for registration. The page with those samples was truncated when I fetched it [U]. https://docs.qorechain.io/sdk/concepts/accounts-pqc

CLI path (needs the official `qorechaind` binary) [V] https://docs.qorechain.io/getting-started/first-transaction
```bash
qorechaind tx pqc gen-key mypqc          # stored at ~/.qorechaind/pqc/mypqc.dilithium, mode 0600, NOT encrypted
qorechaind tx pqc register-key-v2 dilithium5 <public_key_hex> hybrid --pqc-key mypqc --from mykey \
  --chain-id qorechain-diana --gas 600000 --fees 60000uqor
```

QoreX: derives the key from the 24-word phrase and registers it with the first transfer. Testnet toggle is Settings, "Use testnet (developers)". The QoreX docs do not say how to get test QOR (use the dashboard faucet). Sources: https://docs.qorechain.io/qorex/getting-started and https://docs.qorechain.io/qorex/security-and-recovery

### 3.3 EVM authorisation window ("EVM window")

[V] https://docs.qorechain.io/developer-guide/evm-development and https://docs.qorechain.io/getting-started/first-transaction

Message `MsgOpenEVMWindow` (Cosmos lane, hybrid signed). Opening a new window replaces the old one.

| Bound | Range | Note |
|---|---|---|
| `blocks` | 1 to 17,280 | About 6 h on testnet (1.3 s blocks), 15 h on mainnet |
| `max-txs` | 1 to 1,000 | Failed admitted tx still uses a slot. Deployments count |
| `max-value` | > 0 uqor | Native value plus each tx max fee (gas limit x max fee per gas), rounded up. Token transfers and approvals carry zero value, so only their fee counts |

Scope (v3.2.3+, testnet has it):
- `native_only` (`--native-only`): plain native QOR transfers only. No calldata, no creation.
- `allowed_targets` (`--allowed-targets 0xA,0xB`): only these recipients, up to 16. Contract creation refused.
- Scope limits which contracts, not how much. Do not list generic routers or forwarders.

CLI:
```bash
qorechaind tx pqc open-evm-window 7200 20 1000qor --from mykey \
  --chain-id qorechain-diana --gas 400000 --fees 40000uqor --generate-only > w.json
qorechaind tx pqc cosign w.json --from mykey --pqc-key mypqc --chain-id qorechain-diana
qorechaind query pqc evm-window <address>
qorechaind tx pqc close-evm-window       # same generate-only + cosign pattern
```
REST: `GET /qorechain/pqc/v1/evm_window/{address}` (returns `found: false` if none). Events: `pqc_evm_window_opened`, `pqc_evm_window_used` (testnet v3.2.7+).

SDK (0.9.0+ for scope) [V] https://docs.qorechain.io/sdk/guides/evm
```ts
import { openEvmWindowMsg, fetchEvmWindow, classifyEvmWindowRejection } from "@qorechain/sdk";
const msg = openEvmWindowMsg({
  sender: cosmosAddress,
  blocks: 7200,
  maxTxs: 20,
  maxValue: "1000000000",        // uqor, value PLUS max fee per tx
  allowedTargets: ["0xAnchorRegistry..."],   // or nativeOnly: true
});
// sign + broadcast as hybrid Native-lane tx, e.g. tx.signAndBroadcast([msg], "auto")
const w = await fetchEvmWindow({ rest: REST, address: cosmosAddress }); // w.live
// classifyEvmWindowRejection(err) -> "no-pqc-key" | "no-window" | "exhausted" | "invalid" | undefined
```
Export name drift: one page says `openEvmWindowMessage`, another `openEvmWindowMsg`. Check your installed version. Also `evmWindowCost`, `weiToUqorCeil`, `evmWindowStatus`, `toQorAddress`, `toEvmAddress`, `MAX_EVM_WINDOW_BLOCKS`, `MAX_EVM_WINDOW_TXS`. [V] sdk/guides/evm.

Error codes (codespace `pqc`):
| Code | Meaning |
|---|---|
| 26 | No open window or no registered key |
| 27 | Window expired, exhausted, or tx outside scope |
| 28 | Invalid bounds, or no key when opening |

QoreX can open an unscoped window (Settings, Security, EVM access window). It has no screen for scoped windows. MetaMask cannot open a window. Use the SDK or CLI for scoped windows. Source: https://docs.qorechain.io/qorex/security-and-recovery

EIP-7702: delegation needs `MsgAuthorizeEVMDelegation` consent. Not needed for QoreWitness.

### 3.4 Zero to first hybrid-signed testnet tx (TypeScript, no binary)

Assembled from docs. Not run [U]. Sources: https://docs.qorechain.io/sdk/quickstart, https://docs.qorechain.io/sdk/guides/quantum-safe

1. Tooling: Node 20+, pnpm. In an empty folder:
   `pnpm add --ignore-scripts @qorechain/sdk @qorechain/evm @qorechain/pqc viem`
2. Create a test mnemonic. Store it in `.env` as `QORE_MNEMONIC` and keep `.env` out of git. Never reuse it on mainnet.
3. Derive the address (script below), then fund it. Sign in at https://dashboard.qorechain.io, open Faucet, paste the `qor1...` address, claim. You get 100 QOR plus fest tokens. One claim per 24 h per account and per address. Source: https://docs.qorechain.io/dashboard/faucet
4. Check the balance: `GET https://api-testnet.qore.host/cosmos/bank/v1beta1/balances/<qor1...>`
5. Run the script. It registers the ML-DSA key (once) and sends 1 QOR hybrid-signed. Expect about 600,000 gas for registration and about 171,600 gas for the send.
```ts
import {
  createClient, generateMnemonic, deriveNativeAccount, directSignerFromPrivateKey,
  derivePqcCanonical, ensurePqcRegistered, toBase,
} from "@qorechain/sdk";

const mnemonic = process.env.QORE_MNEMONIC ?? generateMnemonic(); // 12 words, 256 gives 24
const client = createClient();                       // defaults to testnet since SDK 0.12.0
const account = await deriveNativeAccount(mnemonic);
console.log("fund me:", account.address);

const signer = await directSignerFromPrivateKey(account.privateKey, "qor");
const pqcKeypair = derivePqcCanonical(account.address, mnemonic);
const tx = await client.connectTx(signer, { pqcKeypair });   // every tx now signs hybrid

await ensurePqcRegistered(tx, {
  pqcKeypair,
  rest: client.network.endpoints.rest,
  fee: { amount: [{ denom: "uqor", amount: "60000" }], gas: "600000" },
});

const res = await tx.bankSend("qor1recipient...", [{ denom: "uqor", amount: toBase("1") }]); // fee "auto"
console.log(res);
```
6. Verify: open https://explore.qore.network with Testnet selected and look up the tx hash. Or `GET https://api-testnet.qore.host/cosmos/tx/v1beta1/txs/<hash>`. The MCP tool `get_pq_status` also shows the signature tier.
7. Gas pricing: minimum 0.1 uqor per gas. The SDK client prices at 0.15 and defaults fee to `"auto"` (simulate, then `ceil(sim x 1.02) + 2000` on v3.2.5+).

Fallback if the SDK misbehaves: use the CLI two-step flow (needs the official binary):
```bash
qorechaind tx bank send mykey qor1recipient... 1000000uqor --chain-id qorechain-diana \
  --gas 400000 --fees 40000uqor --generate-only > tx.json
qorechaind tx pqc cosign tx.json --from mykey --pqc-key mypqc --chain-id qorechain-diana
```

### 3.5 Zero to first EVM tx (for AnchorRegistry)

[V] https://docs.qorechain.io/developer-tools/chain-dev-sdk, evm-development page. The EVM account flow for a coin-60 (0x) key is [U] and depends on `EthNativeSigner`.

1. Scaffold: `pnpm create qorechain-dapp qorewitness --template foundry --network testnet --package-manager pnpm` (or `npx create-qorechain-dapp my-app --template foundry`). Then `pnpm install --ignore-scripts`.
2. Put `PRIVATE_KEY` (or `QORE_MNEMONIC`) in `.env`. Fund the matching address via the faucet (a `0x` address is the same 20 bytes as `qor1`, but the faucet form accepts only `qor1...`, so convert first).
3. `pnpm window status` then `pnpm window register` (once) then `pnpm window open` (defaults 600 blocks, 5 txs, 3,000,000 gas, 250 gwei cap). Override with `QORE_WINDOW_BLOCKS`, `QORE_WINDOW_TXS`, `QORE_WINDOW_MAX_UQOR`.
4. `pnpm deploy:testnet` (runs `forge script script/Counter.s.sol --rpc-url qorechain_testnet --broadcast`).
5. Shortcut flag from the docs: the helper derives the ML-DSA key from the EVM key secret. If the key was registered from another wallet, open the window from that wallet.

---

## 4. Contract integration: `pqcVerify` and friends

### 4.1 Precompiles [V] https://docs.qorechain.io/developer-guide/evm-precompiles

| Name | Address | Gas | Mainnet | Testnet |
|---|---|---|---|---|
| CrossVM Bridge | `0x...0901` | 50,000 + 4/byte | no | yes, allowlist only |
| PQC Verify | `0x0000000000000000000000000000000000000A01` | 25,000 + 8/byte of input | no | yes |
| PQC Key Status | `0x0000000000000000000000000000000000000A02` | 2,500 flat | no | yes |
| AI Risk Score | `0x...0B01` | 50,000 | no | NO |
| AI Anomaly Check | `0x...0B02` | 40,000 | no | NO |
| PRISM params | `0x...0C01` | 1,500+ | no | yes |

The page says "four active on testnet" but lists three active plus CrossVM Bridge (allowlist). Treat `simulateWithRiskScore` as unavailable on testnet. Check live state:
```bash
curl -s https://api-testnet.qore.host/cosmos/evm/vm/v1/params | jq .params.active_static_precompiles
```
Governance can change this. The PQC Verify precompile was activated by testnet governance proposal 21 on 2026-10-27 (evm-development page).

### 4.2 Solidity interface (from the docs)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IQorePQC {
    // ML-DSA-87 verification. pubkey 2592 bytes, signature 4627 bytes
    function pqcVerify(bytes calldata pubkey, bytes calldata signature, bytes calldata message)
        external view returns (bool valid);

    // algorithmId 1 = ML-DSA-87. pubkey is empty if not registered
    function pqcKeyStatus(address account)
        external view returns (bool registered, uint8 algorithmId, bytes memory pubkey);
}

contract PQCVerifier {
    IQorePQC constant PQC = IQorePQC(0x0000000000000000000000000000000000000A01);
    function verifyOrRevert(bytes calldata pk, bytes calldata sig, bytes calldata m) external view {
        require(PQC.pqcVerify(pk, sig, m), "PQC signature verification failed");
    }
}
```
Notes [V] same page:
- From v3.2.4, `pqcKeyStatus` also returns a fourth value `bool possessionProven`. Contracts that must trust a key should check it. The doc's interface omits it. The 4-value form is [U] on the live testnet. Test with `cast call`.
- Input is ABI-encoded `bytes` for pubkey (2592), signature (4627), message (any length). Typical total cost is about 85,000 to 90,000 gas.
- Never send value to these addresses.
- Typed interface calls revert on empty return data. Raw `staticcall` needs a `ret.length` check.
- Not documented [U]: ML-DSA context string (empty or not), pure versus pre-hash mode, whether `pqcVerify` accepts hedged signatures, return on malformed lengths (false or revert). Test all four on testnet.
- No ML-KEM precompile exists. ML-KEM is client-side (QoreSeal) plus an on-chain key registry (`MsgRegisterKEMKey`, REST `/qorechain/pqc/v1/kem/{address}`, JSON-RPC `qor_getKEMKey` on testnet only).

### 4.3 Design proposal for `AnchorRegistry` [U, mine, not from docs]

- Sender-bound trust: in `anchor(...)` call `pqcKeyStatus(msg.sender)`. Require `registered`, `algorithmId == 1`, `possessionProven`. Then `pqcVerify(pubkey, sig, message)`. The on-chain registered key is the root of trust, not a key stored in the contract.
- Do NOT store the 2,592 byte key in contract storage. That is 81 slots. Read it from the precompile each time (2,500 gas).
- Message to sign: a domain-separated blob, for example `"QoreWitness-v1" || chainId || registryAddress || deviceId || minuteStartUnix || merkleRoot`. This prevents replay across chains and contracts.
- Store: `mapping(bytes32 key => Anchor)` with `root`, `minuteStart`, `blockNumber`, `signer`. Emit `Anchored(deviceId, minuteStart, root, signer)`. Storing the 4,627 byte signature in storage is expensive. Emit it in the event instead, or pass it as calldata only and keep a `keccak256(sig)`. The browser verifier then reads the signature from the tx input or the log.
- Gas guess: calldata about 7.3 KB (about 117k gas at 16 gas/byte) + precompile about 90k + storage and log. Plan for about 300,000 gas per anchor. At 112.5 gwei that is about 0.034 QOR. One anchor per minute is about 49 QOR per day. The faucet gives 100 QOR per 24 h. All numbers are estimates [U].
- Cadence versus window: one anchor per minute = 360 tx per 17,280-block testnet window (about 6.2 h). That is under the 1,000 tx cap. The window must be re-opened about every 6 h with a hybrid-signed Cosmos tx, so the signer service needs the ML-DSA key. `max-value` for 360 tx at 300k gas and a 250 gwei cap is about 27 QOR (27,000,000 uqor) [U arithmetic].
- Scoped window: open with `allowedTargets: [AnchorRegistry]`. Deploy first, then scope. This is the "scoped EVM window" required by the category.
- Batch option to cut cost: anchor every N minutes with a root of minute roots. Trade-off is coarser time proof [U].
- Mainnet is not possible until governance activates the precompile there. Say so in the README.

### 4.4 Testing with Foundry or Hardhat

- Config values: testnet chain ID 9800, RPC `https://evm-testnet.qore.host`, Foundry alias `qorechain_testnet`, Hardhat network `qorechainTestnet`. QoreChain is not in `viem/chains`, import `qorechain` and `qorechainTestnet` from `@qorechain/evm`. [V] https://docs.qorechain.io/developer-tools/chain-dev-sdk
- Foundry template tests: `forge build`, `forge test` run locally with no network. Hardhat template: `pnpm test` on the simulated network. Hardhat 3 needs Node 22. Foundry template needs Foundry installed. [V] same page.
- Hardhat key handling option: `npx hardhat keystore set PRIVATE_KEY` (encrypted). The Hardhat example in https://docs.qorechain.io/developer-guide/evm-development hardcodes a key placeholder. Do not copy that. Use env vars.
- Mocking `pqcVerify`: `vm.etch(address(0x...0A01), address(new MockPqcVerify()).code)` and the same for `0A02`. [U]
- Valid test vectors: create real ML-DSA-87 signatures with `@qorechain/pqc` (`mldsa.sign`) and feed them to the live precompile in an integration script (`cast call` against the testnet). Vectors also exist at `vectors/` in qorechain-pqc.
- Block-level facts for tests: PREVRANDAO constant, no blob tx, no `debug_*`. [V]

### 4.5 Reading contract events

- `@qorechain/evm` exposes a viem `publicClient` (`createEvmClient({ endpoints: { evmRpc } })`). Use viem `getLogs`, `getContractEvents`, `watchContractEvent`. The QoreChain docs do not document events [V gap], so this is plain viem [U]. WebSocket: `wss://evm-ws-testnet.qore.host`.
- `eth_getLogs` limits are in section 1.1.
- Browser verifier reading: `eth_call` for the record, `eth_getLogs` for the event, REST `GET /qorechain/pqc/v1/account/{address}` for the registered key. CORS unknown [U].

---

## 5. SDK and PQC library usage

### 5.1 `@qorechain/pqc` (TypeScript) [V] https://docs.qorechain.io/developer-tools/pqc-library and https://docs.qorechain.io/developer-guide/post-quantum-signing/
```ts
import { mldsa, mlkem, shake256, pubkeyHash } from "@qorechain/pqc";

const { publicKey, secretKey } = mldsa.keygen();          // ML-DSA-87
const sig = mldsa.sign(secretKey, message);               // deterministic by default, { hedged: true } is opt-in
mldsa.verify(publicKey, message, sig);                    // boolean, never throws on bad input

const { publicKey: ek, secretKey: dk } = mlkem.keygen();  // ML-KEM-1024
const { cipherText, sharedSecret } = mlkem.encapsulate(ek);
mlkem.decapsulate(dk, cipherText);                        // equals sharedSecret

shake256(data, 32);                                       // 32 byte digest
pubkeyHash(publicKey, 20);
// also: mldsa.keygenFromSeed(seed32), hybridSignBytes(version, chainId, B0, authInfo),
// hybridSignBytesV1, hybridSignBytesV2, signBytesVersionForApplied
```
- Pure JS, no WASM, runs in Node and browsers. Engines: Node >= 18 (npm). Deps: `@noble/post-quantum ^0.7.1`, `@noble/hashes ^2`. ESM/CJS and bundle size not stated [U].
- Speed: ML-DSA-87 sign about 8 ms in JS on an Apple-silicon laptop. Verify time not stated [U].
- It produces only the ML-DSA half. The secp256k1 half and registration happen elsewhere.
- Level variants exported: `mldsa44/65/87`, `mlkem512/768/1024`.
- Sizes: ML-DSA-87 pk 2592, sig 4627. ML-KEM-1024 pk 1568, ct 1568.

### 5.2 `@qorechain/sdk` [V] https://docs.qorechain.io/sdk/quickstart, https://docs.qorechain.io/sdk/overview
- `createClient({ network: "testnet" | "mainnet" | "localnet", endpoints })`. No arguments gives public testnet since 0.12.0. `client.rest.getAllBalances(address)`. Do not use `client.qor` on public endpoints (always `-32601`).
- Accounts: `generateMnemonic`, `deriveNativeAccount`, `deriveEvmAccount`, `deriveSvmAccount`, `deriveUnifiedAccount` (0.6.0+).
- Signing: `directSignerFromPrivateKey`, `client.connectTx(signer, { pqcKeypair })`, `tx.bankSend`, `tx.signAndBroadcast(msgs, "auto")`, `buildHybridTx`, `signAndBroadcastHybrid`, `migrateToHybrid`, `qorechainRegistry()`.
- PQC: `derivePqcCanonical`, `generatePqcKeypair`, `ensurePqcRegistered`, `isPqcRegistered`, `getPqcStatus`, `fetchPqcStatus`, `rotatePqcKeyMsgFromMnemonic`, `migratePqcKeyHybrid`.
- KEM: `msg.pqc.registerKemKey({ sender, publicKey })`, `msg.pqc.removeKemKey`, `fetchKemKey({ rest, address })`, `validateKemPublicKey`.
- Cross-VM: `createCrossVMClient`, `callAtomic`. Not needed.
- Browser: SDK is TypeScript with bundled noble libs. Browser support and WASM are not stated on the install page [U]. `@qorechain/react` exists, so browser use is intended.
- For the static verifier, use only `@qorechain/pqc` plus viem or plain `fetch`. Keep the page small.

### 5.3 `@qorechain/evm` [V] https://docs.qorechain.io/sdk/guides/evm, https://docs.qorechain.io/sdk/guides/ai-preflight
- `createEvmClient`, `evmAccountFromPrivateKey`, `erc20.*`, `readContract`, `precompiles.*`, window helpers.
- Send tx: not documented. Use a viem wallet client with `qorechainTestnet` from this package [U].
- `simulateWithRiskScore(publicClient, { from, to, data, value })` returns `{ gas, risk: { score, level }, anomaly: { anomalyScore, flagged }, safe }`. It throws on testnet because the AI precompiles (`0B01`, `0B02`) are not active. Wrap in try/catch. It is advisory only.

### 5.4 Sign In With QoreChain and QoreSign [V] https://github.com/qorechain/qoresign
`deriveClassicalKey({ mnemonic })`, `addressFromPublicKey`, `deriveCanonicalPqKey({ mnemonic, address })`, `signHybrid({ chainId, accountNumber, bodyBytes, authInfoBytes, classicalKey, pqKey })`, `verifyHybridTx({...})`. Pre-1.0, API may change. Browser support not stated [U].

---

## 6. Tooling

### 6.1 `create-qorechain-dapp` 0.12.0 [V] https://docs.qorechain.io/developer-tools/scaffolders-and-cli
```bash
npm create qorechain-dapp my-dapp
npx create-qorechain-dapp my-dapp --template <name> --network testnet --package-manager pnpm --yes [--no-install]
```
Templates: `evm-solidity`, `fullstack-web`, `rollup-app`, `foundry`, `hardhat`, `viem-wagmi`, `cosmwasm`. Details for the last four: https://docs.qorechain.io/developer-tools/chain-dev-sdk
- `foundry`: Counter, tests, deploy script, `pnpm window status|register|open`, `pnpm deploy:testnet`.
- `hardhat`: Hardhat 3 plus viem, Ignition deploy, same `pnpm window`.
- `viem-wagmi`: Vite, React, wagmi, RainbowKit, `@qorechain/qorex-rainbowkit`. The QoreX wallet does not yet support EVM signing methods. Connect and read only. Sign with an injected wallet.
- `fullstack-web`: Vite React. Its `.env` defaults to localhost. Set `VITE_QORE_REST_URL=https://api-testnet.qore.host` and `VITE_QORE_EVM_RPC_URL=https://evm-testnet.qore.host`.
- Known issues: `--network mainnet` does not change generated files. `evm-solidity` deploy script was not tested against a live network.

### 6.2 QoreX wallet
- Mobile (Android package `network.qore.qorex`, iOS 15.1+) and browser extension. Free. Testnet toggle in Settings. Extension 0.3.5 or app 1.1.5+ needed for the adapter's QoreX flows. Sources: qorex/getting-started, wallet-adapter pages.
- Sign In: faucet and Dashboard need a sign-in. The build site needs GitHub, X and a QoreX testnet address at registration (https://build.qorechain.io/rules).

### 6.3 Dashboard [V] https://docs.qorechain.io/dashboard/overview
- Testnet is custodial there (Dashboard manages a test wallet). Mainnet is non-custodial.
- Pages: Faucet, Explorer, Smart Contract Creator, Contract Auditor (AI Audit), Developers.

### 6.4 MCP server and `qore` CLI [V] https://github.com/qorechain/qorechain-mcp
```json
{ "mcpServers": { "qorechain": { "command": "npx", "args": ["-y", "@qorechain/mcp"] } } }
```
```bash
npx -y @qorechain/qore-cli pq status <TX_HASH>
npx -y @qorechain/qore-cli account qor1... --network mainnet --json
```
Tools (all take optional `network`, default testnet): `get_chain_info`, `get_block`, `get_transaction`, `get_address_info`, `get_pq_status`, `get_validators`, `get_staking_tiers`, `search`, `read_contract` (eth_call only), `estimate_fee`, `simulate_tx`, `prepare_transfer`. Unavailable: `get_token_holders`, `request_faucet`. Read only. It never signs.

### 6.5 QoreSeal (stretch, Encrypted Apps) [V] https://docs.qorechain.io/developer-tools/qoreseal
- ML-KEM-1024 plus X25519 hybrid (default) or `mlkem` only. AES-256-GCM payload, per-recipient wrapped key. Envelope size `56 + 1,664 x recipients + plaintext` bytes (hybrid).
- API: `generateSealKeys`, `deriveSealKeys({ mnemonic })`, `recipientOf`, `seal({ chainId, purpose, recipients, plaintext })`, `open({ chainId, purpose, envelope, keys })`, `envelopeToText` (`qoreseal:` base64url), `signRecipientCard`, `verifyRecipientCard`, `buildRegisterKemKeyMessage`, `@qorechain/qoreseal/network`: `fetchKemKey`, `resolveRecipient`, `sealToAddresses`.
- Chain ID and purpose are bound into key derivation but not stored in the envelope. Wrong values give `DECRYPTION_FAILED`.
- Registry: `MsgRegisterKEMKey` (type URL `/qorechain.pqc.v1.MsgRegisterKEMKey`, `algorithm_id = 2`). Needs a registered ML-DSA key. Query `GET /qorechain/pqc/v1/kem/{address}`. Errors 250 to 254 in codespace `pqc`.
- Draft crypto, "pending an external review before 1.0". Envelopes are not signed. Key loss means data loss. Browser support not stated [U].
- The fest rules for Encrypted Apps list: ML-KEM-1024 encryption, registered recipient keys, ML-DSA key binding, client-side encryption and decryption. [V] https://build.qorechain.io

---

## 7. Dev Fest requirements

Sources: https://build.qorechain.io, /rules, /about, /kits. The WebFetch tool paraphrases pages. I could not obtain verbatim text. Re-read the live pages before submitting.

### 7.1 Post-Quantum dApp category (as reported by the fetch of https://build.qorechain.io)
- Team size 1 to 3.
- "EVM dApp with post-quantum protection for sensitive actions."
- Requires: a scoped EVM window, `pqcVerify`, a two-stage QCAI audit, and Foundry or Hardhat tests.
- Prizes: 1st $1,500, 2nd $750, 3rd $500.
- Per-category rubric and weights are not published on /rules ("a jury scores each project against the rubric for its category"). [V gap]

### 7.2 Encrypted Apps (stretch)
- Team 1 to 4. ML-KEM-1024 encryption, registered recipient keys, ML-DSA key binding, client-side encrypt and decrypt. Prizes 1st $1,500, 2nd $750. Each project enters ONE category. Special awards can stack with it (not with Regional if you win another prize).

### 7.3 Submission (all projects) [V] https://build.qorechain.io/rules
- Public GitHub repo plus README.
- Featured image and a video of up to 3 minutes.
- The testnet address or addresses the project uses.
- Licence MIT or Apache-2.0 with the licence file in the repo.
- Credit open source libraries, kits and templates in the README. Copied projects are disqualified.
- Registration needs GitHub, X and a QoreX testnet address. One GitHub account per person. Age 18+.
- Checks: automatic plus manual. Finalists may get change requests with 48 h to respond.
- Special awards worth targeting: Best AI-Native Build ($500, needs `AI_USAGE.md` covering workflow, generated work and human contribution), Top-Quality (7 x $250, needs 70/100 or more and all checks), Regional Award (Europe, 5 x $200), Q-Day Survivor (5 x $200), People's Choice (QoreX vote on mainnet).

### 7.4 Dates (UTC) [V] rules and about pages
| Date | Event |
|---|---|
| 2026-11-04 | Building opened |
| 2026-11-17 23:59 | Q-Day Drill registration closes |
| 2026-11-18 | Q-Day Drill (00:00 to 23:59). Also "mid-hack challenges" |
| 2026-12-02 23:59 | Submission deadline |
| 2026-12-03 to 05 | Checks |
| 2026-12-06 to 15 | Judging and People's Choice vote |
| 2026-12-16 | Winners and live demo show |
| 2026-12-17 to 22 | Prize payout (stablecoin) |
| 2027-01 | QOR follow-on grants |

Workshop dates: not announced [V gap].

### 7.5 Q-Day Drill [V] https://build.qorechain.io/rules
1. Register before 17 Nov 23:59 UTC on your project page. Provide a fresh testnet account that never held mainnet funds, with an ML-DSA-87 key registered, its ECDSA private key, and up to five contract addresses.
2. On 18 Nov a bot uses the recovered ECDSA key to try native transfers, EVM windows, EVM transfers, token approvals and drain calls on your contracts.
3. During the drill make at least one normal tx from the account and submit its hash.
4. Ranking: by proof, then fewest successful attacks, then most value kept. The jury breaks ties on the threat model.
- Use a throwaway drill account. Never reuse its ECDSA key anywhere else. Rotate if exposed.
- Design effect for QoreWitness: the camera or anchor account should hold little value, scope its window to the registry only, and the registry must reject anchors whose ML-DSA signature fails. An attacker with only the ECDSA key cannot open a window (needs ML-DSA), cannot send hybrid Cosmos tx, and cannot write to the registry without a window. That is the story for the threat model. [U, my reading]

---

## 8. Known issues and gotchas (consolidated)

| Issue | Detail | Source |
|---|---|---|
| Code 21 `hybrid_verify_failed` | Wrong sign-bytes version, wrong chain ID, stale PQC lib, wrong or unregistered key. Use pqc >= 0.2.1 and SDK >= 0.8.1 | sdk/guides/quantum-safe, post-quantum-signing |
| "code 21 codespace pqc" on the faucet | Not mentioned on the faucet page or anywhere I read. Faucet errors documented: "Rate Limit Reached", "Transaction Not Found" (explorer on mainnet toggle). Ask on Discord [U] | faucet page |
| Faucet limits | 100 QOR plus 1,000 fUSD, 0.5 fETH, 0.02 fBTC per claim. One per 24 h per account and per address. Faucet form accepts only `qor1...`. Sign-in required | faucet page |
| No registered key or window | Codes 26, 27, 28 | evm-development |
| Nonce after window open | Window open advances nonce. Read nonce after | evm-development |
| Duplicate key registration | Chain refuses after taking the fee. Use `ensurePqcRegistered` | sdk/guides/quantum-safe |
| Weak or reused PQC key | Refused since v3.2.3 | version-history |
| SVM lane | Transaction submission disabled network-wide. Read only | wallet-setup |
| Gas floor | 0.1 uqor per gas. Lower is rejected | wallet-setup |
| Pre-EIP-155 tx | Refused. Always sign with chain ID | evm-development |
| `qor_*` JSON-RPC | Mostly planned, returns `-32601`. Only `qor_getKEMKey` works on testnet. Use REST | evm-development |
| Testnet reset | Can happen without notice | connecting-to-testnet |
| Docs version drift | Footers say v3.2.6, testnet runs v3.2.7. Mainnet v3.2.6 | multiple |
| Linked wallets (authenticators) | Enabled on testnet, disabled on mainnet. Check `/qorechain/abstractaccount/v1/config` | wallet-setup |
| Fest tokens | Denoms are case-sensitive. Not shown in Wallet tab. Use REST balances | faucet page |
| `convert-erc20` CLI | Broken on mainnet v3.2.6. Fix in v3.2.7 testnet | evm-development |
| Key file storage | `gen-key` writes an unencrypted file. Back it up like a mnemonic | wallet-setup |
| Tx size and data limits | No documented cap for EVM tx size or contract size. Request body cap is 256 KiB on nodes | evm-development |
| Python PQC | `qorechain-pqc` imports as `qorpqc`. No Windows wheel for QoreSeal Python | pqc docs, qoreseal docs |

---

## 9. Open questions

Ask in Discord (https://discord.gg/qorechain) or on the build site team page.

1. What is the "two-stage QCAI audit"? Not defined on build pages, rules, dashboard docs or the Contract Auditor page. The Contract Auditor is a single-pass AI review: 0 to 100 score, risk level, findings, PQ-readiness %, PDF export, first audit per UTC day free, extra testnet audits paid in test QOR (amount not stated), reports private by default and can be made public at `/audits`. Sources: https://docs.qorechain.io/dashboard/contract-auditor. Guess [U]: stage 1 audit, fix, stage 2 re-audit, with public report links in the README. Confirm before 2 Dec. Plan the first audit early, since only one free audit per UTC day.
2. Exact verbatim Post-Quantum dApp requirements and the rubric. Does "scoped EVM window" mean `allowed_targets`, `native_only`, or either? Is there an automated check?
3. `pqcVerify` details: context string, pure versus pre-hash, deterministic only or hedged, behaviour on wrong lengths, whether message length is capped.
4. Does `pqcKeyStatus` on testnet return the fourth value `possessionProven` today?
5. Is the account that sends the EVM anchor tx the same account whose key the contract reads with `pqcKeyStatus(msg.sender)`? For a coin-60 account, which signer and flow registers its ML-DSA key (`EthNativeSigner`, `signMode: "classical"`)? The `pnpm window` helper claims to do this. Verify by running it.
6. Can a relayer account submit the EVM tx on behalf of a device key? `pqcVerify` only needs pubkey, signature and message, so the contract could accept any sender, but "PQ protection on sensitive actions" is stronger if the sender's registered key signs. Decide.
7. Public endpoint rate limits and CORS for browser use of `evm-testnet.qore.host` and `api-testnet.qore.host`.
8. EVM block gas limit, max contract size, max tx input size on testnet.
9. Is `@qorechain/sdk` usable in a browser bundle (Vite) without polyfills? Not stated. QoreSeal and QoreSign browser support also not stated.
10. Fork testing of the testnet in Foundry: do precompile calls work under `--fork-url`? Likely not [U].
11. Test-net reset policy before 16 Dec judging. Judges may check anchors after a reset. Plan a re-anchor script and keep the OpenTimestamps proof as the fallback.
12. Does the QoreX testnet account need to be the same as the project account for registration and the Q-Day Drill?
13. OpenTimestamps and camera pipeline were outside the sources of this task and were not researched.
14. Production gap: QoreSeal and QoreSign are pre-1.0 and unreviewed. QoreWitness is a PoC. A production evidence tool would need: key custody for the ML-DSA key (HSM or secure enclave, the CLI stores keys unencrypted), mainnet precompile activation, legal review of evidentiary value, and a retention plan beyond testnet resets.

---

## 10. Source index

- Fest: https://build.qorechain.io , /rules , /about , /kits
- Docs: https://docs.qorechain.io/getting-started/quickstart , /wallet-setup , /first-transaction , /connecting-to-testnet
- Docs: https://docs.qorechain.io/developer-guide/evm-development , /evm-precompiles , /post-quantum-signing/ , /cross-vm-interoperability (page truncated on fetch)
- Docs: https://docs.qorechain.io/sdk/overview , /sdk/install , /sdk/quickstart , /sdk/concepts/accounts-pqc (truncated), /sdk/guides/quantum-safe , /sdk/guides/evm , /sdk/guides/ai-preflight
- Docs: https://docs.qorechain.io/developer-tools , /developer-tools/scaffolders-and-cli , /developer-tools/chain-dev-sdk , /developer-tools/pqc-library , /developer-tools/qoreseal , /developer-tools/wallet-adapter
- Docs: https://docs.qorechain.io/architecture/post-quantum-security , /dashboard/overview , /dashboard/faucet , /dashboard/contract-auditor , /qorex/getting-started , /qorex/security-and-recovery , /appendix/version-history
- Not readable in this session: https://docs.qorechain.io/appendix/networks (table empty on fetch), https://download.qore.host/testnet/latest.json (permission timeout), GitHub API for the org (refused).
- GitHub: https://github.com/orgs/qorechain/repositories , https://github.com/qorechain/qorechain-pqc , /qorechain-sdk , /qoreseal , /qoresign , /qorechain-mcp
- npm: `npm view` for each package, 2026-11-09. PyPI: `pip index versions qorechain-pqc`, `qorechain-sdk`.
