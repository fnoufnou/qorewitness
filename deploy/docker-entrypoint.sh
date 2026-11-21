#!/bin/bash
# Entry point of the QoreWitness image.
#   agent      anchor finished segments (default)
#   recorder   record the camera stream (RTSP, RTMP or HTTP) into 60-second segments
#   supervise recorder|agent
#              wait until setup is done (/data/setup.done), load /data/camera.env,
#              run the recorder or the agent, and restart it when camera.env changes.
#              docker-compose.yml uses this mode, so the browser setup needs no restart.
#   retention  delete segments older than QW_RETENTION_DAYS (default 14), every 6 hours
#   setup      first-run wizard in the terminal (account, keys, registration)
#   ui         local dashboard and browser setup on port 8080
#   device|window|verify ...   the CLIs, e.g. "device status <label>"
set -euo pipefail
cd "${QW_APP:-/opt/qorewitness}"
DATA="${QW_DATA:-/data}"
POLL="${QW_SUPERVISE_POLL:-5}"

# Reads KEY=VALUE lines without running them as shell code (a camera password
# can hold $, & or ;). Keys must be upper case.
load_env() {
  local f="$1" k v
  [ -f "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^([A-Z_][A-Z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"
    export "$k=$v"
  done < "$f"
}

set_paths() {
  export QW_SEGMENT_DIR="${QW_SEGMENT_DIR:-$DATA/${QW_DEVICE:-camera}/segments}"
  export QW_RECEIPT_DIR="${QW_RECEIPT_DIR:-$DATA/${QW_DEVICE:-camera}/receipts}"
  export QW_DEVICE_KEY="${QW_DEVICE_KEY:-$DATA/keys/${QW_DEVICE:-camera}.key}"
}

# Installs from before 0.6 have no setup.done. They count as done when the terminal
# setup finished and the agent wrote receipts.
setup_done() {
  [ -f "$DATA/setup.done" ] && return 0
  if [ -f "$DATA/camera.env" ] && [ -f "$DATA/qorewitness.env" ]; then
    local dev; dev="$(sed -n 's/^QW_DEVICE=//p' "$DATA/camera.env" | head -n1)"
    if [ -n "$dev" ] && compgen -G "$DATA/$dev/receipts/$dev-*.json" >/dev/null; then
      : > "$DATA/setup.done" 2>/dev/null || true
      return 0
    fi
  fi
  return 1
}

fingerprint() { cksum "$DATA/camera.env" 2>/dev/null || echo none; }

child=""
stop_child() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill -TERM "$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
  fi
  child=""
}
trap 'stop_child; exit 0' TERM INT

# sleep in the background, so a TERM from docker stop is handled at once
nap() { sleep "$1" & wait $! || true; }

supervise() {
  local what="${1:?supervise recorder|agent}"; shift || true
  local said=0
  until setup_done; do
    [ "$said" = 1 ] || echo "$(date -u +%FT%TZ) $what: waiting for setup. Open the setup link from the installer."
    said=1
    nap "$POLL"
  done
  local backoff=5 fp started rc
  while true; do
    fp="$(fingerprint)"
    # A fresh subshell per start, so a key removed from camera.env is really gone.
    (
      load_env "$DATA/camera.env"
      set_paths
      case "$what" in
        recorder) exec scripts/record.sh ;;
        agent)
          envfile=(); [ -f "$DATA/qorewitness.env" ] && envfile=(--env-file="$DATA/qorewitness.env")
          exec node --import tsx "${envfile[@]}" src/agent/run.ts ;;
        --) exec "$@" ;;
        *) echo "supervise: unknown service $what" >&2; exit 2 ;;
      esac
    ) &
    child=$!
    started=$(date +%s)
    while kill -0 "$child" 2>/dev/null; do
      nap "$POLL"
      if [ "$(fingerprint)" != "$fp" ]; then
        echo "$(date -u +%FT%TZ) $what: camera settings changed, restarting"
        stop_child
        backoff=5
        continue 2
      fi
    done
    rc=0; wait "$child" || rc=$?
    child=""
    # Quick restart after a long run. A child that stops at once waits longer, up to 60 s.
    [ $(( $(date +%s) - started )) -lt 120 ] || backoff=5
    echo "$(date -u +%FT%TZ) $what: stopped (exit $rc), restart in ${backoff}s"
    nap "$backoff"
    backoff=$(( backoff * 2 > 60 ? 60 : backoff * 2 ))
  done
}

case "${1:-agent}" in
  agent)    set_paths; envfile=(); [ -f "$DATA/qorewitness.env" ] && envfile=(--env-file="$DATA/qorewitness.env")
            exec node --import tsx "${envfile[@]}" src/agent/run.ts ;;
  recorder) set_paths; exec scripts/record.sh ;;
  supervise) shift; supervise "$@" ;;
  retention)
    while true; do
      ( load_env "$DATA/camera.env"; set_paths; deploy/qw-retention.sh ) || true
      nap 21600
    done ;;
  # The dashboard never loads qorewitness.env: the recovery phrase stays out of its environment.
  ui)       export QW_UI_HOST="${QW_UI_HOST:-0.0.0.0}"; exec node --import tsx src/web/server.ts ;;
  setup)    shift; set_paths; envfile=(); [ -f "$DATA/qorewitness.env" ] && envfile=(--env-file="$DATA/qorewitness.env")
            exec node --import tsx "${envfile[@]}" scripts/setup.ts "$@" ;;
  device)   shift; set_paths; envfile=(); [ -f "$DATA/qorewitness.env" ] && envfile=(--env-file="$DATA/qorewitness.env")
            exec node --import tsx "${envfile[@]}" scripts/device.ts "$@" ;;
  window)   shift; envfile=(); [ -f "$DATA/qorewitness.env" ] && envfile=(--env-file="$DATA/qorewitness.env")
            exec node --import tsx "${envfile[@]}" scripts/window.ts "$@" ;;
  verify)   shift; exec node --import tsx scripts/verify-receipt.ts "$@" ;;
  *)        exec "$@" ;;
esac
