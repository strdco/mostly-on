# Mostly On

Backups and log shipping for **SQL Server Express**, with failover at the click of a button.

SQL Server Express has no SQL Server Agent and no built-in high availability. Mostly On is a small controller, running in its own container, that takes over that job:

- It **backs up** your databases on a schedule (FULL, DIFF and LOG), with checksums, to a shared backup folder.
- It **ships** every log backup to one or more **secondary** servers, which keep an up-to-date copy of the database.
- When the primary server needs maintenance or has failed, you **fail over** to a secondary from the dashboard.
- It **alerts** you (Pushover) when something needs attention, and keeps quiet when nothing does.

What it deliberately does **not** do:

- **No automatic failover.** A person always decides.
- **No login or job sync.** Server-level objects (logins, linked servers, ...) are yours to keep in step.
- **No client redirection.** After a failover, point your applications at the new primary yourself (connection string, DNS alias, ...).
- **No high availability for the controller.** If the Mostly On container is down, nothing is backed up or shipped until it is back. It is built to restart safely, though.

Contents: [Quick start](#quick-start-demo) · [Deploying](#deploying) · [The shared backup folder](#the-shared-backup-folder) · [Configuration](#configuration) · [SQL Server requirements](#sql-server-requirements) · [How it works](#how-it-works) · [Failover, step by step](#failover-step-by-step) · [Upgrading](#upgrading) · [Development and tests](#development-and-tests) · [Known limitations](#known-limitations)

---

## Quick start (demo)

The included `docker-compose.yml` starts two SQL Server Express containers (`sql1`, `sql2`) and Mostly On, all sharing one backup volume.

1. Create your settings file:

   ```sh
   cp .env.example .env
   ```

2. Fill in the three required values in `.env`:

   - `ADMIN_PASSWORD_HASH`: the dashboard password, hashed. Generate it with Node (`npm run hash-password`) or without Node installed:

     ```sh
     docker build -t mostly-on:dev .
     docker run --rm -it mostly-on:dev node scripts/hash-password.js
     ```

     (`docker compose` itself refuses to start until these values are set, hence plain `docker`.)

   - `SECRET_KEY`: 32 random bytes, base64. `openssl rand -base64 32` or `npm run gen-secret`.
   - `MSSQL_SA_PASSWORD`: the `sa` password for the two demo SQL Servers (at least 8 characters, with three of: upper case, lower case, digits, symbols).

3. Start everything:

   ```sh
   docker compose up -d --build
   ```

   The first start of SQL Server takes a minute or two.

4. Open <http://localhost:8080> and sign in as `admin`.

5. On **Servers**, register both SQL Servers:

   | Field | sql1 | sql2 |
   |---|---|---|
   | Name / Host | `sql1` | `sql2` |
   | SQL login / Password | `sa` / your `MSSQL_SA_PASSWORD` | same |
   | Shared backup folder, as this SQL Server sees it | `/var/opt/mssql/backup` | same |

6. Create a database on `sql1` (any tool; it must use the FULL recovery model). It appears on the **Overview** under *Available to manage*. Press **Manage**, then on the database's page **Add secondary** and pick `sql2`.

From then on Mostly On backs the database up on schedule and keeps `sql2` up to date. Try **Failover** on the secondary's row.

> **Apple Silicon:** the SQL Server image is only built for Intel (amd64). Docker Desktop runs it under Rosetta: *Settings → General → "Use Rosetta for x86_64/amd64 emulation"*. It works, but expect it to be slower than on Intel hardware.

---

## Deploying

A production setup has three parts:

1. **Your SQL Server Express instances** (containers or not), version 2019 or newer.
2. **One shared backup folder** that every SQL Server and the Mostly On container can read and write, typically a network share or a shared volume.
3. **The Mostly On container**, with:
   - a persistent volume at `/data` for its catalog (settings, history, operation journal);
   - the shared backup folder mounted, by default at `/backup`;
   - network access to each SQL Server's port (1433 by default);
   - the environment variables below.

Use `docker-compose.yml` as a template: drop the two `sql` services if your SQL Servers run elsewhere, and keep `restart: unless-stopped` so the controller comes back after a reboot.

Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik, ...) in front of port 8080 for anything but a lab, and set `PUBLIC_URL` to the `https://` address people use. Cookies are then marked Secure automatically.

The catalog in `/data` holds the history and the intent ("which server should be the primary"). SQL Server itself remains the source of truth for the state of each database. Back up `/data` like any other application data.

---

## The shared backup folder

All servers write their backups into **one** folder, and every secondary restores from it. Mostly On organises it like this:

```
<backup root>/<database>/FULL/<database>_FULL_<yyyyMMdd_HHmmss>_<server>.bak
<backup root>/<database>/DIFF/<database>_DIFF_<yyyyMMdd_HHmmss>_<server>.bak
<backup root>/<database>/LOG/<database>_LOG_<yyyyMMdd_HHmmss>_<server>.trn
<backup root>/<database>/DIVERGED/...   (safety backups of out-of-sync copies; never deleted automatically)
```

**The folder can have a different path on each machine.** When you register a server, you tell Mostly On where the folder is *as that SQL Server sees it* (for example `/var/opt/mssql/backup`). If the controller has it somewhere other than `BACKUP_ROOT`, set that path on the server too.

### Permissions

The SQL Server containers run as **uid 10001**, and so does Mostly On (group 0). Both need to create folders and files there, and Mostly On deletes old backups (retention). Give the folder to uid 10001, group 0, with the setgid bit so new folders keep the group:

```sh
sudo mkdir -p /srv/mostly-on/backup /srv/mostly-on/data
sudo chown 10001:0 /srv/mostly-on/backup /srv/mostly-on/data
sudo chmod 2770 /srv/mostly-on/backup /srv/mostly-on/data
```

Then bind-mount `/srv/mostly-on/backup` into each SQL Server container (at `/var/opt/mssql/backup`) and into Mostly On (at `/backup`), and `/srv/mostly-on/data` into Mostly On at `/data`. The demo compose file does the same with named volumes and a one-shot `init-perms` service.

For a **network share** (NFS, SMB), make sure files created by uid 10001 on one machine can be read, written and deleted by uid 10001 on the others. With NFS, that usually means matching uids or squashing to a uid with access. With SMB, it means mount options such as `uid=10001,gid=0,file_mode=0660,dir_mode=02770`.

Symptoms of a permissions problem: backups fail with *Operating system error 5 (Access is denied)*, or retention logs that it could not delete files.

---

## Configuration

Everything is set through environment variables (see `.env.example`). Everything else is set in the dashboard under **Settings**.

| Variable | Required | Default | What it is |
|---|---|---|---|
| `ADMIN_PASSWORD_HASH` | yes | | Hash of the dashboard password (`npm run hash-password`). |
| `SECRET_KEY` | yes | | 32 random bytes, base64. Encrypts the SQL Server passwords in the catalog. If you lose it, you have to re-enter every server password. |
| `ADMIN_USER` | | `admin` | Dashboard user name. |
| `PUBLIC_URL` | | `http://localhost:8080` | The address people use to reach the dashboard. Used for the cross-site request check and for links in notifications. |
| `COOKIE_SECURE` | | on for `https://` | Mark the login cookie Secure. |
| `SESSION_TTL_HOURS` | | `12` | How long a login lasts. |
| `TZ` | | `UTC` | Time zone for schedule times such as "daily at 01:30". |
| `LOG_LEVEL` | | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout. |
| `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY` | | | Turn on Pushover notifications. Without them, alerts only show in the dashboard. |
| `PUSHOVER_API_URL` | | Pushover's API | Only for testing against a mock. |
| `PORT`, `DATA_DIR`, `BACKUP_ROOT` | | `8080`, `/data`, `/backup` | Container paths and port; rarely changed. |
| `MSSQL_SA_PASSWORD` | demo only | | `sa` password for the demo SQL Server containers. |

---

## SQL Server requirements

- **SQL Server 2019 or newer.** Express is what Mostly On is made for; other editions work too.
- Databases you ship must use the **FULL recovery model**. To switch one: `ALTER DATABASE [name] SET RECOVERY FULL;`
- **The login Mostly On uses needs `sysadmin`** on every server. It backs up and restores databases, changes database states during failovers, disconnects sessions, and reads and trims the backup history in `msdb`. There is no narrower role that covers all of that.
- Secondaries that should be **readable between restores** (STANDBY) need the same major SQL Server version as the primary.
- **Nothing else may take log backups** of a managed database. A log backup taken by another tool (a maintenance plan, a backup agent) holds changes the secondaries never receive, so shipping stops. Mostly On detects such backups and alerts you. Backups taken with `COPY_ONLY` are fine.

---

## How it works

- **Backups.** Each managed database has a FULL, DIFF and LOG schedule (by default: FULL weekly, DIFF daily, LOG every 5 minutes), editable on its page. Backups run only on the current primary, always `WITH CHECKSUM` and without compression (Express cannot compress).
- **Shipping.** After every log backup, each secondary restores it (`WITH NORECOVERY`, or `STANDBY` for a readable copy). Readers of a readable copy are disconnected when a restore is due, so the copy stays current. "Behind" on the dashboard is how old the newest data on a secondary is.
- **Stopped shipping.** If a log backup a secondary needs is missing, or SQL Server refuses it, Mostly On stops shipping to that secondary and tells you why. It never skips ahead or guesses. Put the file back and press **Try again**, or **Reinitialize** the secondary (a fresh copy from the primary).
- **Retention.** Old backup files are deleted after the number of days you set. Files a secondary still needs, and the newest complete set needed to restore each database, are always kept.
- **Alerts.** Mostly On alerts you once when a problem starts, reminds you every few hours while it lasts, and sends one notice when it is resolved. Alerts cover:
  - a server is unreachable;
  - a database is not in the state it should be;
  - shipping has stopped, or a secondary is too far behind;
  - a backup or restore failed;
  - a backup was taken outside Mostly On;
  - an old primary is out of sync, or is accepting writes (split brain);
  - a failover or other operation failed.

  Alert state survives restarts, so nothing is sent twice.
- **Crash safety.** Every multi-step job (failovers, adding or reinitializing a secondary) is recorded step by step. After a restart, an interrupted job is never continued on its own: the **Operations** page shows exactly where it stopped, what to check, and offers **Resume** or **Mark resolved**.

---

## Failover, step by step

Press **Failover** on a secondary's row. The dialog shows how many log backups the secondary still needs and offers one choice: **Perform tail log backup**.

### With a tail-log backup (no data lost)

Use this when the primary is up. The box is ticked by default if it was reachable at the last check.

1. Wait for running backups and restores of this database to finish.
2. Check both servers.
3. Restore every log backup the secondary does not have yet.
4. On the old primary, disconnect all users (`SINGLE_USER`) and take a **tail-log backup**: a final log backup that captures every transaction not yet copied, and leaves the old primary waiting to become a secondary.
5. Restore the tail-log backup on the target.
6. Bring the database online on the target (`RESTORE ... WITH RECOVERY`) and let users back in (`MULTI_USER`).
7. Swap the roles: the target is the new primary; the old primary is now its secondary, with no copying needed.
8. Take the first log backup on the new primary; the schedules continue from there.

If a step fails, the job stops there and the Operations page says what state each server is in, with the exact SQL to run if you want to go back.

### Without a tail-log backup (data may be lost)

Use this when the primary is down or damaged. Transactions committed on the old primary after the newest shipped log backup are lost, and the dialog shows you since when.

1. Check the target.
2. If the old primary can be reached, take its database **offline**, so no application keeps writing to it. If you left the box ticked while the primary is unhealthy, Mostly On instead tries a best-effort tail-log backup.
3. Restore every log backup the target can get.
4. Bring the database online on the target.
5. Mark the old primary's copy **out of sync**: it may hold transactions the new primary never received. Mostly On never restores onto it or backs it up.
6. Check that the other secondaries can follow the new primary; any that cannot are marked for reinitializing.
7. Take the first log backup on the new primary.

When the old primary comes back, use **Take offline** if applications might still write to it, then **Reinitialize** it. A safety backup of the out-of-sync copy is kept first in `DIVERGED/`, so no data is thrown away without a copy.

### Fail over all databases

For server maintenance, **Fail over all databases** on a server's page moves every database whose primary is on that server to another server, one at a time, each with a tail-log backup. If one fails, the rest are not started; resume the batch once it is fixed.

---

## Upgrading

Pull or build the new image and restart the container. The catalog in `/data` upgrades itself on start:

- **Backup first.** Before the first change, it writes a copy next to itself: `mostly-on.db.v001.bak`, named after the version it was at.
- **Downgrades are refused.** An older image refuses to start against a catalog that a newer image has already upgraded. It exits with code 3 and says so in the log.
- **Rolling back.** Stop the container, replace `mostly-on.db` with the `.bak` copy from before the upgrade, and start the old image.

For developers writing a migration (`src/store/migrations/NNN_name.sql`):

- Don't put `BEGIN`/`COMMIT` or `PRAGMA foreign_keys` in the file; the runner wraps each migration in a transaction with foreign keys off.
- To change a constraint, use SQLite's usual table rebuild: create the new table, copy the rows, drop the old one, rename.
- The foreign-key check must come back clean before a migration commits.

---

## Development and tests

```sh
npm install
npm run dev               # runs the controller locally with .env, restarting on changes
npm test                  # unit tests (no Docker needed)
npm run test:integration  # the whole scenario against real SQL Server containers
```

The integration suite starts its own isolated compose project (`mostly-on-it`) with fresh secrets, separate volumes and its own ports (controller on 18080), so it does not touch a running demo stack. It walks through the brief end to end:

1. Register both servers, manage a database, add a secondary.
2. Fail over with a tail-log backup and check that the last row arrived.
3. Fail back.
4. Stop the primary, fail over without it, and check that shipped rows survived and the unshipped row is lost.
5. Bring the old primary back, see it flagged out of sync, and reinitialize it.
6. Check that notifications are sent once and not repeated after a controller restart, using the mock Pushover in `docker-compose.test.yml`.

It takes several minutes. Set `IT_KEEP=1` to leave the stack running afterwards for a look around, and `IT_REUSE=1` to rerun against it.

---

## Known limitations

- **No automatic failover, no login sync, no client redirection.** These are out of scope by design; see the top of this file.
- **The controller is a single point of failure for shipping.** While it is down, no backups are taken and nothing ships. The databases themselves keep running, and everything catches up when it returns.
- **SQL Server 2019 or newer only.** Readable (STANDBY) secondaries need the same major version as the primary, and a secondary cannot run an older major version than its primary.
- **A short window during a failover with a tail-log backup.** Between disconnecting everyone (`SINGLE_USER`) and taking the tail-log backup, another program can grab the one allowed connection. The step then fails with "database is in use"; **Resume** tries again.
- **Backup times around daylight-saving changes.** SQL Server records backup times in the server's local time. Mostly On converts them with the server's current UTC offset, so in the hour around a DST change, lag and "last backup" times can be off by an hour. Backups and restores themselves are not affected.
- **No database size monitoring.** Express's 10 GB data limit is not tracked by Mostly On; watch it with your usual monitoring.
