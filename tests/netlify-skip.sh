#!/bin/bash
# The rule that skips a Netlify build when an upload changes only files Netlify never uses (tools/netlify-skip-build.sh).
# A production deploy costs 15 of the 300 monthly credits on Netlify's free plan. The rule must skip only when it is
# sure, and build in every other case. Runs it in a throwaway repository, the way Netlify runs it before a build.
cd "$(dirname "$0")/.."
root=$(pwd); fail=0; n=0
check() {  # what, expected exit code (0 skip, 1 build), CACHED_COMMIT_REF, COMMIT_REF
  n=$((n+1)); local got
  (cd "$T" && CACHED_COMMIT_REF="$3" COMMIT_REF="$4" bash "$root/tools/netlify-skip-build.sh" >/dev/null 2>&1); got=$?
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
t1=$(c tests/attack-money.mjs);                         check "only a test changed -> skip" 0 "$base" "$t1"
t2=$(c SETUP.md CLAUDE.md docs/notes.md);                check "only notes (.md) changed -> skip" 0 "$t1" "$t2"
t3=$(c supabase/schema_v34.sql);                         check "only a database script (run by hand in Supabase) -> skip" 0 "$t2" "$t3"
t4=$(c realtest.js mock-supabase.js galtest.js tests/xss/proof.js "tests/a b.js"); check "only the page tests and their fake database -> skip" 0 "$t3" "$t4"
check "several skippable uploads in a row, compared with the last build -> skip" 0 "$base" "$t4"
t5=$(c netlify/lib/cuvori.mjs);                          check "the payment code changed -> build" 1 "$t4" "$t5"
t6=$(c tests/attack-money.mjs);                          check "code changed after the last build, then only a test -> build" 1 "$t4" "$t6"
t7=$(c index.html);                                      check "the page changed -> build" 1 "$t6" "$t7"
t8=$(c netlify.toml);                                    check "the Netlify settings changed -> build" 1 "$t7" "$t8"
t9=$(c tools/netlify-skip-build.sh);                     check "this rule itself changed -> build" 1 "$t8" "$t9"
t10=$(c tests/x.mjs orders-ui.js);                       check "a test and a page file together -> build" 1 "$t9" "$t10"
g mv netlify/functions/stripe-release.mjs tests/moved.mjs; g commit -q -m mv; t11=$(git -C "$T" rev-parse HEAD)
check "a function moved into tests (it is gone from Netlify) -> build" 1 "$t10" "$t11"
g rm -q netlify/lib/cuvori.mjs; g commit -q -m rm; t12=$(git -C "$T" rev-parse HEAD)
check "a payment file deleted -> build" 1 "$t11" "$t12"
check "no earlier build known (empty) -> build" 1 "" "$t12"
check "built without cache (Netlify then gives the same commit twice) -> build" 1 "$t12" "$t12"
check "the earlier build's commit is not in this copy -> build" 1 "0123456789abcdef0123456789abcdef01234567" "$t12"
check "no commit given at all -> build" 1 "" ""
echo; [ $fail = 0 ] && echo "deploy rule: all $n checks passed" || echo "deploy rule: SOMETHING FAILED"
exit $fail
