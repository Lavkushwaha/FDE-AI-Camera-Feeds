#!/bin/bash
# Usage: stream.sh <rtsp_path> <video_file>
# Loops a real .mp4 as an RTSP publish to MediaMTX — the "CCTV feed" for the POC.
# Files are h264/aac, so -c copy streams without re-encoding (near-zero CPU).
# +genpts keeps timestamps continuous across loop restarts.
RTSP_PATH="${1:-cam1}"
VIDEO="${2:-/videos/classroom.mp4}"

ffmpeg -hide_banner -loglevel warning \
  -re -stream_loop -1 -fflags +genpts -i "$VIDEO" \
  -c copy \
  -f rtsp "rtsp://mediamtx:8554/${RTSP_PATH}"
