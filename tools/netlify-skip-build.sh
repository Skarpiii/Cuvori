#!/bin/bash
# Netlify runs this before every build (netlify.toml: [build] ignore). Exit 0 = skip the build, exit 1 = build.
# Uploads go to the main branch, which Netlify builds as free branch deploys (the page and Stripe use that address). An
# upload there that changes only files Netlify never uses — tests, notes (.md), database scripts that are run by hand in
# Supabase, screenshots — is skipped: that saves build time, not credits.
# The production branch ("production", which runs the hourly job; 15 of the 300 monthly credits on the free plan per
# deploy) is only built on purpose, so it is never skipped: "the last commit Netlify built" may then be a branch deploy's,
# not what production runs, and a wrong skip would leave the hourly job on old code.
# On main, anything else builds, and so does every doubt: no earlier build to compare with, the same commit twice (Netlify
# gives that when it builds without its cache), or that earlier commit not available here.
# Compared with the last commit Netlify built, not just the previous upload: skipped uploads add up, so a code change
# followed by a test-only upload still builds. A moved or deleted file counts on both sides (renames are not merged),
# so a function moved out of netlify/ builds too. Tested by tests/netlify-skip.sh.
if [ "${CONTEXT:-}" = "production" ]; then echo "Production build: always built."; exit 1; fi
base="${CACHED_COMMIT_REF:-}"; head="${COMMIT_REF:-}"
if [ -z "$base" ] || [ -z "$head" ] || [ "$base" = "$head" ]; then echo "No earlier build to compare with: building."; exit 1; fi
changed=$(git diff --name-only --no-renames "$base" "$head" 2>/dev/null) || { echo "Cannot compare with $base: building."; exit 1; }
if [ -z "$changed" ]; then echo "Nothing to compare: building."; exit 1; fi
while IFS= read -r f; do
  case "$f" in
    tests/*|supabase/*|shots/*|*.md|realtest.js|galtest.js|authtest.js|jobstest.js|fntest.mjs|mock-supabase.js) ;;
    *) echo "Changed since the last build: $f — building."; exit 1 ;;
  esac
done <<< "$changed"
echo "Only tests, notes or database scripts changed since the last build: no deploy needed."
exit 0
