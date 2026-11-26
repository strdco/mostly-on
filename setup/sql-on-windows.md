# SQL Server on Windows

Repeat these steps on each SQL Server.

Before you start: Mostly-On is running, and the backup share is ready as an **SMB share** ([Setting up the Mostly-On container](mostly-on-container.md), steps 1 to 5).

## 1. Prepare SQL Server

Mostly-On doesn't change these settings for you:

- [ ] **Turn on TCP/IP**: SQL Server Configuration Manager → SQL Server Network Configuration → Protocols → TCP/IP → Enabled. Restart SQL Server.
- [ ] **Decide how Mostly-On finds the instance.** Either give the instance a fixed TCP port (TCP/IP → Properties → IP Addresses → IPAll), or keep the **SQL Server Browser** service running, so Mostly-On can look the port up by instance name.
- [ ] **Allow the port in Windows Firewall**, from the Mostly-On machine. With SQL Server Browser, also allow UDP 1434.
- [ ] **Turn on mixed-mode authentication** (SQL Server and Windows Authentication): in SSMS, server properties → Security. Mostly-On connects with a SQL login only.

## 2. Give SQL Server access to the share

SQL Server writes its backups to the share as its **service account**, so that account needs rights on it.

- [ ] Give SQL Server's service account **Modify** rights on the share and its folder. The default virtual account (`NT Service\MSSQL$<instance>`, or `NT Service\MSSQLSERVER`) reaches the network as the machine's computer account, so grant `DOMAIN\MACHINE$`. Better: run SQL Server as a group managed service account (gMSA), and grant that.
- [ ] Check it. In SSMS, take a test backup to the share, then delete the file:

  ```sql
  BACKUP DATABASE model TO DISK = N'\\fileserver\sqlbackup\test.bak' WITH COPY_ONLY, INIT;
  ```

  If it fails with *Operating system error 5 (Access is denied)*, the service account doesn't have the rights yet.

## 3. Let Mostly-On connect

- [ ] Create a login for Mostly-On. In SSMS, as a sysadmin, run:

  ```sql
  CREATE LOGIN mostly_on WITH PASSWORD = N'…', CHECK_EXPIRATION = OFF;
  ```

  Give it nothing else: the setup script in step 4 grants exactly what Mostly-On needs, and no more.

## 4. Register the server and run its setup script

- [ ] In Mostly-On, on the **Servers** page, press **Register server**:

  | Field | Value |
  |---|---|
  | Display name | A short name, such as `sql1`. It ends up in backup file names. |
  | Host / Port | The machine's name or IP address, and the fixed port. With SQL Server Browser, enter the instance name under **More options** instead. |
  | SQL login / Password | `mostly_on` and its password. |
  | Shared backup folder, as this SQL Server sees it | The share's path, `\\fileserver\sqlbackup` |

- [ ] Download the server's setup script. Mostly-On offers it right after you register the server, or later on the server's page, under **Setup**. It has the server's backup folder and login filled in.
- [ ] Run the script in SSMS as a sysadmin. Running it again is always safe.
- [ ] Within a minute, the server's page shows **ready**.

Why the script, and what it allows: [The setup script](../README.md#the-setup-script-and-why-mostly-on-does-not-need-sysadmin).
