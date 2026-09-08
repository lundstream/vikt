#!/bin/sh
# Restores a backup into a scratch database and checks it (D96).
#
#   ./restore-check.sh /var/backups/vikt/vikt-20260906T030000Z.dump
#
# This is the half of a backup strategy that people skip, and it is the half
# that decides whether the other half worked. A dump that has never been
# restored is a hope: the file is the right size, the cron job is green, and
# nobody has ever asked Postgres to read it.
#
# It restores into a **scratch database** with a generated name and drops it
# afterwards, so it can be run on the production host without touching
# production. It never writes to the live database and never needs to.
set -eu

DUMP="${1:-}"
if [ -z "$DUMP" ] || [ ! -f "$DUMP" ]; then
  echo "Usage: restore-check.sh <dump file>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && . "$HERE/.env"

POSTGRES_USER="${POSTGRES_USER:-vikt}"
POSTGRES_DB="${POSTGRES_DB:-vikt}"
COMPOSE="${COMPOSE:-docker compose}"
SCRATCH="vikt_restore_$(date -u +%Y%m%d%H%M%S)"

run() { $COMPOSE -f "$HERE/docker-compose.yml" exec -T postgres "$@"; }

cleanup() {
  echo "dropping $SCRATCH"
  run psql -U "$POSTGRES_USER" -d postgres -c "drop database if exists \"$SCRATCH\";" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "restoring $(basename "$DUMP") into $SCRATCH"
run psql -U "$POSTGRES_USER" -d postgres -c "create database \"$SCRATCH\";" >/dev/null

# `--no-owner` so the restore does not depend on the role names in the dump
# matching the ones in this cluster, which is the usual reason a restore fails
# on a machine that is not the one it came from — and a restore you can only do
# on the original host is not a disaster-recovery plan.
run pg_restore -U "$POSTGRES_USER" -d "$SCRATCH" --no-owner < "$DUMP"

echo
echo "--- what came back ---"
run psql -U "$POSTGRES_USER" -d "$SCRATCH" -A -F' ' -t -c "
  select 'users', count(*) from users
  union all select 'weight_log', count(*) from weight_log
  union all select 'food_entries', count(*) from food_entries
  union all select 'daily_log', count(*) from daily_log
  union all select 'plans', count(*) from plans
  order by 1;"

echo
echo "--- against the live database ---"
run psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -A -F' ' -t -c "
  select 'users', count(*) from users
  union all select 'weight_log', count(*) from weight_log
  union all select 'food_entries', count(*) from food_entries
  union all select 'daily_log', count(*) from daily_log
  union all select 'plans', count(*) from plans
  order by 1;"

echo
echo "--- the derived figures the app computes from ---"
# Not row counts alone. A restore can bring back every row and still be useless
# if a numeric column arrived with the wrong scale, and the trend is the first
# place that would show. This prints the inputs to §4.1 and §4.2 for the
# account with the most readings, from both databases, to be compared by eye.
for DB in "$SCRATCH" "$POSTGRES_DB"; do
  echo "  $DB:"
  run psql -U "$POSTGRES_USER" -d "$DB" -A -F' ' -t -c "
    select
      round(avg(weight_kg)::numeric, 4) as mean_weight,
      round(min(weight_kg)::numeric, 4) as min_weight,
      round(max(weight_kg)::numeric, 4) as max_weight,
      count(*) as readings,
      min(local_date) as first_day,
      max(local_date) as last_day
    from weight_log
    where user_id = (select user_id from weight_log group by user_id order by count(*) desc limit 1);"
done

echo
echo "If the two blocks above match, this dump restores. If they do not, the"
echo "backup is not a backup and this is the day to find out rather than the"
echo "day after the disk fails."
