#!/usr/bin/env bash
set -euo pipefail
initdb -D "$DIR/data" -U postgres --auth=trust
pg_ctl -D "$DIR/data" -o "-p $PORT -k $DIR" start
export PGHOST="$DIR" PGPORT="$PORT" PGUSER=postgres
psql -q -d postgres -c "drop database if exists fixture_test;" -c "create database fixture_test;"
