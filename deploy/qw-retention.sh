#!/bin/bash
# Deletes recording segments older than QW_RETENTION_DAYS (default 14). Receipts are kept.
# A receipt stays valid without its segment, but the segment is the evidence: export what you need first.
# Usage: qw-retention.sh <camera-env-file>   (e.g. /etc/qorewitness/lsc-indoor.env)
set -euo pipefail
ENV_FILE="${1:?usage: qw-retention.sh <camera-env-file>}"
# shellcheck disable=SC1090
. "$ENV_FILE"
DAYS="${QW_RETENTION_DAYS:-14}"
DIR="${QW_SEGMENT_DIR:?QW_SEGMENT_DIR missing in $ENV_FILE}"
[ "$DAYS" -ge 2 ] || { echo "QW_RETENTION_DAYS must be 2 or more"; exit 1; }
before=$(du -sm "$DIR" | cut -f1)
count=$(find "$DIR" -maxdepth 1 -type f -name 'seg_*' -mtime +"$DAYS" -print -delete | wc -l)
after=$(du -sm "$DIR" | cut -f1)
echo "qw-retention ${QW_DEVICE:-?}: deleted $count segments older than $DAYS days, ${before} MB -> ${after} MB"
