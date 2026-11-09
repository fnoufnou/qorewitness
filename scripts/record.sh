#!/usr/bin/env bash
# Records an RTSP stream in 60-second MP4 segments without re-encoding.
# ffmpeg adds a line to segments.csv only after a segment file is closed;
# the agent anchors only listed (finished) segments.
# Env: QW_RTSP_URL, QW_SEGMENT_DIR, optional QW_SEGMENT_SECONDS (default 60).
set -euo pipefail
: "${QW_RTSP_URL:?}" "${QW_SEGMENT_DIR:?}"
mkdir -p "$QW_SEGMENT_DIR"
cd "$QW_SEGMENT_DIR"
# Keep the old list: ffmpeg truncates it on start.
[ -s segments.csv ] && cat segments.csv >> segments.history.csv
exec ffmpeg -hide_banner -loglevel warning -nostdin \
  -rtsp_transport tcp -timeout 10000000 -i "$QW_RTSP_URL" \
  -map 0:v -c copy -f segment -segment_time "${QW_SEGMENT_SECONDS:-60}" -reset_timestamps 1 \
  -segment_format_options movflags=+faststart -strftime 1 \
  -segment_list segments.csv -segment_list_type csv \
  "seg_%Y%m%dT%H%M%SZ.mp4"
