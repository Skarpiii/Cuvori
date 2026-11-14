#!/bin/bash
# The rule Netlify runs before every build (tools/netlify-skip-build.sh). Since the check of 19 November it never cancels a
# build: when uploads come seconds apart, Netlify skips a build that a newer upload has overtaken and counts it as built,
# so a rule that skipped "only tests changed since the last build" cancelled the newer upload too, and the payment code of
# the overtaken one was never built (the webhook fix of 18 November, main 8eb0e0f: Netlify showed it "Skipped" and the next
# upload "Failed: no content change"). Every upload is built now (a branch deploy costs no credits; production is built
# only on purpose). Runs the rule in a throwaway repository, the way Netlify runs it before a build.
cd "$(dirname "$0")/.."
root=$(pwd); fail=0; n=0
check() {  # what, expected exit code (0 skip, 1 build), CACHED_COMMIT_REF, COMMIT_REF, deploy context (default: branch-deploy)
  n=$((n+1)); local got
  (cd "$T" && CONTEXT="${5:-branch-deploy}" CACHED_COMMIT_REF="$3" COMMIT_REF="$4" bash "$root/tools/netlify-skip-build.sh" >/dev/null 2>&1); got=$?
  if [ "$got" = "$2" ]; then echo "PASS $1"; else echo "FAIL $1 (got $([ $got = 0 ] && echo skip || echo build), must $([ $2 = 0 ] && echo skip || echo build))"; fail=1; fi
}
grep -Eq '^[[:space:]]*ignore[[:space:]]*=[[:space:]]*"bash \./tools/netlify-skip-build\.sh"' netlify.toml \
  && echo "PASS netlify.toml runs the rule before every build" || { echo "FAIL netlify.toml does not run tools/netlify-skip-build.sh"; fail=1; }
[ -f tools/netlify-skip-build.sh ] || { echo "FAIL tools/netlify-skip-build.sh is missing"; echo "deploy rule: SOMETHING FAILED"; exit 1; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
g() { git -C "$T" "$@" >/dev/null 2>&1; }
g init -q; g config user.email t@t; g config user.name t
c() { local f; for f in "$@"; do mkdir -p "$T/$(dirname "$f")"; echo "$RANDOM$RANDOM" >> "$T/$f"; done; g add -A; g commit -q -m x; git -C "$T" rev-parse HEAD; }
base=$(c index.html netlify/lib/cuvori.mjs netlify/functions/stripe-release.mjs netlify.toml tests/a.mjs SETUP.md supabase/schema_v1.sql realtest.js)
# what happened on 18 November: the webhook fix, overtaken by a test-only upload a few seconds later; Netlify skipped the
# fix's build and gave the test-only upload the skipped one as "the last commit we built"
fix=$(c netlify/functions/stripe-webhook.mjs);         tst=$(c tests/attack-check-nov18-live.mjs tests/run-all.sh)
check "a payment-code upload overtaken by a test-only one (Netlify skipped its build) -> build" 1 "$fix" "$tst"
t1=$(c tests/attack-money.mjs);                         check "only a test changed -> build" 1 "$tst" "$t1"
t2=$(c SETUP.md CLAUDE.md docs/notes.md);                check "only notes (.md) changed -> build" 1 "$t1" "$t2"
t3=$(c supabase/schema_v34.sql);                         check "only a database script (run by hand in Supabase) -> build" 1 "$t2" "$t3"
t4=$(c realtest.js mock-supabase.js galtest.js tests/xss/proof.js "tests/a b.js"); check "only the page tests and their fake database -> build" 1 "$t3" "$t4"
t5=$(c netlify/lib/cuvori.mjs);                          check "the payment code changed -> build" 1 "$t4" "$t5"
t6=$(c index.html);                                      check "the page changed -> build" 1 "$t5" "$t6"
t7=$(c netlify.toml);                                    check "the Netlify settings changed -> build" 1 "$t6" "$t7"
t8=$(c tools/netlify-skip-build.sh);                     check "this rule itself changed -> build" 1 "$t7" "$t8"
g rm -q netlify/lib/cuvori.mjs; g commit -q -m rm; t9=$(git -C "$T" rev-parse HEAD)
check "a payment file deleted -> build" 1 "$t8" "$t9"
check "no earlier build known (empty) -> build" 1 "" "$t9"
check "built without cache (Netlify then gives the same commit twice) -> build" 1 "$t9" "$t9"
check "the earlier build's commit is not in this copy -> build" 1 "0123456789abcdef0123456789abcdef01234567" "$t9"
check "no commit given at all -> build" 1 "" ""
# production (the "production" branch, which runs the hourly job) is built on purpose and costs credits: never skipped
check "production, only a test changed -> build" 1 "$base" "$t1" production
check "production, only notes and database scripts changed -> build" 1 "$t1" "$t3" production
check "production, after an overtaken upload -> build" 1 "$fix" "$tst" production
echo; [ $fail = 0 ] && echo "deploy rule: all $n checks passed" || echo "deploy rule: SOMETHING FAILED"
exit $fail
