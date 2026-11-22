# Fees included: the pilot sponsor

Status: testnet pilot. Free. The sponsor sends test QOR, which has no value. No payment is collected.

The sponsor service pays the network fees of pilot cameras. It sends test QOR to the customer's own owner account, so the customer stays the owner of the camera and of its chain of anchors. The customer can stop the pilot at any time and pay fees from their own wallet. Nothing else changes: same owner, same device, same chain.

Code: `services/sponsor/`. Deploy files: `deploy/sponsor/`. Tests: `test/sponsor.test.ts` (chain and wallet mocked).

## How it works

The setup wizard of the box (`src/web/sponsor.ts`, `src/web/wizard.ts`) is the client. It enrols the camera before it registers it on chain, because a new owner account has no test QOR yet.

1. **Challenge.** The box asks for a nonce: `POST /sponsor/v1/challenge {"deviceId": "0x.."}`. The answer is `{nonce, expires, expiresAt}` (`expires` in unix seconds, `expiresAt` in ISO 8601). The nonce is 32 random bytes. It is valid for 5 minutes, for this device id, and for one attempt only.
2. **Enrol.** The camera's ML-DSA-87 key signs (empty context) the UTF-8 text

   ```
   qorewitness-sponsor-v1|9800|<registry>|<deviceId>|<owner>|<nonce>
   ```

   registry, deviceId and owner are lower-case `0x` hex. The service also accepts EIP-55 spelling for `registry` and `owner`. The box then sends `POST /sponsor/v1/enroll {deviceId, owner, nonce, signature, devicePubkey}`. `signature` (4,627 bytes) and `devicePubkey` (2,592 bytes) are `0x` hex. `devicePubkey` is required (HTTP 400 `bad_pubkey` without it). The box always sends it. No pilot code is needed. A `pilotCode` field is accepted and ignored.
3. **Checks on enrol.** The service deletes the nonce (single use, also when a later check fails). Then it reads `getDevice(owner, deviceId)` from AnchorRegistry v4 (`0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`). Devices are stored per owner, so an entry under `owner` proves that `owner` is the on-chain owner.
   - **Camera on chain (active).** The key must be the one on chain: `keccak256(devicePubkey)` must equal the key hash in the registry. The service never scans the chain history for a key. The signature must verify. The camera must pass admission (below). It is active at once. Answer: `enrolled`.
   - **Camera not on chain yet (bootstrap).** The signature must verify against `devicePubkey`. The camera must pass admission (below), and today's start grants must not be used up. The service binds owner, device id and `keccak256(devicePubkey)` together, marks the camera `pending` and sends one start grant to `owner` in the background (default 3 test QOR). Answer: `pending`. After the send: `funded`.
   - **Camera revoked.** Answer: `rejected`.
   - The signature check uses `@qorechain/pqc`, the same ML-DSA-87 code as the agent.
   - **Admission of a new camera.** At most 12 live cameras in the pilot, at most 2 per owner, and one new camera per client IP per UTC day. Otherwise the answer is `full` with a plain message. A retry of a camera that is enrolled already always gets its current answer.
4. **Start grant.** 3 test QOR cover the setup and the first hours of sealing:
   - ML-DSA-87 key registration of the account: about 0.1 test QOR,
   - EVM window open: 0.1 test QOR,
   - camera registration: 480,117 gas, about 0.054 test QOR charged (the balance must cover the maximum fee, about 0.15),
   - the wizard needs 2 test QOR before it starts (`MIN_SETUP_UQOR`). After setup about 2.6 test QOR are left. The first refill pass after activation tops the account up toward the buffer (below).
   - The grant is written as "unknown" before the send, so a crash never pays twice. A refused send is tried again (3 attempts at most). An unknown result is tried again once, and only when the owner still holds 0 test QOR after 10 minutes.
5. **Registration check.** Every pass looks at each `pending` or `funded` camera:
   - registered under `owner` with the enrolled key hash: `active`. Refills start from that moment,
   - registered under `owner` with another key, or revoked: `rejected`. No more payouts,
   - not registered within 48 hours of enrolment: expired (status word `rejected`). The camera gets no second start grant.
6. **Refill loop.** Every 15 minutes, per owner, for `active` cameras:
   - skip while the kill switch is on, or within 1 hour of the last payout (the start grant counts),
   - skip when the owner balance is 10 test QOR or more,
   - per device: skip when it is no longer active, or when its last anchored window ended more than 2 hours ago (`nextWindowStart` in the registry),
   - otherwise top up to the buffer: payout = 15 QOR minus the balance, cut to the camera, owner and global caps left today and the hot wallet float minus a 1 QOR reserve. No payout below 0.5 QOR. A buffer of 10 to 15 test QOR is about 1.5 to 2 days of sealing at 10-minute windows (about 6.9 test QOR per day),
   - when the payout would pass the hourly limit, it waits for a later pass. This never pauses the service,
   - one hybrid-signed (secp256k1 + ML-DSA-87) native `MsgSend` to the owner address. The service never takes a payout address from a request. The send path is `src/agent/bank.ts`, the same one the Q-Day drill uses for `fund` and `self-send`. Fee about 0.025 QOR. Grants and refills go out one at a time.
7. **Status.** `GET /sponsor/v1/status/<deviceId>` returns `status` (word below), `state`, `owner`, `startGrant`, `lastTopUp`, `usedTodayUqor`, `capPerDayUqor` and `paused`. HTTP 404 when the camera is not enrolled. When two owners use the same device id, add `?owner=0x..`.
8. **Health.** `GET /sponsor/healthz` returns `ok`, `paused` and the number of live cameras.

Amounts in answers are in uqor (1 QOR = 1,000,000 uqor), as decimal strings.

### Status words

The wizard reads exactly these words in `status`. The service no longer sends `invalid_code` or `used_code` (no pilot codes).

| Word | Meaning | HTTP on enrol |
|---|---|---|
| `enrolled` | Accepted, the camera is on chain already | 200 |
| `pending` | Accepted, start grant not sent yet | 200 |
| `funded` | Start grant sent, waiting for the camera registration | 200 |
| `active` | On chain with the enrolled key, refills apply | 200 |
| `full` | Pilot full, owner has 2 cameras, IP has a new camera today, or today's start grants or budget used up | 409 |
| `paused` | Kill switch on (also for a `pending` camera in status) | 423 |
| `rejected` | Bad signature, wrong key, revoked, or expired | 403 |

Malformed requests (bad hex, bad nonce) get HTTP 400 without a status word.

## Limits (defaults, `deploy/sponsor/sponsor.env.example`)

| Limit | Default |
|---|---|
| Start grant | 3 test QOR, once per camera (owner and device id), at most 6 per UTC day |
| Pending camera | expires 48 h after enrolment without registration |
| Per camera per UTC day | 9 test QOR (one camera uses about 6.9 per day) |
| Per owner per UTC day | 18 test QOR |
| Global per UTC day | 90 test QOR (start grants count) |
| Live cameras | 12 in total, 2 per owner (pending, funded, and active cameras that sealed in the last 48 h) |
| Balance | top up below 10, never above 15 test QOR |
| Payouts | at most 1 per owner per hour, at least 0.5 test QOR |
| Hourly outflow | 30 test QOR. A payout that would pass it waits for a later pass |
| Float check | automatic pause when the hot wallet drops more than the payouts and fees since the last pass explain, plus 1 test QOR |
| Rate limits per IP per minute | challenge 10, enrol 5, status 30, healthz 60 |
| New cameras per client IP | 1 per UTC day (counted in memory only) |

One faucet claim (100 test QOR per 24 h) covers about 14 cameras at 10-minute windows. For more cameras, ask the QoreChain team for a pilot allocation.

The sponsor keeps a buffer of 10 to 15 test QOR on the owner account. The start grant counts toward the camera day cap, so on day one the account reaches about 8.6 test QOR and on day two the full 15. The runway after a sponsor stop is the balance the owner holds: at least about 1.4 days once the buffer is built.

Abuse limits of the start grant:
- Anyone can make a camera key and an owner address and get 3 test QOR (two grants in the rare "unknown result" retry). Residual risk, accepted for the pilot: the coins are test tokens. Limits: 6 start grants per day (18 test QOR), one new camera per IP per day, 12 live cameras.
- Someone with many IPs could take all 12 places with fake cameras. Expired cameras free their place after 48 h. An active camera that has not sealed for 48 h frees its place too. It stays enrolled, and refills start again when it seals again. Mitigation if it happens: pause the sponsor, check `state.json`, and lower `SPONSOR_MAX_GRANTS_DAY`.
- An owner can move the grant away and never register. The camera then expires after 48 h and gets no second grant.
- The IP counter lives in memory. A restart of the service resets it.
- Refills are tied to sealing: only a camera that sealed in the last 2 hours gets one. An owner who moves the buffer away gets it back at most up to the camera cap (9 test QOR per day), as long as the camera seals. Residual risk, bounded by the owner and global caps.

## Kill switch

- Pause: `sudo touch /var/lib/qw-sponsor/PAUSED`. The service checks the file before every pass and before every payout. Enrol answers `paused` (HTTP 423). Status shows `paused: true`. Start grants and refills wait.
- Resume: `sudo rm /var/lib/qw-sponsor/PAUSED`.
- Automatic pause: the service writes the file itself only for a real anomaly. Each pass compares the hot wallet balance with the last pass. If it dropped more than the payouts and their fees explain, plus `SPONSOR_FLOAT_SLACK_QOR` (1), the key may be stolen or a payout went out twice. Money added by hand is fine. The hourly limit never pauses: a payout that would pass it waits. The file holds the reason. Read it before you resume.
- There is no admin HTTP endpoint.
- When paused, recorders keep recording. Anchors stop when the owner runs out of test QOR, and the gap shows on chain.

## Hot wallet

- A fresh hybrid testnet account, used for nothing else. Never a mainnet or personal phrase.
- The recovery phrase is in `/etc/qw-sponsor/secret.env` (mode 600, owner `qw-sponsor`). The service refuses a file that group or others can read. It reads the file once at start. The phrase never goes into the environment, a log line or an HTTP answer.
- Keep a small float: at most about 2 days of the global cap (200 test QOR). The service warns above `SPONSOR_MAX_FLOAT_QOR` and alerts when the float is below one day of the global cap. Refill it by hand from a separate treasury test account.
- The service refuses to start, and every pass stops, unless the EVM chain id is 9800 and the Cosmos network is `qorechain-diana`. There is no mainnet setting.
- Risk: the pilot runs the hot wallet on the web host. A stolen key loses test QOR only. Later: a separate host and a secret store (Azure Key Vault) or KMS signing.

## Records

- `state.json`: enrolments (owner, device id, key hash, state, start grant, enrol time, anchors paid), usage per day (with the number of start grants), payouts of the last 2 days. Written atomically (temp file, fsync, rename).
- `payouts.jsonl`: append-only. Time, kind (`grant` or `refill`), owner, device ids, amount, status (`pending`, `sent`, `refused`, `unknown`) and tx hash. A payout is written as `pending` before the send. When the result is unknown, it stays counted, so a restart never pays twice.
- Review the top 5 receivers once a week.

## Privacy

- No email, no accounts, no names, no pilot code. An owner address and a camera signature are enough.
- The service stores owner address, device id and the hash of the camera public key. It never stores IP addresses on disk.
- IP addresses are used in memory for rate limits and the one-camera-per-day rule only. They are gone at the end of the UTC day or on a restart. Log lines carry truncated IPs (IPv4 /24, IPv6 /48). nginx writes no access log for `/sponsor/`.
- Logs go to their own journald namespace (`qw-sponsor`) with 14-day retention (`journald@qw-sponsor.conf`). Log lines hold no secrets and no request bodies. Device ids are shortened.
- `state.json` and `payouts.jsonl` are kept until 3 months after the pilot ends, then deleted.
- Owner address, payouts and anchors are public on the testnet chain and cannot be deleted there.

## Deploy (lead)

On the web host, as root. Read each step before you run it.

1. `useradd --system --home /var/lib/qw-sponsor --shell /usr/sbin/nologin qw-sponsor` and `install -d -m 750 -o root -g qw-sponsor /etc/qw-sponsor`.
2. Node 22 from the official tarball in `/opt/node` (check it against `SHASUMS256.txt`), then the repo in `/opt/qorewitness` at this commit and `pnpm install --frozen-lockfile --ignore-scripts`. The service starts `tsx` with `node` directly, so the service user needs no pnpm or corepack cache.
3. Settings: `install -m 640 -o root -g qw-sponsor deploy/sponsor/sponsor.env.example /etc/qw-sponsor/sponsor.env`.
4. Hot wallet, as `qw-sponsor` in a private folder:
   - `install -d -m 700 -o qw-sponsor /var/lib/qw-sponsor/setup`, then in that folder `sudo -u qw-sponsor /opt/qorewitness/node_modules/.bin/tsx /opt/qorewitness/scripts/new-account.ts`. It writes `.env` (mode 600) and prints the addresses only.
   - Fund the printed `qor1` address with test QOR: from another test account of ours (`scripts/qday-drill.ts fund <qor1> <qor>`) or the faucet.
   - Register the ML-DSA-87 key: in `/opt/qorewitness`, `sudo -u qw-sponsor node_modules/.bin/tsx --env-file=/var/lib/qw-sponsor/setup/.env scripts/window.ts register`.
   - Move the phrase: `sed -n 's/^QORE_MNEMONIC=/SPONSOR_MNEMONIC=/p' /var/lib/qw-sponsor/setup/.env > /etc/qw-sponsor/secret.env`, then `chown qw-sponsor /etc/qw-sponsor/secret.env && chmod 600 /etc/qw-sponsor/secret.env` and `shred -u /var/lib/qw-sponsor/setup/.env`.
5. Logs: `cp deploy/sponsor/journald@qw-sponsor.conf /etc/systemd/`.
6. Service: `cp deploy/sponsor/qw-sponsor.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now qw-sponsor`. Check `journalctl --namespace=qw-sponsor -u qw-sponsor -f` for `start` and `listening`.
7. nginx: add `deploy/sponsor/nginx-sponsor.conf` to the site's 443 server block, `nginx -t && systemctl reload nginx`. Check `curl -s https://qorewitness.fnoufnou.com/sponsor/healthz`.
8. Alerts: forward log lines with `"level":"alert"` to Telegram (as `qw-health.sh`). Events: `float_low`, `float_empty`, `auto_pause`, `top_up_unknown`, `start_grant_unknown`, `grant_failed`, `rejected`, `pass_failed`, `http_error`.
