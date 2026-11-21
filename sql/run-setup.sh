#!/bin/bash
# Demo compose one-shot: on each SQL Server, create (or update) the restricted
# login Mostly On uses, then install the signed helper procedures for it.
# Running it again is safe.
set -euo pipefail
SQLCMD=/opt/mssql-tools18/bin/sqlcmd

for host in ${SETUP_SERVERS:-sql1 sql2}; do
    echo "Setting up ${host}"
    for _ in $(seq 1 90); do
        "${SQLCMD}" -C -S "${host}" -U sa -P "${MSSQL_SA_PASSWORD}" -b -Q "SELECT 1;" -o /dev/null && break
        sleep 2
    done
    "${SQLCMD}" -C -S "${host}" -U sa -P "${MSSQL_SA_PASSWORD}" -b -v LoginPassword="${MOSTLY_ON_SQL_PASSWORD}" -Q "
        SET NOCOUNT ON;
        IF (SUSER_ID(N'mostly_on') IS NULL) CREATE LOGIN mostly_on WITH PASSWORD=N'\$(LoginPassword)', CHECK_POLICY=OFF;
        ELSE ALTER LOGIN mostly_on WITH PASSWORD=N'\$(LoginPassword)';"
    "${SQLCMD}" -C -S "${host}" -U sa -P "${MSSQL_SA_PASSWORD}" -b -i /setup/mostly-on-helpers.sql \
        -v ServiceLogin="mostly_on" BackupRoot="/var/opt/mssql/backup" StandbyRoot="default" FallbackOwner="sa"
done
echo "Mostly On setup finished on: ${SETUP_SERVERS:-sql1 sql2}"
