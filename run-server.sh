#!/bin/bash
# CCA OS launcher — fully detaches the server so it survives the calling shell
cd "$(dirname "$0")"
if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
  echo "CCA OS already running (pid $(cat server.pid)) on port ${PORT:-3210}"
  exit 0
fi
if [ "$1" = "--fresh" ]; then rm -rf data; fi
nohup node src/server.js > /tmp/cca-os.log 2>&1 < /dev/null &
PID=$!
echo "$PID" > server.pid
disown "$PID" 2>/dev/null || true
sleep 2
if kill -0 "$PID" 2>/dev/null; then
  echo "CCA OS started (pid $PID) → http://localhost:${PORT:-3210}"
else
  echo "FAILED to start:"; cat /tmp/cca-os.log
fi
