# Setting up the Mostly-On container

Mostly-On runs as one container. This guide sets it up, together with the backup share that it and your SQL Servers use. Then set up each SQL Server with the guide that matches it (see [Next: your SQL Servers](#next-your-sql-servers)).

You need:

- **A Linux machine with Docker Engine and the Docker Compose plugin.** It doesn't need much power: SQL Server does the backups and restores, and Mostly-On only tells it what to do.
- **A file server or NAS for the backup share**, which every SQL Server and this machine can reach. Not one of the SQL Servers: if that machine fails, its share fails with it, just when you need the backups to fail over.
- **Network access** from this machine to each SQL Server's port (TCP 1433 by default).

> [!NOTE]
> **Only Windows servers?** Create a small Linux VM, for example in Hyper-V, install Docker Engine in it, and follow this guide inside the VM.
> Docker Desktop and WSL are fine for trying Mostly-On out, but they're built for desktops, not servers: they don't start by themselves when the machine boots.

## 1. Prepare the backup share

![One shared backup folder on a file server or NAS. Mostly-On sees it as /backup, sql1 (SQL Server in a Linux container) as /var/opt/mssql/backup, and sql2 (SQL Server on Windows) as a UNC path. sql1 writes backups to it, sql2 reads and restores them, and Mostly-On creates folders and deletes expired backups.](../docs/images/shared-backup-folder.png)

Do this once, on the file server. Pick NFS or SMB:

- **NFS** is native to Linux and needs no passwords. But the server trusts any listed host and whatever user ID it claims, and traffic isn't encrypted (short of setting up Kerberos). Use it on a network you control.
- **SMB** protects the share with a password and can encrypt traffic (SMB 3). Use it if any of your SQL Servers is installed on Windows.

**NFS**, on the NFS server:

- [ ] Create the folder and give it to user 10001, group 0: the user that Mostly-On and SQL Server containers run as. The 2 in `2770` (the setgid bit) makes new folders inside it keep group 0:

  ```sh
  sudo mkdir -p /srv/sqlbackup
  sudo chown 10001:0 /srv/sqlbackup
  sudo chmod 2770 /srv/sqlbackup
  ```

- [ ] Export it to this machine and to every SQL Server host, by name (never `*`): add a line to `/etc/exports`, then run `sudo exportfs -ra`.

  ```
  /srv/sqlbackup  mostly-on-host(rw,sync) sql1(rw,sync) sql2(rw,sync)
  ```

  A SQL Server installed on Linux (not in a container) needs extra options on its entry; see [SQL Server on Linux](sql-on-linux.md).

**SMB**, on the file server or NAS:

- [ ] Create the share, for example `\\fileserver\sqlbackup`, and an account for it (for example `sqlbackup`) with **Modify** rights on the share and its folder. Linux machines connect with this account. SQL Servers on Windows use their own service account instead; see [SQL Server on Windows](sql-on-windows.md).

## 2. Mount the share on this machine

Mostly-On runs in a container, and a container only sees the folders you hand it. So you mount the share on this machine first, at `/mnt/sqlbackup`, and hand it to the container in step 4.

- [ ] Create the folder to mount the share on, and lock it while it's empty. If the share ever fails to mount, nothing can then land on the local disk by mistake:

  ```sh
  sudo mkdir -p /mnt/sqlbackup
  sudo chattr +i /mnt/sqlbackup
  ```

- [ ] **NFS:** add this line to `/etc/fstab`, so the share is mounted at every start:

  ```
  nfs-server:/srv/sqlbackup  /mnt/sqlbackup  nfs  rw,nfsvers=4.1,_netdev  0  0
  ```

- [ ] **SMB:** install the SMB client, and store the share's account in a file that only root can read:

  ```sh
  sudo apt install cifs-utils        # or: sudo dnf install cifs-utils
  sudo install -m 600 /dev/null /etc/sqlbackup.cred
  sudo nano /etc/sqlbackup.cred
  ```

  with these three lines:

  ```
  username=sqlbackup
  password=...
  domain=EXAMPLE
  ```

  Then add this line to `/etc/fstab`. `uid=10001,gid=0` makes the files appear owned by the user Mostly-On runs as. Add `seal` to the options to encrypt traffic.

  ```
  //fileserver/sqlbackup  /mnt/sqlbackup  cifs  credentials=/etc/sqlbackup.cred,uid=10001,gid=0,file_mode=0660,dir_mode=0770,vers=3.0,_netdev  0  0
  ```

- [ ] Mount it, and check that user 10001 can write and delete there:

  ```sh
  sudo mount /mnt/sqlbackup
  docker run --rm -u 10001:0 -v /mnt/sqlbackup:/b busybox:1.37 sh -c 'touch /b/.test && rm /b/.test && echo OK'
  ```

## 3. Get the files and fill in the settings

- [ ] Create a folder for Mostly-On, and download the compose file and the settings template into it:

  ```sh
  mkdir ~/mostly-on && cd ~/mostly-on
  curl -fsSLO https://raw.githubusercontent.com/strdco/mostly-on/main/docker-compose.yml
  curl -fsSL -o .env https://raw.githubusercontent.com/strdco/mostly-on/main/.env.example
  ```

- [ ] Generate the password hash for the first dashboard user (`admin`):

  ```sh
  docker run --rm -it ghcr.io/strdco/mostly-on:latest node scripts/hash-password.js
  ```

- [ ] Generate a secret key. Mostly-On encrypts the SQL Server passwords with it. Keep a copy somewhere safe: without it, you have to re-enter every server's password.

  ```sh
  openssl rand -base64 32
  ```

- [ ] In `.env`, fill in `ADMIN_PASSWORD_HASH` and `SECRET_KEY`, set `PUBLIC_URL` to the address people will use (for example `http://mostly-on-host:8080`) and `TZ` to your time zone (for example `Europe/Stockholm`), and optionally the Pushover keys for notifications. The demo-only values at the bottom can stay empty. All settings: [Configuration](../README.md#configuration).

## 4. Hand the share to the container

- [ ] In `docker-compose.yml`, change `- backup:/backup` to `- /mnt/sqlbackup:/backup`, and remove the `backup:` line under `volumes:` at the bottom.

Leave `controller-data` as it is. That volume holds Mostly-On's catalog (settings, history, operations), keeps it when you update the image, and needs no preparation. Back it up like any other application data.

## 5. Start it

- [ ] Start Mostly-On:

  ```sh
  docker compose up -d
  ```

- [ ] Check that it can write and delete on the share:

  ```sh
  docker compose exec controller sh -c 'touch /backup/.test && rm /backup/.test && echo OK'
  ```

- [ ] Open `PUBLIC_URL` (for example `http://mostly-on-host:8080`) and sign in as `admin`. Add the people who'll use Mostly-On on the **Users** page.

## 6. Recommended: HTTPS

- [ ] For anything but a lab, put a reverse proxy that handles HTTPS (nginx, Caddy, Traefik) in front of port 8080, and set `PUBLIC_URL` to its `https://` address. The login cookie is then marked Secure automatically.

## Next: your SQL Servers

Set up each SQL Server with the guide that matches how it runs. You can mix them: a Windows primary with a Linux secondary works.

| SQL Server runs… | Guide |
|---|---|
| in a container, on a Linux machine | [SQL Server containers on Linux](sql-containers-on-linux.md) |
| installed on a Linux machine | [SQL Server on Linux](sql-on-linux.md) |
| installed on a Windows machine | [SQL Server on Windows](sql-on-windows.md) |

To update Mostly-On later: `docker compose pull && docker compose up -d`. See [Upgrading](../README.md#upgrading-mostly-on).
