#!/bin/sh
# Apply any checked-in migration that has not run yet, then hand off to the
# server. Migrations are additive and an applied one is never edited
# (CLAUDE.md §7), so this is safe to run on every container start.
set -eu

echo "Running migrations..."
node dist/migrate.js

echo "Starting API..."
exec "$@"
