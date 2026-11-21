#!/bin/bash
# Entry point of the QoreWitness image.
#   agent      anchor finished segments (default)
#   recorder   record the camera stream (RTSP, RTMP or HTTP) into 60-second segments
#   retention  delete segments older than QW_RETENTION_DAYS (default 14), every 6 hours
#   setup      first-run wizard in the terminal (account, keys, registration)
#   ui         local dashboard on port 8080 (read only, token in the log)
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
  retention) while true; do deploy/qw-retention.sh || true; sleep 21600; done ;;
  # The dashboard never loads qorewitness.env: the recovery phrase stays out of its environment.
  ui)       export QW_UI_HOST="${QW_UI_HOST:-0.0.0.0}"; exec node --import tsx src/web/server.ts ;;
  setup)    shift; exec node --import tsx "${envfile[@]}" scripts/setup.ts "$@" ;;
  device)   shift; exec node --import tsx "${envfile[@]}" scripts/device.ts "$@" ;;
  window)   shift; exec node --import tsx "${envfile[@]}" scripts/window.ts "$@" ;;
  verify)   shift; exec node --import tsx scripts/verify-receipt.ts "$@" ;;
  *)        exec "$@" ;;
esac
