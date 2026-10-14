#!/bin/sh
set -e
# Fly volumes mount as root; the app runs as `node` (uid 1000).
if [ -d /data ]; then
  chown -R node:node /data
fi
mkdir -p /app/data
chown -R node:node /app/data
exec su-exec node "$@"
