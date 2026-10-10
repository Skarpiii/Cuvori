#!/bin/bash
# Stored-XSS proofs: each one saves an attacker's text in the fake database and checks that the page shows it as text.
# A proof passes only when it printed at least one PASS, no FAIL, and finished cleanly: a proof that crashed, or one
# that never reached the place it attacks (the page changed), fails instead of passing quietly.
cd "$(dirname "$0")/../.."
fail=0
for f in tests/xss/proof*.js; do
  out=$(timeout 300 node "$f" 2>&1); code=$?
  echo "$out" | grep -E '^(PASS|FAIL) '
  if [ $code -ne 0 ] || echo "$out" | grep -q '^FAIL' || ! echo "$out" | grep -q '^PASS'; then
    echo "FAIL $f (exit $code)"; echo "$out" | grep -vE '^(PASS|FAIL) ' | head -5; fail=1
  fi
done
[ $fail = 0 ] && echo "stored XSS: every proof passed" || echo "stored XSS: SOMETHING FAILED"
exit $fail
