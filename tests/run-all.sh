#!/bin/bash
# Runs every check. Usage: tests/run-all.sh   (from the repo root)
cd "$(dirname "$0")/.."
set -o pipefail
r=0
echo "== CSP";            python3 tools/csp.py index.html --check || r=1
echo "== database attacks"; tests/db/start-pg.sh >/dev/null; out=$(EXTRA="schema_v9.sql schema_v10.sql schema_v11.sql schema_v12.sql schema_v13.sql schema_v14.sql schema_v15.sql professions_seed.sql schema_v16.sql schema_v17.sql professions_seed.sql schema_v18.sql schema_v19.sql schema_v20.sql schema_v21.sql" MIGRATE="migrate_v15.sql" tests/db/run.sh | tail -1); echo "$out"; echo "$out" | grep -q ' 0 failed' || r=1
echo "== payment attacks";  out=$(node tests/attack-functions.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks";    out=$(node tests/attack-money.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== stored XSS";       tests/xss/run.sh || r=1
echo "== CSP in browser";   node tests/csp-test.js || r=1
echo "== UI fuzz";          node tests/ui-fuzz.js | tail -1 || r=1
echo "== full site flows";  node realtest.js | tail -3; node realtest.js | grep -q '^FAIL' && r=1
echo "== jobs trust";       node jobstest.js | tail -3; node jobstest.js | grep -q '^FAIL' && r=1
echo "== galleries";        node galtest.js | tail -1
echo "== auth";             node authtest.js | tail -1
echo "== oauth return";     node tests/oauth-return.js | tail -1
[ $r = 0 ] && echo "ALL CHECKS PASSED" || echo "SOMETHING FAILED"
exit $r
