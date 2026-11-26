# Mostly-On

SQL Server backup and log shipping for people who don't have SQL Server Agent or just don't have the patience for shell scripts and cron jobs.

SQL Server Express Edition has no SQL Server Agent, and for anything less than Enterprise Edition, you won't have any kind of out-of-the-box high availability. Mostly-On is a small orchestrator, running in its own container, that takes care of:

- **Backing up** your databases on a schedule (FULL, DIFF and LOG), with checksums, to a shared backup folder. That includes the system databases (master, model, msdb) and databases in SIMPLE recovery, so one tool covers every database.
- **Log shipping** to one or more secondary servers, keeping an up-to-date copy of the database.
- **Failing over** your databases to a secondary replica if the primary server needs maintenance or has failed, directly from the dashboard.
- **Alerting** (using [Pushover](https://pushover.net/)) when a managed server goes down or something needs your attention.

> [!IMPORTANT]
> Mostly-On is *not* a high-availability (HA) solution, for multiple reasons.
> It can help serve as a disaster recovery (DR) mechanism in some respects.

- **No automatic failover.** You have to perform the failover yourself.
- **No login or job sync.** Server-level objects (logins, linked servers, ...) are not automatically synchronized.
- **No client redirection.** After a failover, you need to point direct your applications at the new primary (changing the connection string, DNS alias or virtual IP).
- **No high availability for the orchestrator itself.** If the Mostly-On container is down, nothing is backed up or shipped until it is back. It is built to restart safely, though. You need to make sure your container restarts automatically.

> [!WARNING]
> This project was largely vibe-coded and is in early beta. Please test it properly
> before deploying to important or sensitive environments.

Contents: [Quick start demo](#quick-start-demo) · [Deploying](#deploying) · [The shared backup folder](#the-shared-backup-folder) · [Configuration](#configuration) · [SQL Server requirements](#sql-server-requirements) · [How it works](#how-it-works) · [Failover, step by step](#failover-step-by-step) · [Upgrading](#upgrading) · [Development and tests](#development-and-tests) · [Known limitations](#known-limitations) · [License](#license)

---

## Quick start (demo)

Mostly-On is published as a container image, `ghcr.io/strdco/mostly-on`. The demo starts it together with three SQL Server Express containers (`sql1`, `sql2`, `sql3`) and a shared backup volume. You need `docker-compose.yml`, `docker-compose.demo.yml`, `.env.example` and the `sql` folder from this repository; cloning it is easiest.

1. Create your settings file:

   ```sh
   cp .env.example .env
   ```

2. Fill in the four required values in `.env`:

   - `ADMIN_PASSWORD_HASH`: the password of the first dashboard user (`ADMIN_USER`, default `admin`), hashed. Once Mostly-On has started, you add everyone else on its **Users** page. Generate it with Node (`npm run hash-password`) or without Node installed:

     ```sh
     docker run --rm -it ghcr.io/strdco/mostly-on:latest node scripts/hash-password.js
     ```

     (`docker compose` itself refuses to start until these values are set, hence plain `docker`.)

   - `SECRET_KEY`: 32 random bytes, base64. `openssl rand -base64 32` or `npm run gen-secret`.
   - `MSSQL_SA_PASSWORD`: the `sa` password for the demo SQL Servers (at least 8 characters, with three of: upper case, lower case, digits, symbols).
   - `MOSTLY_ON_SQL_PASSWORD`: the password of `mostly_on`, the restricted login Mostly-On uses on the demo servers (same rules). The demo's one-shot `sql-setup` service creates that login and runs the setup script on all three servers; see [SQL Server requirements](#sql-server-requirements).

3. Start everything:

   ```sh
   docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d
   ```

   The first start of SQL Server takes a minute or two.

4. Open <http://localhost:8080> and sign in as `admin`.

5. On the **Servers** page, register your SQL Servers:

   | Field | Value |
   |---|---|
   | Name / Host | `sql1`, `sql2` or `sql3` |
   | SQL login / Password | `mostly_on` / your `MOSTLY_ON_SQL_PASSWORD` |
   | Shared backup folder, as this SQL Server sees it | `/var/opt/mssql/backup` |

6. Create a database on `sql1` (any tool; it must use FULL recovery model). It appears on the **Overview**, under `sql1`'s **Not managed** list. Press its manage control (**Manage**), then on the database's page press **Add secondary** and pick `sql2` and/or `sql3`.

   The manage control shows how Mostly-On manages each database: **O** not managed, **I** managed without secondaries, **II** log shipped to secondaries. To stop managing a database, press its control. That requires any secondaries be removed first (database page, Replicas table, **Remove**), so no copy is left waiting for log backups that never come. The system databases (master, model, msdb) and databases in SIMPLE or BULK_LOGGED recovery can be managed too: they are tagged **backups only**, and are backed up on their own server, never shipped or restored (see [How it works](#how-it-works)).

From here on, Mostly-On backs the database up on a schedule and keeps `sql2` up to date. Try **Failover** on the secondary's row.

---

## Deploying

A production setup has three parts:

1. **Your SQL Server instances**, must be version 2019 or newer.
2. **One shared backup folder** that every SQL Server and the Mostly-On container can read and write, typically a network share or a shared volume.
3. **The Mostly-On container**, with:
   - a persistent volume at `/data` for its catalog (settings, history, operation journal);
   - the shared backup folder mounted, by default at `/backup`;
   - network access to each SQL Server's port (1433 by default; for a named instance found through SQL Server Browser, also UDP 1434);
   - the environment variables below.

> [!IMPORTANT]
> Using container volumes is critical to persisting Mostly-On's metadata and catalog.
> If you don't use persistent volumes, all this data will be lost when you update the
> Docker image.

Use `docker-compose.yml` as a template. It runs only the Mostly-On container, from the published image:

- [ ] Replace the `backup` volume with your shared backup folder (see [The shared backup folder](#the-shared-backup-folder)).

- [ ] Keep `restart: unless-stopped` so the controller comes back after a reboot.

- [ ] Put a TLS-terminating reverse proxy (Caddy, nginx, Traefik, ...) in front of port 8080 for anything but a lab, and set `PUBLIC_URL` to the `https://` address people use. Auth cookies are then marked Secure automatically.

The catalog in `/data` holds the history and the intent ("which server should be the primary"). SQL Server itself remains the source of truth for the state of each database. Back up `/data` like any other application data.

---

## The shared backup folder

In order to be able to ship logs and fail over from one server to another, all participating servers in a replica set write their backups into **one** folder, and every secondary restores from it. Mostly-On organises it like this:

```
<backup root>/<database>/FULL/<database>_FULL_<yyyyMMdd_HHmmss>_<server>.bak
<backup root>/<database>/DIFF/<database>_DIFF_<yyyyMMdd_HHmmss>_<server>.bak
<backup root>/<database>/LOG/<database>_LOG_<yyyyMMdd_HHmmss>_<server>.trn
<backup root>/<database>/DIVERGED/...   (safety backups of out-of-sync copies; never deleted automatically)
<backup root>/<database>@<server>/FULL/... (and DIFF, LOG: databases backed up on one server only)
```

A log-shipped database has one folder, whichever server is its primary. A **backups-only** database (a system database, or one not in FULL recovery) belongs to one server, so its folder carries that server's name: every server has its own `master`, for example `master@sql1` and `master@sql2`.

**The folder can have a different path on each machine.** When you register a server, you tell Mostly-On where the folder is *as that SQL Server sees it* (for example `/var/opt/mssql/backup`). If the controller has it somewhere other than what you've configured as `BACKUP_ROOT`, set that path on the server too.

### Permissions

SQL Server containers run as **uid 10001**, and so does Mostly-On (group 0). Both need to create folders and files there, and Mostly-On deletes old backups (after they've expired).

- [ ] Give the folder to uid 10001, group 0, with the setgid bit so new folders keep the group:

```sh
sudo mkdir -p /srv/mostly-on/backup /srv/mostly-on/data
sudo chown 10001:0 /srv/mostly-on/backup /srv/mostly-on/data
sudo chmod 2770 /srv/mostly-on/backup /srv/mostly-on/data
```

- [ ] Bind-mount `/srv/mostly-on/backup` into each SQL Server container (at `/var/opt/mssql/backup`) and into Mostly-On (at `/backup`).
- [ ] Bind-mount `/srv/mostly-on/data` into Mostly-On at `/data`, or keep the named volume `controller-data` from `docker-compose.yml`: a new named volume gets the right owner from the image by itself. (The demo compose file uses a one-shot `init-perms` service for its shared backup volume, because a SQL Server container may mount it first.)

For a **network share** (NFS, SMB), make sure files created by uid 10001 on one machine can be read, written and deleted by uid 10001 on the others. With NFS, that usually means matching uids or squashing to a uid with access. With SMB, it means mount options such as `uid=10001,gid=0,file_mode=0660,dir_mode=02770`.

Symptoms of a permissions problem: backups fail with *Operating system error 5 (Access is denied)*, or retention logs that it could not delete files.

---

## SQL Server outside containers

Mostly-On doesn't care whether SQL Server runs in a container or directly on a Linux or Windows machine. It talks to SQL Server over the network, and backups move freely between Linux and Windows. You can even mix them: a Windows primary with a Linux secondary works. What differs is the shared backup folder and, on Windows, how Mostly-On connects. Mostly-On itself always runs as its Linux container.

Every server gets the same treatment: register it, then run its setup script (see [SQL Server requirements](#sql-server-requirements)).

### On a Linux machine

The backup folder is usually an NFS share, mounted on every SQL Server machine (for example at `/var/opt/mssql/backup`) and on the machine running Mostly-On (bound to `/backup` in its container).

SQL Server runs as the `mssql` user, whose user ID differs from machine to machine, and Mostly-On runs as uid 10001. They must be able to read and write each other's files. Mostly-On also deletes expired backups. The simplest way is to make every client write as the same user on the share (NFS `all_squash`):

```sh
# On the NFS server, in /etc/exports (then: sudo exportfs -ra)
/srv/sqlbackup  *(rw,sync,all_squash,anonuid=10001,anongid=0)

sudo mkdir -p /srv/sqlbackup && sudo chown 10001:0 /srv/sqlbackup && sudo chmod 2770 /srv/sqlbackup
```

If you'd rather keep real user IDs, create one group with the same group ID everywhere. Add `mssql` to it on every SQL Server machine (`sudo usermod -aG <group> mssql`, then restart `mssql-server`), run Mostly-On with that group (`user: "10001:<gid>"` in compose), and give the folder to that group with `chmod 2770`. Mostly-On creates its subfolders group-writable. If restores on another machine fail with *Operating system error 5*, the backup files aren't readable by the group: add a default ACL (`setfacl -d -m g::rwX /srv/sqlbackup`).

### On a Windows machine

**Prerequisites on SQL Server.** These apply to any edition and any instance name, and Mostly-On doesn't change them for you:

- **TCP/IP is enabled** (SQL Server Configuration Manager → Network Configuration).
- **Mostly-On can find the instance.** Either give the instance a fixed TCP port and register the server with that port, or keep the **SQL Server Browser** service running and enter the **instance name** (under *More options* when you register the server). Mostly-On then asks the Browser for the port.
- **The firewall** allows the port (also UDP 1434, if you use the Browser service).
- **Mixed-mode authentication** (SQL Server and Windows Authentication) is on, and there is a SQL login for Mostly-On. Mostly-On connects with SQL logins only.

**The backup folder** is an SMB share, for example `\\fileserver\sqlbackup`, or a folder on one of the Windows machines that's shared out:

- **SQL Server's service account needs Modify rights on it.** If SQL Server runs as its default virtual account (`NT Service\MSSQL$<instance>`), it reaches the network as the machine's computer account (`DOMAIN\MACHINE$`), so grant that account. In a domain environment, consider running SQL Server under a domain account, or better yet, a group managed service account (gMSA) and grant that.
- **Register the server with the share's path as SQL Server sees it,** for example `\\fileserver\sqlbackup` or `D:\SqlBackup` if the folder is local to that machine.
- **Mostly-On mounts the same share.** It needs an account with Modify rights, mounted so that Mostly-On's user owns everything. For example, as a Docker volume:

  ```yaml
  volumes:
    backup:
      driver: local
      driver_opts:
        type: cifs
        device: //fileserver/sqlbackup
        o: "username=mostlyon,password=...,domain=EXAMPLE,uid=10001,gid=0,file_mode=0660,dir_mode=02770,vers=3.0"
  ```

  Or mount it on the Docker host (`mount -t cifs` with the same options) and bind it to `/backup`. Folder permissions on the share come from these mount options, so Mostly-On doesn't try to set them.

A Linux SQL Server taking part in the same setup mounts the same share (CIFS on Linux), and is registered with its own path for it, such as `/var/opt/mssql/backup`.

---

## Configuration

Everything is set through environment variables (see `.env.example`). Everything else is set in the dashboard under **Settings**.

| Variable | Required | Default | What it is |
|---|---|---|---|
| `ADMIN_PASSWORD_HASH` | first start | | Hash of the first user's password (`npm run hash-password`). Only used while there are no users yet; after that, users are managed on the **Users** page and it is ignored. |
| `SECRET_KEY` | yes | | 32 random bytes, base64. Encrypts the SQL Server passwords in the catalog. If you lose it, you have to re-enter every server password. |
| `ADMIN_USER` | | `admin` | The first user's name (see `ADMIN_PASSWORD_HASH`). |
| `PUBLIC_URL` | | `http://localhost:8080` | The address people use to reach the dashboard. Used for the cross-site request check and for links in notifications. |
| `COOKIE_SECURE` | | on for `https://` | Mark the login cookie Secure. |
| `SESSION_TTL_HOURS` | | `12` | How long a login lasts. |
| `TZ` | | `UTC` | Time zone for schedule times such as "daily at 01:30". |
| `LOG_LEVEL` | | `info` | `debug`, `info`, `warn` or `error`. Logs are JSON lines on stdout. |
| `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY` | | | Turn on Pushover notifications. Without them, alerts only show in the dashboard. |
| `PUSHOVER_API_URL` | | Pushover's API | Only for testing against a mock. |
| `PORT`, `DATA_DIR`, `BACKUP_ROOT` | | `8080`, `/data`, `/backup` | Container paths and port; rarely changed. |
| `MSSQL_SA_PASSWORD` | demo only | | `sa` password for the demo SQL Server containers. |
| `MOSTLY_ON_SQL_PASSWORD` | demo only | | Password of the restricted `mostly_on` login the demo creates on its SQL Servers. |

---

## SQL Server requirements

- **SQL Server 2019 or newer.** All editions, including Express Edition, will work.
- Databases you ship must use **FULL recovery model**. To switch model: `ALTER DATABASE [name] SET RECOVERY FULL;` A shipped database switched to SIMPLE or BULK_LOGGED later gets no log backups until it is back in FULL, and Mostly-On alerts you. Databases in SIMPLE or BULK_LOGGED recovery, and the system databases, can still be backed up (**backups only**, see [How it works](#how-it-works)).
- **Each server needs Mostly-On's setup script, run once by a sysadmin.** Mostly-On's own login should *not* have sysadmin privileges (see below).
- Secondaries need to have the same major version or higher as the primary.
- Readable secondaries ("STANDBY") need the same major SQL Server version as the primary.
- **Nothing else may take log backups** of a managed database. A log backup taken by another tool (like a maintenance plan or a backup agent) holds changes that the secondaries will never receive, which breaks shipping. Mostly-On detects such backups and alerts you. Backups taken with `COPY_ONLY` are safe and do not break this log chain.

### The setup script, and why Mostly-On does not need sysadmin

Backing up, restoring, failing over and disconnecting users all need high privileges. One of them can't even be granted server-wide: SQL Server only allows BACKUP per database. Instead of granting Mostly-On a sysadmin login, a sysadmin runs a **setup script** on each server:

- It installs a few **stored procedures in `master`** (in the `mostly_on` schema) that perform Mostly-On's work.
- It **signs** these procedures with a certificate. The rights come from that signature (`CONTROL SERVER` and `dbcreator`), and only while one of those procedures runs. The certificate's private key is deleted after signing, so nothing else can ever be signed with it.
- It gives Mostly-On's login only:
  - permission to **run** those procedures;
  - **read** access to server state and backup history (`VIEW SERVER STATE`, `VIEW ANY DEFINITION`, db_datareader in `msdb`).

What that means in practice:

- **Mostly-On's login on its own can do almost nothing.** It cannot read your data, create logins, change server settings, or back up and restore anything directly. (The backup files hold all your data, so protect the shared backup folder too! Backups of `master` and `msdb` also hold the server's logins with their password hashes, its credentials and its jobs.)
- **The procedures have guard rails.** They back up the system databases master, model and msdb, but never restore or change them, and never touch tempdb. They only read or write backup files inside the shared backup folder. They drop a database only when nobody can write to it (`RESTORING`, or a read-only `STANDBY` copy): a secondary you remove, or the copy of a database that was dropped on its primary. Restored database files only go to the server's default data and log folders. They never make Mostly-On's login the owner of a database, so they can't be used to read your data either.
- **They can still do what failover needs.** That includes overwriting a database and taking one offline, which is the job itself. The procedures accept **every user database on the server**, not only the ones Mostly-On manages. Whoever controls Mostly-On (its dashboard, or its SQL login) can therefore disrupt any user database on the server; protect both accordingly.
- **Database owners are kept.** A restored database would otherwise belong to Mostly-On's login. When a copy is brought online at failover, it gets its original owner back if that login exists on the server: matched by SID first, then by name. If neither exists, it gets `sa`, and an event tells you how to fix it; a later failover to that server gives it back to its owner once the login exists. Any other database (one that Mostly-On didn't restore or hand to `sa` itself) always keeps its owner.

To set a server up:

- [ ] Create a login for Mostly-On (for example `CREATE LOGIN mostly_on WITH PASSWORD=N'…';` - you may want to disable password expiration)
- [ ] Register the server in Mostly-On.
- [ ] On that server's page, under **Setup**, press **Download setup script**. The script has that server's backup folder and login filled in.
- [ ] Run the script on the server as a sysadmin (SSMS, Azure Data Studio or `sqlcmd`). Running it again is always safe.

The **Servers** page shows whether each server is ready. A new version of Mostly-On may need a newer script, and so does changing a server's backup folder or undo-file folder in Mostly-On (the helper procedures only use the folders the script was run with). The page (and an alert) will tell you, and backups and failovers on that server will wait until you have run it again. The template is [`sql/mostly-on-helpers.sql`](sql/mostly-on-helpers.sql); review it before you run it.

---

## How it works

- **Backups.** Each managed database has a FULL, DIFF and LOG schedule. They follow the default schedules under Settings (**Default schedules**), and change with them, until you edit one on the database's page: that one is then the database's own, until you choose **Use default** there. By default: FULL weekly and LOG every 5 minutes. DIFF backups are off by default: they only make restores faster. Switch them on for every database in Settings, or for one database on its page. Backups run only on the current primary, always `WITH CHECKSUM` and without compression (Express Edition does not support backup compression). A database that is still starting up (`RECOVERING`, for example on Express Edition, which opens an `AUTO_CLOSE` database on first use) gets up to 20 seconds before a backup gives up.
- **Load on each SQL Server.** At most **2 backups and restores run at a time** on each SQL Server, counting all its databases, as primary and as secondary. Change the default under Settings (**SQL Servers connections**), or give a server its own value (edit the server, **More options**).
  - More wait their turn, first come first served; the operation shows "Waiting for a free connection to sql1" meanwhile.
  - Health checks and other short queries have their own connections and never wait, so a busy server is never reported unreachable.
  - Failovers and rollbacks never wait. A scheduled backup or a restore that is still waiting when a failover or rollback needs its database gives way, and runs again later.
- **Shipping.** After every log backup, each secondary restores it (`WITH NORECOVERY`, or `STANDBY` for a readable copy). Readers of a readable copy are disconnected when a restore happens, so the copy stays current. "Behind" on the dashboard shows how old the newest data on a secondary is.
- **Backups only.** The system databases (master, model, msdb), and user databases that are not in FULL recovery when you manage them, are backed up on their own server only, in the folder `<database>@<server>`. They are tagged **backups only** on the dashboard.
  - They always get FULL backups. While one is in FULL recovery, it also gets DIFF and LOG backups, like any other database. In SIMPLE or BULK_LOGGED recovery, its DIFF and LOG schedules are skipped quietly. master only ever gets FULL backups (SQL Server allows nothing else).
  - No secondaries and no failover, and Mostly-On never restores them: restore them by hand from those files. Retention works as for any other database.
  - A user database switched to FULL recovery later gets LOG backups by itself. To log ship it, stop managing it, then manage it again.
  - Backups another tool takes of them are noted on the database's page, so you can tell an old backup job is still running. Only a LOG backup raises an alert, since restoring past it needs that file.
- **Stopped shipping.** If a log backup is missing, or if the secondary refuses it, Mostly-On stops shipping to that replica and tells you why. It never skips ahead or guesses. Put the log backup file back and press **Try again**, or **Reinitialize** the secondary completely.
- **Removing a secondary.** **Remove** in the Replicas table stops shipping to it and asks what to do with its copy: drop it (the default; its backups stay until retention removes them), bring it online as a database of its own, or leave it as it is. An out-of-sync copy is always left as it is. If the copy can't be dropped or brought online, it stays a secondary and the error says why.
- **Delayed secondaries.** A secondary can be kept behind on purpose, so you can look at the data as it was before a problem.
  - The **Restore delay** is configured in minutes.
  - A delayed secondary restores a log backup only once that backup is as old as the delay, so the replica will end up between the delay and the delay plus one log backup interval behind.
  - You **cannot** fail over to a delayed secondary. To do this, reset its delay to 0; the failover then restores the missing log backups itself.
  - Only a readable (STANDBY) copy can be queried. Readers are disconnected at every restore. To prevent this, press **Pause sync** (for up to 24 hours).
- **Retention.** Old backup files are deleted after the number of days you define (Settings), per backup type; a database can have its own, overriding, values. Any files required by a secondary, as well as the newest complete set needed to restore each database, are always kept. A database that was dropped (see **Automatic management**) keeps no newest set: its files go once they are past retention. A database you stop managing yourself keeps its files until you delete them. FULL backups are kept at least as long as DIFF and LOG backups, as those would be useless without the FULL they build on; Mostly-On will refuse settings that would break this rule.
- **Alerts.** Mostly-On alerts you once when a problem starts, then reminds you every few hours while it lasts, and sends one notice when it is resolved. Alerts cover:
  - a server is unreachable;
  - a database is not in the state it should be (not while a database on a server with automatic management is gone: that is a drop, most likely, and an event says so);
  - a log-shipped database was switched out of FULL recovery, so it gets no log backups. In SIMPLE recovery this is an error: its log chain is broken, and its secondaries need reinitializing once it is back in FULL. In BULK_LOGGED it is a warning: back in FULL, shipping catches up by itself;
  - shipping has stopped, or a secondary is too far behind. You can configure alert thresholds on the **Settings** page. For example, with logs every 15 minutes and an alert threshold of 10 minutes, it alerts once a secondary is more than 25 minutes old;
  - a backup or restore failed;
  - a backup was taken outside Mostly-On;
  - an old primary is out of sync, or is accepting writes (split brain);
  - a failover or other operation failed.

  Alert state survives restarts, so nothing is sent twice.
- **Crash safety.** Every multi-step job (failovers, adding or reinitializing a secondary) is recorded step by step. After a restart, an interrupted job is never continued on its own: the **Operations** page shows exactly where it stopped, what to check, and offers **Resume** or **Mark resolved**.

## Automatic management

For servers where databases come and go, one per customer for example. Turn it on per server, with the **Manage databases automatically** switch on the server's page. The **Servers** list shows which servers have it on, and where they ship new databases.

- **New databases are managed by themselves.** A user database is managed a minute after it appears, so an application has time to set it up (switch it to FULL recovery, for example). Turning it on also manages the user databases already on the server that Mostly-On does not manage yet; the dialog lists them first. A few are taken on at every health check, so hundreds of them are taken on gradually.
- **They are log shipped to the server you choose.** A database in FULL recovery gets a secondary on that server once its first FULL backup is there. One that is not in FULL recovery is backed up only. To have new databases start in FULL recovery, keep the `model` database in FULL recovery. If adding the secondary fails, an event says why, and you add it on the database's page; Mostly-On does not keep trying.
- **Servers are paired.** When sql1 log ships to sql2 and sql2 has no server of its own yet, sql2 gets sql1. After a switchover (**Fail over databases…**), new databases are created on sql2 and shipped back to sql1, with nothing to change. After a failover without the old server, new secondaries wait until it is back.
- **Dropped databases stop being managed.** A managed database that has been gone from its server for 30 minutes (Settings, **Monitoring**) is no longer managed. While it is gone, it raises no alerts and its backups wait; if it comes back in time, nothing happens. Its copies on secondaries are dropped, but only a copy nobody can write to (`RESTORING` or a read-only `STANDBY` copy) on a reachable server; any other copy is left for you, and an event says so. Its backups are kept until retention removes them, the newest ones too. A database dropped and created again under the same name counts as a new database.
- **What it leaves alone.** System databases, a database with the name of a log-shipped database on another server (a log-shipped name is taken on every server), and databases you stopped managing yourself (until you manage them again). Databases you manage by hand never get a secondary automatically.

---

## Failover, step by step

Press **Failover** on a secondary replica of the database. The dialog shows how many log backups the secondary still needs and offers a choice: **Perform tail log backup**.

### With a tail-log backup (no data lost)

Use this when the primary is up. The box is ticked by default if it was reachable at the last check.

1. Waits for running backups and restores of this database to finish.
2. Checks both servers.
3. Restores every log backup the secondary does not have yet.
4. On the old primary, disconnects all users (`SINGLE_USER`) and takes a **tail-log backup**: a final log backup that captures every transaction not yet copied, and leaves the old primary waiting to become a secondary.
5. Restores the tail-log backup on the target replica.
6. Brings the target database online (`RESTORE ... WITH RECOVERY`) and lets users back in (`MULTI_USER`).
7. Swaps the roles: the target is the new primary; the old primary is now its secondary, with no copying needed.
8. Takes the first log backup on the new primary; the schedules continue from there.

If a step fails, the job stops there and the Operations page says what state each server is in, with the exact SQL to run if you want to go back.

### Without a tail-log backup (data may be lost)

Use this when the primary is down or damaged. Transactions committed on the old primary after the most recently shipped log backup are lost, and the dialog shows you since when.

1. Checks the target.
2. If the old primary can be reached, takes its database **offline**, so no application can write to it. If you left the box ticked while the primary is unhealthy, Mostly-On instead tries a best-effort tail-log backup.
3. Restores every log backup the target can get.
4. Brings the database online on the target.
5. Marks the old primary's copy **out of sync**, as it may hold transactions that the new primary never received. Mostly-On never restores onto it or backs it up.
6. Checks that the other secondaries can follow the new primary; those that cannot are marked for reinitializing.
7. Takes the first log backup on the new primary.

When the old primary comes back, use **Take offline** if applications might still write to it, then **Reinitialize** it. A safety backup of the out-of-sync copy is kept first in the `DIVERGED/` folder, so no data is thrown away without a copy.

### Fail over databases from a server

For server maintenance, press **Fail over databases…** on a server's page and pick which server to move them to. The list only offers servers that hold a working secondary of at least one of the databases, with how many each covers ("sql2: 3 of 5 databases").

- Every database with a working secondary on the chosen server moves, one at a time, each with a tail-log backup so nothing is lost. The old server becomes the secondary.
- The dialog lists the databases that stay behind and why (no copy there, shipping stopped, still being set up, kept behind on purpose). They stay unavailable while the old server is down: run it again with another server, or fail them over from their own pages.
- If the chosen server runs a newer SQL Server version, the old server cannot receive its log backups afterwards; the dialog warns about this per database.
- If one failover fails, the rest wait; resume the batch once it is fixed.
- The button is greyed out, with the reason, when it can't be used: the server isn't the primary of any log-shipped database, it is unreachable, or none of its databases has a working secondary.

## Restoring to a point in time

Someone deleted the wrong rows at 14:03? On the database's page, press **Restore…**, pick the date and time (type it to the second, in your browser's time zone, or drag the slider across the restorable range) and choose what to do. The dialog shows the points-in-time you can restore to: from just after the oldest FULL backup that still has every log backup after it, up to now while the primary is reachable.

### Restore a copy (safe)

Mostly-On restores the database as it was at that moment under a **new name** (for example `Sales_20261121_1403`), on any registered server. Nothing that exists is changed, so this is the right choice almost every time: look at the copy, then copy the rows you need back into the live database.

Mostly-On does not back up or manage the copy. Drop it when you are done (`DROP DATABASE [Sales_20261121_1403];`).

### Roll back the database (destructive)

Puts the managed database itself back to that moment, on the primary and on every secondary. **Every change made after this point-in-time disappears from the database.**

The tail-log backup and the other backups from after the point-in-time stay on the share until retention deletes them. However, the dashboard will only offer point-in-times on the database's *current* branch of history, so it cannot undo a rollback. **If you might need any of the changes made after the point-in-time, first restore a copy as it is now, then roll it back.**

### Removing a server

**Remove** on a server's page is greyed out while the server still holds a copy of a managed database, or while an unfinished operation involves it; its tooltip says what to do first (fail over, or remove the copy). A removed server is no longer contacted or listed, and nothing on the SQL Server itself is changed. The backups it took stay usable until retention deletes them. Registering a server under the same name later brings its record back, with the new connection details.

---

## Users and the audit trail

Give everyone who works with Mostly-On an account of their own (**Users** page), so you can tell who did what. Every user can do everything, including adding users, setting their passwords and disabling them. A user whose password someone else chose (a new account, or **Set password**) has to choose their own at the next sign-in. Accounts are disabled, never deleted, so their names keep meaning something in the log.

The first user comes from `ADMIN_USER` and `ADMIN_PASSWORD_HASH` when Mostly-On starts with an empty catalog. If nobody can sign in any more (say the only other user left, and you forgot your password), set a new password from the command line. It enables the account again, and its user chooses their own password at the next sign-in:

```sh
docker compose exec controller npm run reset-password -- <user>   # without a user name: lists the users
```

**Who did what** is recorded in three places:

- **Events page.** Every event has a **Who** column: a user, or *Mostly-On* for what it does by itself. Tick **Only what people did** for the audit trail: failovers, rollbacks, secondaries added and removed, settings and schedules changed, sign-ins, user changes, and so on, without the scheduled backups and log shipping. Events that belong to an operation (a failover completing, say) name the user who started it. The **Operations** page shows who started each one.
- **The container's log** (stdout, JSON lines). Each event is one line, with an `actor` field when a user did it. Docker's log drivers, and tools such as Loki, Datadog, Splunk or Elastic, can collect it from there.
- **The SQL Server error log** of the servers involved, for key actions only: failovers, switch-overs, rollbacks and copies to a point in time, adding or reinitializing a secondary, removing one, no longer managing a database, failed operations of these kinds, and operations marked resolved by hand. The lines start with `Mostly-On:` and say who did it, for example `Mostly-On: Failover of Sales from SQL1 to SQL2 started (with a tail-log backup: no data loss) (by alice, operation #42)`. On Windows they also land in the Application event log, where monitoring tools that watch it pick them up. This is a best-effort copy: a server that is down at that moment (the old primary in a forced failover, typically) doesn't get the line, and SQL Server recycles its error log at every restart (6 old files by default). The Events page is the complete record.

To find the lines on a server: `EXEC sys.xp_readerrorlog 0, 1, N'Mostly-On';`

---

## Upgrading

Pull the new image and restart the container:

```sh
docker compose pull && docker compose up -d
```

The image `ghcr.io/strdco/mostly-on` has these tags:

| Tag | What it is |
|---|---|
| `latest` | The newest release. |
| `0.2`, `0.2.1`, ... | A specific release. Pin `0.2` to get fixes for 0.2 without moving to 0.3 by surprise. |
| `edge` | Every change on `main`, before it is released. For trying things out, not for servers you rely on. |

Read the release notes before you upgrade.

**Some versions need the setup script again** on every server (the helper procedures have a version; the one that backs up system databases is version 5, the one that drops copies and brings read-only copies online is version 6, and the one that writes key actions to the SQL Server error log is version 7). Until it has run on a server, Mostly-On backs up and restores nothing there, and the Servers page and an alert say so. A newer script keeps working the way the older one did, so you can run it on every server just before you upgrade.

The catalog in `/data` upgrades itself on start:

- **Backup first.** Before the first change, Mostly-On saves a copy: `mostly-on.db.v001.bak`, named after the version it was at.
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

To run the demo stack with the controller built from your working copy instead of the published image, add `docker-compose.test.yml` (it also points notifications at a mock Pushover):

```sh
docker compose -f docker-compose.yml -f docker-compose.demo.yml -f docker-compose.test.yml up -d --build
```

The integration suite uses those three files too. It starts its own isolated compose project (`mostly-on-it`) with fresh secrets, separate volumes and its own ports (controller on 18080), so it does not touch a running demo stack. It walks through the brief end to end:

1. Register both servers with the restricted `mostly_on` login, manage a database, add a secondary, and check that it can't stop being managed while it has a secondary. Then check that the login can't do anything outside the helper procedures and their guard rails.
2. Fail over with a tail-log backup and check that the last row arrived, and that the owner fell back to `sa` because the owner's login is missing on the target.
3. Fail back, and get the original owner back.
4. Stop the primary, fail over without it, and check that shipped rows survived and the unshipped row is lost.
5. Bring the old primary back, see it flagged out of sync, and reinitialize it.
6. Restore copies of the database as it was at a moment, from the backups and after a fresh log backup: the row written after the moment is not in the copy, and the original is untouched.
7. Roll the database back to a moment: the change after it is gone, the tail-log backup that holds it stays on the share, and the secondary continues from the first log backup on the new branch.
8. Check that notifications are sent once and not repeated after a controller restart, using the mock Pushover in `docker-compose.test.yml`.
9. Switch the log-shipped database to BULK_LOGGED recovery: an alert says that it gets no log backups. Back in FULL recovery, shipping catches up and the alert resolves.
10. Back up master on both servers and a SIMPLE database (backups only): each server gets its own folder, LOG backups are skipped until the database is in FULL recovery, and secondaries and restores are refused.
11. Turn on automatic management for sql1, shipping to sql2, and check that sql2 is paired back. A new database on each server is managed and shipped to the other. Drop one: no alert while it is gone, then it is no longer managed, its copy on the secondary is dropped and its backup files are still there. Created again, it is managed again. The compose test file shortens the waits (`MOSTLY_ON_TEST_AUTO_SECONDS`).

It takes several minutes. Set `IT_KEEP=1` to leave the stack running afterwards for a look around, and `IT_REUSE=1` to rerun against it.

**Publishing the image.** `.github/workflows/publish.yml` runs the unit tests, then builds the image for amd64 and arm64 and pushes it to `ghcr.io/strdco/mostly-on`.

- **Every push to `main`** publishes `:edge`.
- **A release:** on GitHub, open **Actions → Publish image → Run workflow** on `main`, and type the version: a number such as `0.2.0`, or `patch`, `minor` or `major` to bump the current one. The workflow sets that version in `package.json`, commits it to `main`, tags it `v0.2.0`, publishes `:0.2.0`, `:0.2`, `:latest` and `:edge`, and creates a GitHub release with notes from the commits since the last one. A pre-release such as `0.3.0-beta.1` gets only its own tag and leaves `:latest` alone. Pull afterwards, since the release adds a commit to `main`.

---

## Known limitations

> [!IMPORTANT]
> This is not an enterprise-grade high-availability solution, nor is it a professional monitoring solution.

- **No automatic failover, no login sync, no client redirection.** These are out of scope by design; see the top of this file.
- **The controller is a single point of failure.** While it is down, no backups are taken and nothing ships. The databases themselves keep running, and everything catches up when it returns.
- **SQL Server 2019 or newer only.** Readable (STANDBY) secondaries need the same major version as the primary, and a secondary cannot run an older major version than its primary.
- **A long backup can hold up others on the same server.** Work waits in order, so with the default of 2, two long FULL backups on one server make its LOG backups and restores wait until one of them finishes, and the secondaries fall behind meanwhile. Give the FULL backups of large databases different times, or raise the limit for that server.
- **A short window during a failover with a tail-log backup.** Between disconnecting everyone (`SINGLE_USER`) and taking the tail-log backup, another program could grab the one allowed connection. The step then fails with "database is in use"; **Resume** tries again.
- **Backup times around daylight-saving changes.** SQL Server records backup times in the server's local time. Mostly-On converts them with the server's current UTC offset, so in the hour around a DST change, lag and "last backup" times can be off by an hour. Backups and restores themselves are not affected.
- **Delayed readable secondaries are not readable for a while after reinitializing or a rollback.** Those restores cannot leave the copy readable, so it stays `RESTORING` until its next log backup is old enough (up to the delay plus one log backup interval). Around a DST change, a delay can also be an hour longer or shorter, for the reason above.
- **Old undo files of readable secondaries stay behind.** A readable (STANDBY) copy needs an undo file (`.tuf`) in its standby folder, which is the server's data folder unless you set another one. Each time such a copy starts over (it is added, reinitialized or rolled back, or switched to readable), Mostly-On gives it a new undo file, `<database>.<date and time>.tuf`, and the previous one stays in the folder.
  - Why: SQL Server refuses to overwrite an undo file left behind by an earlier copy unless the login is a sysadmin (error 3441, "its standby file was inaccessible"), and nothing inside SQL Server can delete it.
  - The files are small. You can delete old ones by hand, but never the one the copy uses now: it is the one changed most recently, because it is rewritten at every restore. Deleting the file in use makes the next restore fail.
- **Backups-only databases are never restored by Mostly-On.** Restore them by hand from their `<database>@<server>` folder. Restoring master needs the SQL Server started in single-user mode; see Microsoft's documentation.
- **model usually gets LOG backups every 5 minutes.** On most editions model is in FULL recovery, so that new databases start in FULL recovery too. Its log backups are tiny; switch its LOG schedule off on its page if you don't want them. Don't switch model to SIMPLE recovery: new databases would start in SIMPLE.
- **A log-shipped name is taken on every server.** A log-shipped database is one database on every server, so a database with the same name on another server cannot be managed, not even as backups only.
- **Point-in-time restore and time zones.** SQL Server reads the moment in the local time of the server that wrote the log backup. Mostly-On converts it with that server's current UTC offset, so a moment within the hour around a DST change can be off by an hour; check the copy before relying on it.

---

## License

Mostly-On is licensed under the [MIT License](LICENSE): use, copy, change and share it for any purpose, including commercially, as long as you keep the copyright and license notice.
