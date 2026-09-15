# Backup and restore

The Postgres volume is the only copy of everything. With other people's data on
it, that stopped being only the owner's problem.

## The app runs the backups now (D103)

Set the destination and a time of day under **Administration, Backup**. From
then on the API takes one a day, records every run whether it worked or not, and
shows the last one, the next one, and the reason if something failed.

That screen exists because the previous arrangement did not work. The script
described further down was written, documented and rehearsed in the D96 pass,
and its cron line stayed a comment: for two passes the only backups that existed
were the ones somebody started by hand. A schedule inside the app starts when the
app starts.

### What a backup is

One file per run, `vikt-<timestamp>.dump.enc`:

    VIKTBK1 | 12-byte IV | AES-256-GCM ciphertext of pg_dump -Fc | 16-byte tag

**Encrypted before it is written**, so the plaintext archive never exists as a
file. The key is derived from `SECRET_KEY` (or `SECRET_KEY_FILE`), which means:

- with no key set, **no backup is written at all**. An unencrypted copy of
  everyone's data leaving the machine by accident is worse than no backup,
  because it is invisible;
- **lose the key and the backups are unreadable.** Keep it somewhere that is not
  only on the machine being backed up. This is the trade, and it is the right
  one: a copy of every user's body data sitting in clear on a NAS is a worse
  outcome than a restore that needs a key you have to go and find.

The tag is at the end and is verified before a single byte is written on the way
out, so a truncated or altered backup fails loudly rather than restoring most of
a database.

### Restoring

Restore is **a command, not a button**, and that is deliberate: it is the one
operation that destroys a live database by succeeding, and it should require
somebody to type it.

```sh
# 1. Decrypt. Needs the same SECRET_KEY the backup was written with.
node infra/backup-decrypt.mjs vikt-20260906T031700Z.dump.enc vikt.dump

# 2. Restore into a *scratch* database first, always.
docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U vikt -d postgres -c 'create database vikt_restore'
docker compose -f infra/docker-compose.yml exec -T postgres \
  pg_restore -U vikt -d vikt_restore --no-owner < vikt.dump

# 3. Compare the derived figures before trusting it.
infra/restore-check.sh vikt.dump
```

Only once the scratch restore matches should anything touch the live database.

### Where backups can go

**A directory, or a Windows share.** Choose under Administration, Backup.

A **directory** is any path the API container can write, and that includes a
share the host already mounts. Point it somewhere that does not die with the
machine the database is on.

A **bucket** is any S3-compatible endpoint: AWS, Backblaze B2, MinIO, or the S3
service most NAS boxes now ship. Set the address, bucket, folder, access key and
secret under Administration, Backup (D133). Leave the address empty for AWS
itself.

**Path style is a checkbox and it matters.** AWS addresses a bucket as
`bucket.host/key`; MinIO and most NAS endpoints want `host/bucket/key` and fail
in a way that reads like a wrong address rather than a wrong option. It defaults
to on, which is right for everything except AWS.

The secret is encrypted at rest under `SECRET_KEY`, the same way the SMTP
password is, and is never sent back to the browser. Saving other settings leaves
it alone; clearing it is its own checkbox. The key needs `PutObject`,
`ListBucket` and `DeleteObject` on the bucket — the last because retention
prunes old backups, and a key that can write but not delete fills the bucket up
forever.

**Press "Testa anslutningen" after configuring one.** It writes a small object
and deletes it again, which is the only way to find out that the address,
bucket, folder, key and secret are together a place this process can write.
Each of them can be individually plausible and collectively wrong, and the
button names which one is wrong rather than repeating the SDK's message about
signatures. The result goes in the admin log either way, so a pass dates the
last time the destination was known to work.

### What is not implemented

**Writing to a Windows share directly.** Both Node SMB clients authenticate with
NTLMv1, which current Samba and Windows refuse by default, and hand-writing
NTLMv2 is authentication code whose errors are silent. D132 and D133 have the
account. Mount the share on the host and use a directory destination; the README
has the fstab and compose lines.

**Uploads are not in it.** The app's backup is the database. Photos live on disk
outside it by D10, and Phase 7 has not shipped, so there is nothing there yet;
the shell script below still tars that directory, and until photos exist the two
cover the same ground.

---

## The shell script, which still works

`infra/backup.sh` predates the above and is kept: it runs without the app, which
is what you want when the app is the thing that is broken.

**It runs on a Portainer-managed host.** Both it and `restore-check.sh` use a
compose file beside them when there is one, and otherwise reach Postgres by
container name (`POSTGRES_CONTAINER`, default `vikt-postgres-1`). Until D163 they
only worked through compose, and a Portainer host has no compose file that
`docker compose` can read, so the fallback this section promises could not
actually run there.

**Which version is on the host is checked, not assumed:**
`node scripts/host-scripts.mjs check` compares the committed files with the
host's copies by sha256, and `install` copies them. The schedule below is
reported by that check and never installed by it, because the app has run the
schedule since D103.

### What the script backs up

`infra/backup.sh` writes two files per run into `BACKUP_DIR`:

- `vikt-<timestamp>.dump` — the whole database, `pg_dump -Fc`. Compressed, and
  `pg_restore` can read it selectively, so recovering one table does not mean
  replaying the file.
- `uploads-<timestamp>.tar.gz` — the uploads volume, when it exists. Photos live
  on disk outside the database by D10, so a database-only backup restores an app
  whose every photo is a broken link. Phase 7 has not shipped, so this is
  currently empty; it runs anyway, because a script that starts covering a
  directory only once somebody remembers is a script that misses the first month.

The dump is taken **through the running container**, so `pg_dump` always matches
the server version. A host `pg_dump` one major version behind refuses outright,
which is exactly the kind of failure discovered during a restore.

It is written as `.partial` and renamed only when complete, so an interrupted
run never leaves a truncated file that looks like a backup.

## Where they go, and for how long

| | |
|---|---|
| Destination | `BACKUP_DIR`, default `/var/backups/vikt`. **Point this off the Proxmox host** — an NFS mount, a NAS share, anything that does not die with the hypervisor. |
| Schedule | Nightly. `17 3 * * * /srv/vikt/infra/backup.sh >> /var/log/vikt-backup.log 2>&1` |
| Retention | `BACKUP_RETAIN_DAYS`, default 30. Deleted **by age**, not by count, so a week the job did not run does not silently shorten the window that survives. |
| Encryption | None. The destination is assumed to be somewhere already trusted. If it is not, pipe the dump through `age` or `gpg` in `backup.sh` **and write the decryption step into the restore procedure below at the same time** — an encrypted backup nobody has decrypted is worth less than none, because it is believed. |

## Restoring

### Checking a backup without touching production

```sh
infra/restore-check.sh /var/backups/vikt/vikt-20260906T030000Z.dump
```

Restores into a scratch database with a generated name, prints row counts and
the derived-number inputs from both it and the live database, and drops the
scratch database on the way out. Safe to run on the production host. **Run it
after any change to the schema, to `backup.sh`, or to the Postgres version.**

### A real restore, step by step

1. **Stop the API** so nothing writes while the database is being replaced.
   ```sh
   cd /srv/vikt/infra && docker compose stop api
   ```

2. **Keep what is there.** Even a corrupted database is evidence, and a restore
   that turns out to be the wrong dump is survivable only if the current state
   still exists.
   ```sh
   docker compose exec -T postgres pg_dump -U vikt -d vikt -Fc > /tmp/before-restore.dump
   ```

3. **Recreate the database empty.** `pg_restore` into a database that still has
   the old rows leaves a mixture of both, which is worse than either.
   ```sh
   docker compose exec -T postgres psql -U vikt -d postgres \
     -c 'drop database "vikt";' -c 'create database "vikt";'
   ```

4. **Restore.**
   ```sh
   docker compose exec -T postgres pg_restore -U vikt -d vikt --no-owner \
     < /var/backups/vikt/vikt-<timestamp>.dump
   ```
   `--no-owner` so the restore does not depend on this cluster having the role
   names the dump was taken under. A restore that only works on the machine it
   came from is not a disaster-recovery plan.

5. **Restore the uploads**, if there are any.
   ```sh
   tar -xzf /var/backups/vikt/uploads-<timestamp>.tar.gz -C /srv/vikt/infra/data/
   ```

6. **Check the numbers before letting anyone in.** Start the API, sign in, and
   compare the dashboard's trend weight and maintenance figure against what they
   were. Row counts alone are not enough: a numeric column restored at the wrong
   scale brings back every row and the wrong trend.
   ```sh
   docker compose up -d api
   ```

7. **Migrations.** The API runs them from its entrypoint, so a dump older than
   the current code is brought up to date on start. A dump *newer* than the code
   is not: check out the matching commit first.

## The part people skip

A backup that has never been restored is a hope. This procedure was performed on
2026-09-06 against the development database: dump taken, restored into a scratch
database, and compared. Row counts matched across users, weights, food entries,
daily logs, plans and food items, and so did the derived inputs — mean, minimum
and maximum weight to four decimals, the date range, and the intake sum to two.

Re-run `restore-check.sh` after any schema change. The next person to find out
whether this works should not be finding out because a disk died.
