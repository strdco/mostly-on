# syntax=docker/dockerfile:1
# Mostly-On controller image.

# --- build stage: installs production deps; compilers are present in case
#     better-sqlite3 has no prebuilt binary for this Node/arch combination.
FROM node:26-trixie-slim AS build
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# --- runtime stage
FROM node:26-trixie-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    BACKUP_ROOT=/backup \
    PORT=8080
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY sql ./sql

# Run as uid 10001, gid 0: the same uid the mssql containers use, so the
# controller can create backup directories that SQL Server writes into and
# delete backup files SQL Server created (retention).
RUN mkdir -p /data /backup && chown 10001:0 /data /backup && chmod 2770 /data /backup
USER 10001:0

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/main.js"]
