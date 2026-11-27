# QoreWitness threat model

Version of 19 Nov 2026 (first draft 11 Nov), reviewed by fnoufnou. Scope: one home recorder box, its cameras, the agent account, the registry contracts and the browser verifier.

## Two scopes: the beta now, the product later

| | Beta (testnet, now) | Product (later) |
|---|---|---|
| Network | QoreChain testnet (qorechain-diana) | QoreChain mainnet |
| Purpose | Prove that the mechanism works, end to end, in public | Evidence that must hold for years |
| How long records must last | Until the end of the evaluation. The team says diana will not reset before 15 Dec 2026. After that, a reset can remove every record. | 5 to 15 years or more |
| Who pays for anchors | Free test QOR. The free beta fee sponsor tops up, or the owner uses the faucet (Self-managed) | To be decided with the business model. One option: a paid subscription in which the QoreWitness operator arranges the QOR as part of the plan |
| Evidence value | None promised. A beta record demonstrates the method. It is not evidence. | The claims below |

The claims in this document describe the product. Where a control works only in the beta, or only in the product, the tables say so.

## What QoreWitness claims

1. A video segment with hash H existed no later than the block time of its anchor.
2. The anchor was signed with the ML-DSA-87 key of a known signer, for a known device.
3. The segment was not changed after the anchor.
4. The segment is part of one continuous stream. Each segment commits to the one before it, and each 10-minute window commits to the previous window on chain. So every earlier segment of that camera existed before this one, in this order, and a removed, inserted or re-ordered segment shows. A gap in recording is visible on chain, with its start and length.
5. The window was signed after a recent block. Together with claim 1, this bounds the time from both sides: not before block N, not after block M.

Claim 4 adds something that a single time stamp cannot give. A single stamp proves that one clip existed at a time. The chain proves that the clip sits in an unbroken recording, so nobody can pick a convenient clip and leave out what came before or after it.

## Design goal

QoreWitness targets the unforeseen. When something happens that nobody planned, such as a break-in, an accident or a dispute, it closes the window of time in which one party could later change the footage in its favour. Within minutes of recording, the footage is sealed.

It does not aim to stop deception that is planned in advance, such as a recorder that someone has compromised before an incident, with knowledge of what to fake. That is out of scope for any seal that starts at the recorder. Signing inside the camera narrows it.

## What it does not claim

- It does not show that the scene in front of the camera was real, or who was in it. A staged scene or a fake stream is sealed the same way as a real one.
- It is not an eIDAS qualified time stamp. eIDAS is the EU regulation on electronic identification and trust services. A qualified time stamp comes from a qualified trust service provider: a company that a national supervisor has audited and placed on the EU trusted list. Such a stamp has a legal presumption of accuracy in every EU member state, so the other party must prove it wrong. QoreWitness is not such a provider, and a public blockchain is not a supervised service. So a court can accept a QoreWitness record as evidence, but weighs it as ordinary evidence, and the party that relies on it may have to show how it works.

## Assets

From here on, the document is written for technical reviewers.

| Asset | Why it matters |
|---|---|
| Segment hashes and Merkle roots on chain | The proof itself |
| Device and signer ML-DSA-87 keys | Whoever holds them can anchor in the owner's name |
| Agent account ECDSA key | Pays gas. With a scoped window it can only call the registry |
| Original video files and receipts | Needed to rebuild the proof |
| Verifier code | A changed verifier can show "valid" for a fake |
| Privacy of the household | Footage stays at home. Only hashes leave |

## Adversaries

| # | Adversary | Goal |
|---|---|---|
| A1 | Someone who edits a clip later (also the owner) | Present a changed clip as original |
| A2 | Backdater | Make a new clip look older |
| A3 | Quantum attacker (Q-Day) | Use a broken ECDSA key to forge anchors or drain the agent |
| A4 | Intruder on the recorder box | Sign and anchor arbitrary files live |
| A5 | Attacker on the home LAN | Feed or change the RTSP stream |
| A6 | Chain-level failure or collusion | Erase or reorder anchors |
| A7 | Attacker on the verifier supply chain | Make the verifier accept fakes |
| A8 | Observer of the public chain | Learn household activity from anchors |

## Threats and controls

| Threat | Control | Status |
|---|---|---|
| A1 changes a segment | SHA-256 leaf per segment, Merkle path to the on-chain root. One changed byte fails the check. | Done, tested |
| A1 drops, swaps or re-records a segment | Every segment commits to the previous one (start time, length, stream fingerprint). Every window commits to the previous root on chain. A change breaks the chain where everyone can see it. Gaps between windows are stored on chain. | Done (v4, 14 Nov) |
| A2 anchors a new clip in an old window | Windows per (signer, device) only move forward and must not overlap. A window must end before block time (120 s skew). | Done, tested |
| A2 anchors a late window with an old start time | The block time limits the claim from above. Since v4 the camera also signs a recent block hash, which limits the claim from below: signed after block N, anchored before block M. The window start is only what the signer says. | Done (v4, 14 Nov) |
| A3 forges an anchor with a broken ECDSA key | The contract checks an ML-DSA-87 signature over each root with `pqcVerify`, against the chain's registered key. | Done |
| A3 drains or misuses the agent account | EVM transactions need a hybrid signature and an open window. The agent window is scoped to the registry only (`allowed_targets`). Drill dry run: 13 attacks, 0 succeeded. | Done |
| A3 registers a rogue key | `requirePossessionProof = true`. Device register, revoke and key rotation need fresh ML-DSA-87 signatures (rotation needs old and new key). | Done (v2) |
| A4 anchors fake files from the box | Out of reach for a hash anchor. Limit: keys in files with mode 600, a separate `dev` user, no inbound ports. Revoke the device on chain after a breach. Custody drill S1: a careful swap before hashing is not caught. | Partial (see Chain of custody) |
| A5 injects a fake stream | A stream with other settings is flagged (custody drill S2, S3). A stream with the camera's own settings is not. Plan: cameras on a separate network, password on RTSP where the camera supports it. The LSC camera has no RTSP password today. | Partial |
| A6 testnet reset or halt (beta) | Accepted for the beta: beta records carry no evidence value. Receipts keep the transaction and block data, so a demo can be re-run on a new network. | Accepted |
| A6 chain fails or disappears (product) | Planned: a portable evidence bundle (receipts, transactions, block data), re-anchoring of old roots on a successor network, and an optional second record on another chain. | Roadmap |
| A6 validators collude | 8 validators, all likely team-run. Accepted for the beta. For the product, the security of the mainnet validator set is a dependency, and an optional second record on another chain reduces it. | Beta: accepted. Product: roadmap |
| A7 changed verifier | Single static HTML file with its SHA-256 on the demo site. Receipts name the release and commit. `docs/SPEC.md` and an independent Python check with only the standard library. Signed releases still open. | Mostly done (T22) |
| A8 learns activity from anchor timing | Fixed cadence: one anchor per 10 minutes, independent of motion. Leaf count stays constant with 60-second segments. Hashes reveal no content. | Done |
| A9 another device on the home network, or a web page in the owner's browser, takes over the browser setup or the dashboard | Pairing token or 6-digit code (shown only in the installer terminal), then a scrypt password and signed sessions. Host allowlist against DNS rebinding, Origin must match Host, CSRF token per session, private clients only, no proxy headers. Secrets are never shown back. Camera passwords are masked in logs. | Done (0.6, browser setup) |

## Post-quantum rationale

- For the product: evidence is often needed years after recording. Insurance claims, disputes and court cases can take 5 to 15 years. The beta has no such horizon.
- To our knowledge, a quantum computer that breaks ECDSA within that period is a real possibility. NIST plans to phase out ECDSA and RSA by 2035.
- A hash commitment (SHA-256, since spec/3 also SHA3-256) likely stays strong against quantum attack. The weak link is the signature that ties a root to a device and owner.
- ML-DSA-87 (FIPS 204, level 5) keeps that link valid after Q-Day. The on-chain check means nobody has to trust our software for that part.

## Residual risks

- A compromised recorder can anchor fake files in real time. This is deception planned in advance, outside the design goal.
- A fake or staged camera feed is anchored as if real. Camera-side signing narrows this. Staging in front of the lens stays.
- QoreChain libraries are pre-1.0. An API change can break the agent.
- A network upgrade can change how the PQC precompiles answer. By design the contract then refuses anchors (fail closed): an empty or short answer reverts. A halted anchor is visible and harmless. A wrongly accepted one would not be.
- The `ui` container serves the setup and the dashboard with `/data` mounted read-write. During setup it reads the recovery phrase from its file to sign. As soon as `setup.done` exists, the process locks itself: every read of `qorewitness.env` or `keys/` through the setup code throws (`lockSecrets` in `src/setup/steps.ts`, with tests). The owner sees nothing of this. Residual risk: the files stay on the same volume with the same user id, so a bug that runs code in the dashboard process (not only a wrong read) can still reach them. A separate one-shot setup container would close this, at the cost of one more service and a port hand-over. Not done before the submission (keep it simple).
- The setup and the dashboard use plain HTTP on the home network. Someone on the same Wi-Fi can read the dashboard password or the camera password while it is typed.
- The verifier depends on a public RPC to read the chain. A wrong RPC can lie. Mitigation: the Python check and a second RPC.

## Running out of funds

Funds affect new anchors only. They never touch existing records.

- An anchor that exists stays valid when the account is empty. Nobody can change or remove it.
- Without funds the agent stops anchoring. Recording goes on, and the footage of that time has no proof.
- When anchoring resumes, the chain shows the gap on chain, with its start and length. A verifier sees it. Nobody can fill it later with a backdated window.

| Scope | Risk | Control |
|---|---|---|
| Beta (Self-managed) | The faucet stops or its limit is too low (about 5 test QOR per day per camera) | Health check sends a Telegram message below 10 test QOR. Top up from the faucet. |
| Beta | The owner does not see that fees run low | The dashboard turns orange below 3 days of fees (Self-managed) and red when sealing stops. In the free beta the fee sponsor tops up. |
| Product | The QOR budget runs out (the owner's own, or the operator's in a subscription plan) | Balance alert, a budget per camera (about 144 anchors per day), and an option for a longer window at lower cost. |

## Chain of custody

Where the record starts: the moment the recorder hashes a segment. From then on, a change, removal, re-ordering or rewrite breaks the chain. Before that moment, QoreWitness trusts what reaches the recorder.

Custody drill of 14 Nov (`docs/CUSTODY_DRILL.md` in the repo): 10 attacks on the footage, no keys involved.

- After anchoring: 5 of 5 rejected (changed byte, removed clip, re-ordered clips, wrong receipt, re-recorded window).
- Before hashing: 4 of 5 flagged with a visible warning (clip from another camera, re-encoded clip, deleted clip, inserted clip).
- Not caught: a swap before hashing with footage that has the camera's own settings. This is the trust boundary.

Measures that shrink it:

- Cameras on their own network, with a password on the stream (planned for the beta).
- Shorter windows: less time to prepare a fake, at a higher gas cost.
- Camera-side signing: the camera signs its own video.

## Signing boundary

The key question for hardware work: how much of the capture path sits inside the part that signs? Everything outside it can feed synthetic frames, and a valid signature then proves nothing about the scene.

| Level | What signs | Inside the boundary | Outside the boundary | Status |
|---|---|---|---|---|
| 0 | The recorder (device key in a file) | Hashing, chaining, anchoring | Sensor, camera firmware, network, stream | Today (beta) |
| 1 | The camera signs its encoded video (for example ONVIF media signing or a vendor's signed video). QoreWitness anchors those signatures. | Encoder output onward | Sensor and image pipeline inside the camera | First hardware step, after the event |
| 2 | A secure capture path next to the sensor (C2PA-capable devices) | Sensor readout onward, as far as the hardware allows | Physical staging in front of the lens | Depends on hardware |

Decisions:

- Hardware work starts at level 1: the camera's own signature, anchored by QoreWitness. To our knowledge only a few professional cameras support this today, so the home beta likely stays at level 0 for some time.
- A TPM on the recorder does not move the boundary. It proves that the recorder signed and ran unchanged software, not that the frames were real. Later, it can protect the device key. Low priority.
- No level removes staging in front of the camera. The legal limits section stays.

Credit: the QoreChain founder raised the TPM limit on X (14 Nov 2026).

## Hashes: which fingerprint decides

- Since spec/3 every file gets SHA-256 and SHA3-256. The two designs differ (Merkle-Damgard and sponge), so a forger must break both at once.
- Both are required. A segment is verified only when both match. A verifier that did not compute SHA3-256 reports "partly verified", never "verified".
- Risk: a fault in one hash implementation shows a mismatch on good evidence.
  - Control: the file and the receipt never change, so the evidence stays. Recompute with a second independent tool (OpenSSL, Python) before a conclusion. Our verifiers are tested against the FIPS test vectors.
- Risk: the segment links and the Merkle tree above the files use SHA-256 only.
  - Control: their inputs are hash outputs that an attacker cannot shape freely, so a structural attack is likely much harder there. A full break of SHA-256 needs a new spec version.
