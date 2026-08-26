#!/bin/bash
# Usage: stream.sh <rtsp_path>
# Generates a synthetic test-pattern video and loops it to MediaMTX as an RTSP publish.
# Swap the lavfi input for a real sample .mp4 (-re -stream_loop -1 -i /videos/sample.mp4)
# once you have footage — the rest of the pipeline doesn't care about the source.
RTSP_PATH="${1:-cam1}"
ffmpeg -re -f lavfi -i "testsrc=size=1280x720:rate=25" \
  -f lavfi -i "sine=frequency=220:sample_rate=44100" \
  -c:v libx264 -preset veryfast -tune zerolatency \
  -c:a aac -f rtsp "rtsp://mediamtx:8554/${RTSP_PATH}"
