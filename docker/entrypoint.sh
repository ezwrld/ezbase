#!/bin/bash
set -e

# ---------- Postgres init ----------
if [ ! -f /data/postgres/PG_VERSION ]; then
    echo "ezbase: initializing postgres..."
    chown postgres:postgres /data/postgres
    su postgres -c "/usr/lib/postgresql/16/bin/initdb -D /data/postgres"
fi

# Start postgres temporarily to create user/db
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /data/postgres -l /tmp/pg-init.log start -w"

# Create role and database if they don't exist
su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='ezbase'\" | grep -q 1" \
    || su postgres -c "psql -c \"CREATE ROLE ezbase WITH LOGIN PASSWORD 'ezbase'\""
su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='ezbase'\" | grep -q 1" \
    || su postgres -c "psql -c \"CREATE DATABASE ezbase OWNER ezbase\""

# Stop postgres — supervisord will manage it from here
su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /data/postgres stop -w"

# ---------- File storage dir ----------
mkdir -p /data/files

# ---------- Rules file ----------
if [ ! -f /data/rules.json ]; then
    echo '{ "default": "public" }' > /data/rules.json
    echo "ezbase: created default rules.json"
fi

# ---------- Start everything ----------
echo "ezbase: starting services..."
exec supervisord -c /etc/supervisor/conf.d/ezbase.conf
