#!/bin/sh
set -e
chown -R node:node /app/logs /app/contexts
exec su-exec node node /app/src/server.js