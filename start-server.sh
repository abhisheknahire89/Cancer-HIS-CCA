#!/bin/bash
# Starts CCA OS detached and writes the PID to .server-pid for preview registration
cd "$(dirname "$0")"
node src/server.js > /tmp/cca-server.log 2>&1 &
PID=$!
disown $PID 2>/dev/null
echo "$PID" > .server-pid
for i in $(seq 1 20); do
  sleep 0.5
  if curl -s -m 1 http://127.0.0.1:3210/ws/rest/v1/cca/hospitals > /dev/null 2>&1; then
    echo "CCA OS UP — pid $PID — http://localhost:3210"
    exit 0
  fi
done
echo "server did not come up:"; cat /tmp/cca-server.log
exit 1
