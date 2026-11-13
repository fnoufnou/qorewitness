# Deploy on a Debian LXC (Proxmox)

1. Node 22, pnpm 10, ffmpeg. Repo in `/opt/qorewitness`, owned by user `dev`. `.env` with `QORE_MNEMONIC` and `QORE_REGISTRY` (mode 600).
2. Storage: a volume at `/var/lib/qorewitness` (owner `dev`).
3. Per camera: copy `lsc-indoor.env.example` to `/etc/qorewitness/<name>.env` and edit it.
   Create the device key as user `dev`: `pnpm device keygen /etc/qorewitness/<name>.key` (mode 600).
   Register it once (owner key and device key sign): `QORE_REGISTRY=... pnpm device register <name> /etc/qorewitness/<name>.key`.
   The window for this call must allow the registry. The agent refuses to anchor until the device is active with this key.
4. `cp deploy/qw-*.service /etc/systemd/system/ && systemctl daemon-reload`
5. `systemctl enable --now qw-recorder@<name> qw-agent@<name>`
6. Logs: `journalctl -u qw-agent@<name> -f`. Receipts land in `QW_RECEIPT_DIR`.
7. Retention: `cp deploy/qw-retention@.* /etc/systemd/system/ && systemctl enable --now qw-retention@<name>.timer`. Deletes segments older than `QW_RETENTION_DAYS` (default 14). Receipts stay.
8. Health check on the Proxmox host: copy `deploy/qw-health.sh` to `/usr/local/bin/qw-health`, add a root cron line `*/15 * * * * /usr/local/bin/qw-health`. It sends a Telegram message when anchoring stops, the volume fills up or the agent runs low on test QOR.
