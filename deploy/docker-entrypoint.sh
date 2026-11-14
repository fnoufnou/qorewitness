#!/bin/bash
# Entry point of the QoreWitness image.
#   agent      anchor finished segments (default)
#   recorder   record the RTSP stream into 60-second segments
#   setup      first-run wizard in the terminal (account, keys, registration)
#   device|window|verify ...   the CLIs, e.g. "device status <label>"
set -euo pipefail
cd /opt/qorewitness
export QW_SEGMENT_DIR="${QW_SEGMENT_DIR:-/data/${QW_DEVICE:-camera}/segments}"
export QW_RECEIPT_DIR="${QW_RECEIPT_DIR:-/data/${QW_DEVICE:-camera}/receipts}"
export QW_DEVICE_KEY="${QW_DEVICE_KEY:-/data/keys/${QW_DEVICE:-camera}.key}"
envfile=(); [ -f /data/qorewitness.env ] && envfile=(--env-file=/data/qorewitness.env)
case "${1:-agent}" in
  agent)    exec node --import tsx "${envfile[@]}" src/agent/run.ts ;;
  recorder) exec scripts/record.sh ;;
  setup)    shift; exec node --import tsx "${envfile[@]}" scripts/setup.ts "$@" ;;
  device)   shift; exec node --import tsx "${envfile[@]}" scripts/device.ts "$@" ;;
  window)   shift; exec node --import tsx "${envfile[@]}" scripts/window.ts "$@" ;;
  verify)   shift; exec node --import tsx scripts/verify-receipt.ts "$@" ;;
  *)        exec "$@" ;;
esac
