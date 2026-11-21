# Design: owner key offline with an agent key (T31)

Status: design of 17 Nov 2026, confirmed by a testnet spike on 20 Nov 2026 (8 of 8 checks passed, details in `docs/TESTNET_FINDINGS.md`). Based on `@qorechain/sdk` 0.14.0 and the QoreChain team's answers of 15 and 16 Nov 2026. The agent does not use this mode yet.

## Problem

Today the agent holds the owner's recovery phrase. It needs it for two reasons:

- Every anchor is an EVM transaction from the owner account, and every EVM transaction needs an open EVM window.
- Opening or renewing a window needs the owner's own hybrid signature (ECDSA and ML-DSA-87).

So the key that controls the camera registry and the account's funds sits on the recorder, online, all the time.

## What QoreChain offers

Authenticator lanes (abstract accounts, chain v3.1.85 and later):

- The owner links an extra key to the account with `MsgRegisterAuthenticator`. The key is classical: secp256k1 or ed25519. It proves possession with a signature over a fixed link text (from v3.2.8).
- The link has permissions (`evm` for contract calls), an expiry (at most the chain's session limit, about 30 days according to the team) and the account's spending rule.
- A spending rule can list the only EVM calls the key may make: `0x<contract>/0x<selector>` allows one function of one contract. It must also bound the value the key may move.
- The linked key signs a digest over chain id, account, key, target, value, call data, its own sequence number and the gas limit (`qorechain-evm-auth-v2`).
- A relayer wraps that in `MsgExecuteEVM`, signs the outer transaction with its own hybrid key and pays the fee. The chain runs the call **from the owner account's EVM address**, so `msg.sender` is the owner. No EVM window is needed.
- A failed execution after the checks still uses up the sequence number (v3.2.8), so a signed call cannot be replayed.
- Only the owner (root key) can link, revoke or re-link a key.

## Design

| Role | Key | Where | Can do |
|---|---|---|---|
| Owner | Hybrid (ECDSA + ML-DSA-87), from the recovery phrase | Offline (paper, or a wallet such as QoreX) | Register, rotate and revoke cameras. Link and revoke the agent key, once a month |
| Agent key | secp256k1, random, per recorder | On the recorder, file mode 600 | Call `anchor(...)` on the registry, nothing else, no value |
| Relayer | Hybrid account with its own recovery phrase | On the recorder | Pay fees. Holds only fee money (for example 5 test QOR) |
| Camera key | ML-DSA-87 | On the recorder | Sign window roots. Unchanged |

Spending rule for the owner account:

- `allowed_evm_calls`: `["0xa1378D6558B32e1f8d37b68cf90e3C93839Da365/0xb813aa2a"]` (registry v4, `anchor`)
- `per_tx_limit` and `daily_limit`: 1 base unit. An anchor moves no value, and the chain requires a rule that bounds something.
- `permissions` of the agent key: `["evm"]` only.

**No contract change.** The registry already stores `msg.sender` as the camera owner, and `msg.sender` stays the owner.

## What an attacker gets

- **Stolen agent key** (or a future quantum attack on it, because it is classical): the attacker can only call `anchor` on our registry from the owner account. Every anchor still needs the camera's ML-DSA-87 signature over the claim, which the contract checks with `pqcVerify`. So no fake evidence. The attacker must run and pay for their own relayer. They can use up sequence numbers, which delays our anchors until the owner revokes the key.
- **Stolen relayer key:** the attacker gets the fee money in the relayer account, nothing else.
- **Stolen recorder (all three keys):** fee money and anchor calls that still need a valid camera signature. With the camera key too, the attacker could anchor footage of their own as this camera until the owner revokes it. The same is true today.
- **The owner key** never touches the recorder.

Compared with today, a compromised recorder no longer exposes the owner account, its funds or the right to register cameras.

## Costs and limits

- The owner must re-link the agent key before it expires, about every 30 days. The dashboard (T25) shows the expiry date and warns 7 days ahead.
- Two accounts per installation (owner and relayer) and one extra key. The setup wizard creates them.
- Fees stay about the same (one EVM call per window, about 0.1 test QOR), paid by the relayer.
- Testnet only for now: the team says abstract accounts are not on mainnet yet.

## Open questions (Workshop 2 list, 17 Nov)

1. Can a builder run their own relayer, and are there limits on it?
2. What does the agent see when its link expires: a clear error code?
3. Is the session limit exactly 30 days on testnet?

## Spike plan (after the drill)

1. On the test owner `custody-test`: create a secp256k1 agent key and a relayer account.
2. Send `[MsgUpdateSpendingRules, MsgRegisterAuthenticator]` signed by the owner (`linkAuthenticatorMsgs`).
3. Anchor one window through `MsgExecuteEVM` from the relayer, with the agent key's signature. Check that the record shows the owner, and that no EVM window was open.
4. Try a call to another contract and a value transfer with the agent key: both must fail.
5. Revoke the key and check that the next anchor fails.
6. Write the result in `docs/TESTNET_FINDINGS.md` and decide whether the agent switches to this mode before the submission.

## Decision (21 Nov 2026)

The spike works, but relayed calls emit no EVM logs and have no EVM transaction hash (`docs/TESTNET_FINDINGS.md`). The receipt format, the Python verifier and crash recovery each need a second path for relayed anchors. Before the submission on 1 Dec, the tester release and the browser setup come first. So:

- The live agent stays in direct mode until the submission.
- Agent-key mode is built as an option behind a setting, with the three changes above, after the tester release.
- The submission shows the spike, the design and the decision.

