# Custody drill: substitute the input

14 Nov 2026, qorechain-diana, registry v4 `0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`, test camera `custody-test` (owner `0x181A21311797E258B346e7728E43Ae782fa41Ab7`, a separate test account).

The Q-Day Drill attacks keys. This drill never touches a key. It swaps, removes, adds or changes footage at the points where an attacker can reach it, anchors every window on chain for real, and checks the result with the same verifier a third party uses. The idea came from QoreChain founder Liviu Epure, in reply to our first drill post.

Run it yourself: `scripts/custody-drill.ts` (needs ffmpeg, a funded test account and a registered test camera).

## Results

| Result | Meaning |
|---|---|
| DETECTED | The verifier fails. The evidence is rejected. |
| FLAGGED | The verifier passes the clip, but the record shows a visible warning (gap, overlap, stream change). |
| MISSED | The verifier passes without a warning. |

| # | Attack | When | Result | Evidence |
|---|---|---|---|---|
| B0 | No attack (baseline) | - | passes | all checks pass |
| S1 | Swap a clip before hashing, with footage from the same camera settings | before anchoring | **MISSED** | all checks pass |
| S2 | Swap a clip before hashing, footage from another camera | before anchoring | FLAGGED | stream changed at segments 3 and 4 |
| S3 | Re-encode a clip before hashing (to hide an edit) | before anchoring | FLAGGED | stream changed at segments 3 and 4 |
| S4 | Delete a clip before hashing | before anchoring | FLAGGED | gap of 10 s before segment 3 |
| S5 | Insert a fabricated clip with an overlapping time | before anchoring | FLAGGED | overlap of 5 s at segments 3 and 4 |
| A1 | Change one byte of an anchored clip | after anchoring | DETECTED | file fingerprint not in the receipt |
| A2 | Remove a clip from the receipt (hide a moment) | after anchoring | DETECTED | segment chain inside the window is broken |
| A3 | Re-order clips in the receipt | after anchoring | DETECTED | segment chain inside the window is broken |
| A4 | Present a clip with another window's receipt | after anchoring | DETECTED | file fingerprint not in the receipt |
| A5 | Anchor a new version of an already anchored window | after anchoring | DETECTED | contract refused: `WindowOverlap` |

## What this means

- **After anchoring, the record holds.** Every change, removal, re-ordering or rewrite was rejected. Before v4, A2 and A3 would have needed the owner to notice a missing file. Now the chain itself breaks.
- **Before anchoring, careless substitutions show.** A clip from another camera, a re-encoded clip, a deleted clip and an inserted clip each leave a visible mark in the record. A verifier sees it next to the clip.
- **A careful substitution before hashing is not caught (S1).** An attacker who controls the recording path and feeds footage with the same encoder settings gets a valid record. This is the boundary Liviu pointed at. QoreWitness proves what reached the recorder, from the moment it was hashed. It cannot prove what happened in front of the camera, or inside it.

## How we shrink the remaining risk

| Measure | Effect on S1 | Status |
|---|---|---|
| Cameras on their own network, with a password on the stream | Fewer people can reach the stream | Planned for the home pilot |
| Recorder hardening (separate user, keys mode 600, no inbound ports) | Fewer people can reach the folder | Done |
| Shorter windows (a higher anchoring rhythm) | Less time to prepare a fake. Costs more gas. | Configurable (`QW_WINDOW_SECONDS`) |
| Keys in a TPM on the recorder, measured boot | Shows that the recording software was not changed | Roadmap |
| Capture-time signing in the camera (C2PA) | Moves the starting point of the chain into the camera | Roadmap |

Untested in this run: a fake RTSP server that feeds fabricated video from the start. It falls in the same class as S1: undetected if it matches the camera's settings, flagged if it does not.
