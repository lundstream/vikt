#!/bin/sh
# Scheduled backup of the database and the meal photos (D96, D191).
#
#   ./backup.sh                 # one run, reads infra/.env
#   BACKUP_DIR=/mnt/nas/vikt ./backup.sh
#
# Run it from cron or a systemd timer on the Docker host:
#   17 3 * * *  /srv/vikt/infra/backup.sh >> /var/log/vikt-backup.log 2>&1
#
# ## Why this exists
#
# The Postgres volume was the only copy of everything, on one Proxmox host. A
# disk, a bad migration or a mistyped `docker compose down -v` took the lot, and
# with other people's data arriving that stopped being only the owner's problem.
#
# ## What it does not do
#
# It does not encrypt. The destination is assumed to be somewhere the operator
# already trusts, and a backup that needs a key is a backup that fails to
# restore on the day the key is on the machine that died. If the destination is
# not trusted, pipe the dump through age or gpg here and write the restore step
# into the runbook at the same time — an encrypted backup nobody has decrypted
# is worth less than none, because it is believed.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
[ -f "$HERE/.env" ] && . "$HERE/.env"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/vikt}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"
POSTGRES_USER="${POSTGRES_USER:-vikt}"
POSTGRES_DB="${POSTGRES_DB:-vikt}"
COMPOSE="${COMPOSE:-docker compose}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Where Postgres is (D163).
#
# With a compose file beside this script, through compose, as it always was.
# Without one, by container name: a Portainer-managed host keeps its stack file
# inside Portainer, and the repository's Portainer file cannot be read by
# `docker compose` at all unless every stack variable is set, so there is no
# compose invocation that works there. The container name is the stack's own.
if [ -f "$HERE/docker-compose.yml" ]; then
  run() { $COMPOSE -f "$HERE/docker-compose.yml" exec -T postgres "$@"; }
else
  POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-vikt-postgres-1}"
  run() { docker exec -i "$POSTGRES_CONTAINER" "$@"; }
fi

mkdir -p "$BACKUP_DIR"

echo "[$(date -u +%FT%TZ)] backing up to $BACKUP_DIR"

# --- the database ----------------------------------------------------------
#
# `pg_dump -Fc` rather than plain SQL: the custom format is compressed, and
# `pg_restore` can read it selectively, which is what makes a single-table
# recovery possible without replaying the whole file.
#
# Dumped through the running container so the version of pg_dump always matches
# the server. A host pg_dump one major version behind refuses outright, which is
# the kind of failure that is only discovered during a restore.
DUMP="$BACKUP_DIR/vikt-$STAMP.dump"
run pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$DUMP.partial"

# Renamed only once it is complete, so an interrupted run never leaves a
# truncated file that looks like a backup.
mv "$DUMP.partial" "$DUMP"
echo "  database: $(du -h "$DUMP" | cut -f1)  $DUMP"

# --- the meal photos -------------------------------------------------------
#
# Photos live on disk outside the database (D10), in the directory the stack
# binds at /media (MEDIA_HOST_DIR, D191), so the dump does not contain them and
# a database-only backup would restore meals whose every photo is a broken
# link. Archived with the same stamp as the dump, so restore-check.sh finds the
# pair, and paths relative to the directory, so the archive unpacks straight
# back into a fresh one: users/<id>/meals/<meal>-<random>.jpg, which is the key
# each meal names.
#
# A missing directory is said out loud and not an error: a stack that stores
# photos in S3 (MEDIA_STORAGE=s3) has none here, and the app's own backup
# archives those beside its dumps.
MEDIA="${MEDIA_HOST_DIR:-/var/lib/vikt/media}"
if [ -d "$MEDIA" ]; then
  tar -czf "$BACKUP_DIR/media-$STAMP.tar.gz.partial" -C "$MEDIA" .
  mv "$BACKUP_DIR/media-$STAMP.tar.gz.partial" "$BACKUP_DIR/media-$STAMP.tar.gz"
  PHOTOS="$(tar -tzf "$BACKUP_DIR/media-$STAMP.tar.gz" | grep -c '\.jpg$' || true)"
  echo "  photos:   $PHOTOS in $(du -h "$BACKUP_DIR/media-$STAMP.tar.gz" | cut -f1)  $BACKUP_DIR/media-$STAMP.tar.gz"
else
  echo "  photos:   $MEDIA does not exist, skipped (MEDIA_HOST_DIR, or photos kept in S3)"
fi

# --- retention -------------------------------------------------------------
#
# Deleted by age rather than by count, so a week when the job did not run does
# not silently shorten the window that survives.
#
# `-maxdepth 1`, so this only ever prunes the dumps this script made (D159).
# Without it the delete recursed, and a dump deliberately kept in a
# subdirectory -- a release's rollback dump, which has to outlive any rotation
# window -- was on a thirty day timer nobody had set. `releases/` is the
# subdirectory that convention uses.
find "$BACKUP_DIR" -maxdepth 1 -name 'vikt-*.dump' -mtime "+$RETAIN_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'media-*.tar.gz' -mtime "+$RETAIN_DAYS" -delete

REMAINING="$(find "$BACKUP_DIR" -maxdepth 1 -name 'vikt-*.dump' | wc -l | tr -d ' ')"
echo "[$(date -u +%FT%TZ)] done. $REMAINING dumps kept, retention ${RETAIN_DAYS}d"

# --- the part people skip --------------------------------------------------
#
# A backup that has never been restored is a hope. `restore.sh` performs one
# into a scratch database and compares the derived numbers; run it after any
# change to this file, to the schema, or to the Postgres version.
