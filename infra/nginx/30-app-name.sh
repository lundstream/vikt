#!/bin/sh
# Runs from the nginx image's own entrypoint directory, before nginx starts.
#
# `vite build` deliberately leaves the literal __APP_NAME__ in index.html and
# manifest.webmanifest. This rewrites it from $APP_NAME, so renaming the app is
# `APP_NAME=Something docker compose up -d` with no rebuild and no code edit
# (DECISIONS.md D13).
set -eu

APP_NAME="${APP_NAME:-Vikt}"
ROOT=/usr/share/nginx/html

echo "30-app-name.sh: setting app name to '${APP_NAME}'"

find "$ROOT" -type f \( -name '*.html' -o -name '*.webmanifest' -o -name '*.json' \) \
  -exec sed -i "s|__APP_NAME__|${APP_NAME}|g" {} +
