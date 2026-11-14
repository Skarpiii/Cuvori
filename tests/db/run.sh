#!/bin/bash
# Loads the schema (plus EXTRA files, e.g. EXTRA=schema_v9.sql) and runs every attack. Prints a report.
export PGOPTIONS='-c client_min_messages=warning'
[ -n "${TARGET:-}" ] && export TARGET="$(cd "$TARGET" && pwd)"   # the copy under test (TARGET): its database scripts are loaded, here and in load.sh
cd "$(dirname "$0")"
./load.sh >/dev/null || exit 1
P="psql -h ${PGDIR:-/tmp/cuvori-pgtest} -p 5499 -U postgres -d cuvori -q -v ON_ERROR_STOP=1"
$P -f 10_harness.sql >/dev/null && $P -f 20_seed.sql >/dev/null || exit 1
for f in ${MIGRATE:-}; do $P -f "${TARGET:-../..}/supabase/$f" >/dev/null || { echo "FAILED running $f"; exit 1; }; done
$P -f 30_attacks.sql >/dev/null || exit 1
$P -At -F ' ' -c "select case when ok then 'PASS' else 'FAIL' end, '['||grp||']', name, case when not ok then '  -- '||detail else '' end from t.results order by n"
$P -At -c "select count(*) filter (where ok) || ' passed, ' || count(*) filter (where not ok) || ' failed' from t.results"
