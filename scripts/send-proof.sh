#!/usr/bin/env bash
# Asks for the testnet recovery phrase without echo and without shell history,
# then runs send-proof.ts. Usage: scripts/send-proof.sh <qor1-address> <bbqd-link:...>
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 2 ] || { echo "Usage: $0 <qor1-address> <bbqd-link:...>"; exit 1; }
read -rsp "Testnet recovery phrase (hidden): " QORE_MNEMONIC; echo
export QORE_MNEMONIC EXPECT="$1" MEMO="$2"
pnpm -s tsx scripts/send-proof.ts
read -rp "Send 0.000001 QOR to yourself with this memo now? [y/N] " ok
[ "$ok" = "y" ] && SEND=1 pnpm -s tsx scripts/send-proof.ts
unset QORE_MNEMONIC
