# Fees included: the pilot sponsor

Status: testnet pilot. Free. The sponsor sends test QOR, which has no value. No payment is collected.

The sponsor service pays the network fees of pilot cameras. It sends test QOR to the customer's own owner account, so the customer stays the owner of the camera and of its chain of anchors. The customer can stop the pilot at any time and pay fees from their own wallet. Nothing else changes: same owner, same device, same chain.

Code: `services/sponsor/`. Deploy files: `deploy/sponsor/`. Tests: `test/sponsor.test.ts` (chain and wallet mocked).

## How it works

1. **Challenge.** The recorder asks for a nonce: `POST /sponsor/v1/challenge {"deviceId": "0x.."}`. The answer is `{nonce, expires, expiresAt}`. The nonce is 32 random bytes. It is valid for 5 minutes, for this device id, and for one attempt only.
2. **Enrol.** The camera's ML-DSA-87 key signs (empty context) the UTF-8 text

   ```
   qorewitness-sponsor-v1|9800|<registry>|<deviceId>|<owner>|<nonce>
   ```

   All four values are `0x` hex in lower case. The service also accepts EIP-55 spelling for `registry` and `owner`. The recorder then sends `POST /sponsor/v1/enroll {pilotCode, deviceId, owner, nonce, signature}`. `signature` is hex (4,627 bytes).
3. **Checks on enrol.** The service:
   - deletes the nonce (single use, also when a later check fails),
   - checks the pilot code against the hashed list,
   - reads `getDevice(owner, deviceId)` from AnchorRegistry v4 (`0xa1378D6558B32e1f8d37b68cf90e3C93839Da365`). The device must be active. Devices are stored per owner, so an active entry proves that `owner` is the on-chain owner,
   - reads the device public key from a registry transaction on chain (the newest `anchor`, `rotateDeviceKey` or `registerDevice` call of this device) and accepts it only when `keccak256(key)` equals the key hash in the registry,
   - verifies the signature with `@qorechain/pqc` (the same ML-DSA-87 code as the agent).
   - A device must have anchored or registered within about 2 days (`SPONSOR_KEY_LOOKBACK_BLOCKS`). Otherwise the answer is `409 key_not_found`.
4. **Top-up loop.** Every 15 minutes, per owner:
   - skip while the kill switch is on, or within 1 hour of the last payout,
   - skip when the owner balance is 10 test QOR or more,
   - per device: skip when it is no longer active, or when its last anchored window ended more than 2 hours ago (`nextWindowStart` in the registry),
   - credit = anchors seen on chain since the last payout x 0.048 QOR. This is the measured fee of 0.0457 QOR per anchor plus a share of the EVM window opens. At most one anchor per 10 minutes counts, so tiny windows cannot farm the sponsor,
   - payout = the smallest of: the credit, the caps left today, 15 QOR minus the balance, the hot wallet float minus a 1 QOR reserve, and the hourly limit left. No payout below 0.5 QOR,
   - one hybrid-signed (secp256k1 + ML-DSA-87) native `MsgSend` to the owner address from the chain. The service never takes a payout address from a request. The send path is `src/agent/bank.ts`, the same one the Q-Day drill uses for `fund` and `self-send`. Fee about 0.025 QOR.
5. **Status.** `GET /sponsor/v1/status/<deviceId>` returns `enrolled`, `owner`, `lastTopUp` (time, amount, tx), `usedTodayUqor`, `capPerDayUqor` and `paused`. When two owners use the same device id, add `?owner=0x..`.
6. **Health.** `GET /sponsor/healthz` returns `ok`, `paused` and the number of enrolled cameras.

Amounts in answers are in uqor (1 QOR = 1,000,000 uqor), as decimal strings.

## Limits (defaults, `deploy/sponsor/sponsor.env.example`)

| Limit | Default |
|---|---|
| Per camera per UTC day | 9 test QOR (one camera uses about 6.9 per day) |
| Per owner per UTC day | 18 test QOR |
| Global per UTC day | 90 test QOR |
| Enrolled cameras | 12 in total, 2 per owner |
| Balance | top up below 10, never above 15 test QOR |
| Payouts | at most 1 per owner per hour, at least 0.5 test QOR |
| Hourly outflow | 30 test QOR, then automatic pause |
| Rate limits per IP per minute | challenge 10, enrol 5, status 30, healthz 60 |
| Pilot code | bound to the first owner that uses it |

One faucet claim (100 test QOR per 24 h) covers about 14 cameras at 10-minute windows. For more cameras, ask the QoreChain team for a pilot allocation.

The sponsor refills what was used. It does not give a start balance. The owner needs about 2 test QOR from the faucet to register the camera, as today. The runway after a sponsor stop is the balance the owner holds (about 1.4 days at 10 test QOR).

## Kill switch

- Pause: `sudo touch /var/lib/qw-sponsor/PAUSED`. The service checks the file before every pass and before every payout. Enrol answers `503 paused`. Status shows `paused: true`.
- Resume: `sudo rm /var/lib/qw-sponsor/PAUSED`.
- Automatic pause: the service writes the file itself when the payouts of the last hour reach `SPONSOR_MAX_HOURLY_QOR`. The file holds the reason. Read it before you resume.
- There is no admin HTTP endpoint.
- When paused, recorders keep recording. Anchors stop when the owner runs out of test QOR, and the gap shows on chain.

## Hot wallet

- A fresh hybrid testnet account, used for nothing else. Never a mainnet or personal phrase.
- The recovery phrase is in `/etc/qw-sponsor/secret.env` (mode 600, owner `qw-sponsor`). The service refuses a file that group or others can read. It reads the file once at start. The phrase never goes into the environment, a log line or an HTTP answer.
- Keep a small float: at most about 2 days of the global cap (200 test QOR). The service warns above `SPONSOR_MAX_FLOAT_QOR` and alerts when the float is below one day of the global cap. Refill it by hand from a separate treasury test account.
- The service refuses to start, and every pass stops, unless the EVM chain id is 9800 and the Cosmos network is `qorechain-diana`. There is no mainnet setting.
- Risk: the pilot runs the hot wallet on the web host. A stolen key loses test QOR only. Later: a separate host and a secret store (Azure Key Vault) or KMS signing.

## Records

- `state.json`: enrolments (owner, device id, hash of the pilot code, enrol time, anchors paid), usage per day, payouts of the last 2 days. Written atomically (temp file, fsync, rename).
- `payouts.jsonl`: append-only. Time, owner, device ids, amount, status (`pending`, `sent`, `refused`, `unknown`) and tx hash. A payout is written as `pending` before the send. When the result is unknown, it stays counted, so a restart never pays twice.
- Review the top 5 receivers once a week.

## Privacy

- No email, no accounts, no names. A pilot code and an owner address are enough.
- The service stores owner address, device id and the SHA-256 hash of the pilot code. It never stores pilot codes or IP addresses.
- IP addresses are used in memory for rate limits only. Log lines carry truncated IPs (IPv4 /24, IPv6 /48). nginx writes no access log for `/sponsor/`.
- Logs go to their own journald namespace (`qw-sponsor`) with 14-day retention (`journald@qw-sponsor.conf`). Log lines hold no secrets, no request bodies and no pilot codes. Device ids are shortened.
- `state.json` and `payouts.jsonl` are kept until 3 months after the pilot ends, then deleted.
- Owner address, payouts and anchors are public on the testnet chain and cannot be deleted there.
- The sponsor links a pilot code to an owner address. Keep the list of who got which code apart from the server, and delete it with the payout log.

## Deploy (lead)

On the web host, as root. Read each step before you run it.

1. `useradd --system --home /var/lib/qw-sponsor --shell /usr/sbin/nologin qw-sponsor` and `install -d -m 750 -o root -g qw-sponsor /etc/qw-sponsor`.
2. Repo in `/opt/qorewitness` at this commit, `pnpm install --frozen-lockfile --ignore-scripts`.
3. Settings: `install -m 640 -o root -g qw-sponsor deploy/sponsor/sponsor.env.example /etc/qw-sponsor/sponsor.env`.
4. Pilot codes: `pnpm -s tsx services/sponsor/codes.ts new 12` on a trusted machine. Put only the hash column into `/etc/qw-sponsor/pilot-codes.txt` (mode 640). Hand out the codes one by one.
5. Hot wallet, as `qw-sponsor` in a private folder:
   - `install -d -m 700 -o qw-sponsor /var/lib/qw-sponsor/setup`, then in that folder `sudo -u qw-sponsor /opt/qorewitness/node_modules/.bin/tsx /opt/qorewitness/scripts/new-account.ts`. It writes `.env` (mode 600) and prints the addresses only.
   - Claim test QOR from the faucet for the printed `qor1` address.
   - Register the ML-DSA-87 key: in `/opt/qorewitness`, `sudo -u qw-sponsor node_modules/.bin/tsx --env-file=/var/lib/qw-sponsor/setup/.env scripts/window.ts register`.
   - Move the phrase: `sed -n 's/^QORE_MNEMONIC=/SPONSOR_MNEMONIC=/p' /var/lib/qw-sponsor/setup/.env > /etc/qw-sponsor/secret.env`, then `chown qw-sponsor /etc/qw-sponsor/secret.env && chmod 600 /etc/qw-sponsor/secret.env` and `shred -u /var/lib/qw-sponsor/setup/.env`.
6. Logs: `cp deploy/sponsor/journald@qw-sponsor.conf /etc/systemd/`.
7. Service: `cp deploy/sponsor/qw-sponsor.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now qw-sponsor`. Check `journalctl --namespace=qw-sponsor -u qw-sponsor -f` for `start` and `listening`.
8. nginx: add `deploy/sponsor/nginx-sponsor.conf` to the site's 443 server block, `nginx -t && systemctl reload nginx`. Check `curl -s https://qorewitness.fnoufnou.com/sponsor/healthz`.
9. Alerts: forward log lines with `"level":"alert"` to Telegram (as `qw-health.sh`). Events: `float_low`, `float_empty`, `auto_pause`, `top_up_unknown`, `pass_failed`, `http_error`.
