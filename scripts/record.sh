#!/usr/bin/env bash
# Records a camera stream in 60-second MP4 segments without re-encoding.
# ffmpeg adds a line to segments.csv only after a segment file is closed;
# the agent anchors only listed (finished) segments.
#
# Env: QW_STREAM_URL (or the older QW_RTSP_URL), QW_SEGMENT_DIR,
#      optional QW_SEGMENT_SECONDS (default 60), QW_STREAM_LISTEN=1 (RTMP push, see below).
#
# Input types:
#   rtsp:// rtsps://     pull from the camera (most home cameras)
#   rtmp:// rtmps://     pull from an RTMP server or camera
#   http:// https://     pull an HLS (.m3u8) or HTTP-FLV stream
#   rtmp:// + QW_STREAM_LISTEN=1   wait for a camera or app to push to this machine,
#                        for example QW_STREAM_URL=rtmp://0.0.0.0:1935/live/<secret>.
#                        Anyone who can reach the port and knows the path can push
#                        video. Keep the port on the camera network only.
set -euo pipefail
URL="${QW_STREAM_URL:-${QW_RTSP_URL:-}}"
: "${URL:?set QW_STREAM_URL}" "${QW_SEGMENT_DIR:?}"
case "$URL" in
  rtsp://*|rtsps://*) input=(-rtsp_transport tcp -timeout 10000000) ;;
  rtmp://*|rtmps://*)
    if [ "${QW_STREAM_LISTEN:-0}" = "1" ]; then input=(-listen 1 -f flv); else input=(-rw_timeout 10000000); fi ;;
  http://*|https://*) input=(-rw_timeout 10000000 -reconnect 1 -reconnect_streamed 1) ;;
  *) echo "unsupported stream URL: use rtsp(s)://, rtmp(s):// or http(s)://" >&2; exit 2 ;;
esac
# File names carry the start second. At start, ffmpeg flushes the first seconds it
# buffered while probing the stream: segments shorter than 10 s could get the same name.
if [ "${QW_SEGMENT_SECONDS:-60}" -lt 10 ]; then echo "QW_SEGMENT_SECONDS must be 10 or more" >&2; exit 2; fi
mkdir -p "$QW_SEGMENT_DIR"
cd "$QW_SEGMENT_DIR"
# Keep the old list: ffmpeg truncates it on start.
[ -s segments.csv ] && cat segments.csv >> segments.history.csv
# ffmpeg prints the input URL in many error lines ("401 Unauthorized", "Connection
# refused"). The camera password must never reach docker logs or journald, so every
# stderr line passes through the same redaction as src/core/redact.ts.
exec 2> >(sed -u -E 's#([A-Za-z][A-Za-z0-9+.-]*://)[^[:space:]/]*@#\1***@#g' >&2)
exec ffmpeg -hide_banner -loglevel warning -nostdin \
  "${input[@]}" -i "$URL" \
  -map 0:v -c copy -f segment -segment_time "${QW_SEGMENT_SECONDS:-60}" -reset_timestamps 1 \
  -segment_format_options movflags=+faststart -strftime 1 \
  -segment_list segments.csv -segment_list_type csv \
  "seg_%Y%m%dT%H%M%SZ.mp4"
