#!/bin/bash
# Deletes recording segments older than QW_RETENTION_DAYS (default 14). Receipts are kept.
# A receipt stays valid without its segment, but the segment is the evidence: export what you need first.
# Disk guard: when less than QW_MIN_FREE_PERCENT (default 10) of the disk is free, it also
# deletes the oldest clips until 5 points more are free. The 2 newest clips always stay
# (ffmpeg writes the newest). A full disk would stop recording, which is worse.
# Usage: qw-retention.sh [camera-env-file]   (e.g. /etc/qorewitness/lsc-indoor.env)
# Without a file it uses the environment (Docker: camera.env is already loaded).
set -euo pipefail
ENV_FILE="${1:-}"
# shellcheck disable=SC1090
[ -n "$ENV_FILE" ] && . "$ENV_FILE"
DAYS="${QW_RETENTION_DAYS:-14}"
DIR="${QW_SEGMENT_DIR:?QW_SEGMENT_DIR missing}"
[ -d "$DIR" ] || { echo "qw-retention: $DIR does not exist yet"; exit 0; }
[ "$DAYS" -ge 2 ] || { echo "QW_RETENTION_DAYS must be 2 or more"; exit 1; }
count=$(find "$DIR" -maxdepth 1 -type f -name 'seg_*' -mtime +"$DAYS" -print -delete | wc -l)
[ "$count" = 0 ] || echo "qw-retention ${QW_DEVICE:-?}: deleted $count segments older than $DAYS days"

# Disk guard. QW_DF="<total bytes> <free bytes>" replaces df in tests.
MIN_FREE="${QW_MIN_FREE_PERCENT:-10}"
if [ -n "${QW_DF:-}" ]; then read -r total avail <<< "$QW_DF"; else read -r total avail < <(df -P -B1 "$DIR" | awk 'NR == 2 {print $2, $4}'); fi
if [ "${total:-0}" -gt 0 ] && [ "$avail" -lt $(( total * MIN_FREE / 100 )) ]; then
  need=$(( total * (MIN_FREE + 5) / 100 - avail ))
  freed=0; n=0
  # File names start with the UTC start time, so a name sort is a time sort.
  while IFS= read -r f; do
    [ "$freed" -ge "$need" ] && break
    size=$(stat -c %s "$f")
    rm -f -- "$f"
    freed=$(( freed + size )); n=$(( n + 1 ))
  done < <(find "$DIR" -maxdepth 1 -type f -name 'seg_*' -printf '%f\n' | sort | head -n -2 | sed "s#^#$DIR/#")
  echo "qw-retention ${QW_DEVICE:-?}: disk almost full, deleted the $n oldest clips ($(( freed / 1048576 )) MB)"
fi
