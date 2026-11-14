#!/bin/bash
# usage: tests/db/load.sh [upto]   -- recreates database "cuvori" and loads schema files
set -e
H="$(cd "$(dirname "$0")" && pwd)"
PGDIR="${PGDIR:-/tmp/cuvori-pgtest}"
P="psql -h $PGDIR -p 5499 -U postgres -v ON_ERROR_STOP=1 -q"
$P -c "drop database if exists cuvori" -c "create database cuvori" >/dev/null
$P -d cuvori -c "drop role if exists anon" >/dev/null 2>&1 || true
D="$H/../../supabase"; [ -n "${TARGET:-}" ] && D="$(cd "$TARGET" && pwd)/supabase"   # the copy under test (TARGET), else this one
$P -d cuvori -f "$H/00_supabase_stub.sql" >/dev/null 2>&1 || $P -d cuvori -f <(grep -v '^create role' "$H/00_supabase_stub.sql") >/dev/null
for f in schema.sql schema_v2.sql schema_v3.sql schema_v4.sql schema_v5.sql schema_v6.sql schema_v7.sql schema_v8.sql ${EXTRA:-}; do
  [ -f "$D/$f" ] || continue
  $P -d cuvori -f "$D/$f" >/dev/null || { echo "FAILED loading $f"; exit 1; }
done
echo loaded
