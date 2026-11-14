#!/bin/bash
# Netlify runs this before every build (netlify.toml: [build] ignore). Exit 0 = skip the build, exit 1 = build.
# Every upload is built. Until the check of 19 November an upload to main that changed only files Netlify never uses
# (tests, notes, database scripts) was skipped, compared with "the last commit Netlify built". But when uploads come
# seconds apart, Netlify itself skips a build that a newer upload has overtaken ("a new one was scheduled for the same
# branch") and then gives that skipped commit as the last one built. So the webhook fix of 18 November (main 8eb0e0f),
# overtaken by a test-only upload a few seconds later (0aaf3e7), was skipped by Netlify, and this rule then cancelled the
# test-only upload as "no content change": the fix was never built, and the payment functions stayed on the code of
# 31 October with nothing but "Skipped" and "Failed" in Netlify's list. Netlify gives no other way to know which commit a
# branch really runs, so no skip can be sure; building costs nothing (a branch deploy costs no credits, and production is
# built only on purpose), and a build always carries everything up to its upload, so an overtaken one is never lost.
# Tested by tests/netlify-skip.sh.
if [ "${CONTEXT:-}" = "production" ]; then echo "Production build: always built."; exit 1; fi
echo "Every upload is built (tools/netlify-skip-build.sh): building."
exit 1
