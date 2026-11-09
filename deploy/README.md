# Deploy on a Debian LXC (Proxmox)

1. Node 22, pnpm 10, ffmpeg. Repo in `/opt/qorewitness`, owned by user `dev`. `.env` with `QORE_MNEMONIC` and `QORE_REGISTRY` (mode 600).
2. Storage: a volume at `/var/lib/qorewitness` (owner `dev`).
3. Per camera: copy `lsc-indoor.env.example` to `/etc/qorewitness/<name>.env` and edit it.
4. `cp deploy/qw-*.service /etc/systemd/system/ && systemctl daemon-reload`
5. `systemctl enable --now qw-recorder@<name> qw-agent@<name>`
6. Logs: `journalctl -u qw-agent@<name> -f`. Receipts land in `QW_RECEIPT_DIR`.
