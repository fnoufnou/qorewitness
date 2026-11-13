#!/bin/bash
# QoreWitness health check for a Proxmox host. Run from root cron every 15 minutes.
# Sends a Telegram message when anchoring stops, the evidence volume fills up or the
# agent account runs low on test QOR, and once more when the problem is gone.
# Config (env file, default /etc/qorewitness-health.env):
#   QW_CT=261  QW_DEVICE=lsc-indoor  QW_RECEIPT_DIR=/var/lib/qorewitness/lsc-indoor/receipts
#   QW_AGENT_QOR=qor1...  QW_MIN_QOR=10  QW_MAX_DISK_PCT=85  QW_MAX_AGE_MIN=30
#   NOTIFY_CONF=/etc/immich-upgrade.env   (holds TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)
set -uo pipefail
CONF="${1:-/etc/qorewitness-health.env}"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"
CT="${QW_CT:-261}"; DEV="${QW_DEVICE:-lsc-indoor}"; RDIR="${QW_RECEIPT_DIR:-/var/lib/qorewitness/$DEV/receipts}"
STATE=/var/lib/qorewitness-health; mkdir -p "$STATE"
notify() {
  [ -r "${NOTIFY_CONF:-/etc/immich-upgrade.env}" ] || return 0
  ( . "${NOTIFY_CONF:-/etc/immich-upgrade.env}"
    [ -n "${TELEGRAM_BOT_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT_ID:-}" ] || exit 0
    curl -fsS -m 15 -o /dev/null "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
      --data-urlencode "chat_id=${TELEGRAM_CHAT_ID}" --data-urlencode "text=[qorewitness] $1" )
}
# report <key> <bad 0|1> <message when bad> <message when fixed>: one message per change of state
report() {
  local f="$STATE/$1"
  if [ "$2" = 1 ] && [ ! -e "$f" ]; then touch "$f"; notify "$3"
  elif [ "$2" = 0 ] && [ -e "$f" ]; then rm -f "$f"; notify "$4"; fi
}
age=$(pct exec "$CT" -- bash -c "find '$RDIR' -maxdepth 1 -name '$DEV-*.json' -mmin -${QW_MAX_AGE_MIN:-30} | head -1" 2>/dev/null)
active=$(pct exec "$CT" -- systemctl is-active "qw-agent@$DEV" "qw-recorder@$DEV" 2>/dev/null | tr '\n' ' ')
report anchoring "$([ -z "$age" ] && echo 1 || echo 0)" \
  "No anchor for $DEV in ${QW_MAX_AGE_MIN:-30} min. Services: $active" "Anchoring for $DEV works again."
pct_disk=$(pct exec "$CT" -- df --output=pcent /var/lib/qorewitness 2>/dev/null | tail -1 | tr -dc 0-9)
report disk "$([ "${pct_disk:-0}" -ge "${QW_MAX_DISK_PCT:-85}" ] && echo 1 || echo 0)" \
  "Evidence volume at ${pct_disk}%. Check retention." "Evidence volume back at ${pct_disk}%."
if [ -n "${QW_AGENT_QOR:-}" ]; then
  uqor=$(curl -fsS -m 15 "https://api-testnet.qore.host/cosmos/bank/v1beta1/balances/$QW_AGENT_QOR" | grep -o '"denom":"uqor","amount":"[0-9]*"' | grep -o '[0-9]*"$' | tr -d '"')
  [ -n "$uqor" ] && report balance "$([ "$uqor" -lt "$(( ${QW_MIN_QOR:-10} * 1000000 ))" ] && echo 1 || echo 0)" \
    "Agent has $(( uqor / 1000000 )) test QOR left. Claim the faucet: https://dashboard.qorechain.io" "Agent balance OK again."
fi
exit 0
