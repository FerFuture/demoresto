#!/bin/sh
set -e
cd /app
# Volumen /app/node_modules en compose: no se actualiza al rebuild; alinear con package.json.
npm install
exec "$@"
