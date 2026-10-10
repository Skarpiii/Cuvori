#!/bin/bash
# Runs every check. Usage: bash tests/run-all.sh   (from the repo folder)
cd "$(dirname "$0")/.."
set -o pipefail
r=0
# The checks that live only in the test kit (the database attacks, the galleries, …) are unpacked from it first. A file
# that is already here is never replaced: the kit is a snapshot from 19 September, and 17 of its files have newer
# versions in the repo (page code, the page test, the test backend, the payment tests, this file).
tar --skip-old-files -xzf tests/test-kit.tar.gz || { echo "could not unpack tests/test-kit.tar.gz"; r=1; }
# A check that opens the page passes only when it ran to the end (exit code 0), printed PASS lines and no FAIL or
# CRASH line: a check that stops half-way, or prints nothing, is a failure, never a quiet pass.
page() { local out code; out=$(timeout 1800 node "$@" 2>&1); code=$?; echo "$out" | grep -v '^\s*$' | tail -2
  if [ $code -ne 0 ] || echo "$out" | grep -qE '^(FAIL|CRASH)' || ! echo "$out" | grep -q '^PASS'; then
    echo "FAILED (exit $code): $(echo "$out" | grep -E '^(FAIL|CRASH)' | head -3 | tr '\n' ' ')"; r=1; fi; }
echo "== CSP";            python3 tools/csp.py index.html --check || r=1
echo "== database attacks"; tests/db/start-pg.sh >/dev/null; out=$(EXTRA="schema_v9.sql schema_v10.sql schema_v11.sql schema_v12.sql schema_v13.sql schema_v14.sql schema_v15.sql professions_seed.sql schema_v16.sql schema_v17.sql professions_seed.sql schema_v18.sql schema_v19.sql schema_v20.sql schema_v21.sql schema_v22.sql schema_v23.sql schema_v24.sql schema_v25.sql schema_v26.sql schema_v27.sql schema_v28.sql schema_v29.sql schema_v30.sql schema_v31.sql schema_v32.sql schema_v33.sql" MIGRATE="migrate_v15.sql" tests/db/run.sh | tail -1); echo "$out"; echo "$out" | grep -q ' 0 failed' || r=1
echo "== payment attacks";  out=$(node tests/attack-functions.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks";    out=$(node tests/attack-money.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks 2";  out=$(node tests/attack-money2.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks 3";  out=$(node tests/attack-money3.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== processing fee";   out=$(node tests/attack-fee.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== roles & tampering"; out=$(node tests/attack-roles.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== Stripe accounts per mode"; out=$(node tests/attack-connect.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== limit on tries";   out=$(node tests/attack-rate.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== limits match";     out=$(node tests/limits-match.mjs | tail -1); echo "$out"; echo "$out" | grep -q " 0 failed" || r=1
echo "== stored XSS";       bash tests/xss/run.sh || r=1
echo "== CSP in browser";   node tests/csp-test.js || r=1
echo "== UI fuzz";          node tests/ui-fuzz.js | tail -1 || r=1
echo "== full site flows";  page realtest.js
echo "== jobs trust";       page jobstest.js
echo "== post a job";       node tests/post-job.js | tail -1 || r=1
echo "== reviews";          node tests/reviews.js | tail -1 || r=1
echo "== galleries";        page galtest.js
echo "== auth";             page authtest.js
echo "== oauth return";     page tests/oauth-return.js
[ $r = 0 ] && echo "ALL CHECKS PASSED" || echo "SOMETHING FAILED"
exit $r
