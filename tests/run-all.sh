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
echo "== database attacks"; tests/db/start-pg.sh >/dev/null; out=$(EXTRA="schema_v9.sql schema_v10.sql schema_v11.sql schema_v12.sql schema_v13.sql schema_v14.sql schema_v15.sql professions_seed.sql schema_v16.sql schema_v17.sql professions_seed.sql schema_v18.sql schema_v19.sql schema_v20.sql schema_v21.sql schema_v22.sql schema_v23.sql schema_v24.sql schema_v25.sql schema_v26.sql schema_v27.sql schema_v28.sql schema_v29.sql schema_v30.sql schema_v31.sql schema_v32.sql schema_v33.sql schema_v34.sql schema_v35.sql schema_v36.sql schema_v37.sql schema_v38.sql schema_v39.sql schema_v40.sql schema_v41.sql schema_v42.sql schema_v43.sql schema_v44.sql schema_v45.sql schema_v46.sql schema_v47.sql schema_v48.sql schema_v49.sql schema_v50.sql schema_v51.sql schema_v52.sql schema_v53.sql schema_v54.sql schema_v55.sql schema_v56.sql" MIGRATE="migrate_v15.sql" tests/db/run.sh | tail -1); echo "$out"; echo "$out" | grep -q ' 0 failed' || r=1
echo "== payment attacks";  out=$(node tests/attack-functions.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks";    out=$(node tests/attack-money.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks 2";  out=$(node tests/attack-money2.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== money attacks 3";  out=$(node tests/attack-money3.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== processing fee";   out=$(node tests/attack-fee.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== Stripe's fee when it is billed later (standalone fees)"; out=$(node tests/attack-standalone-fees.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== audit of 31 October (chargeback re-payments, milestone payouts, stored fees)"; out=$(node tests/attack-audit-oct31.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== fixes of 1 November (two chargebacks at once, stuck decisions, inquiries, the hourly run, whole payments)"; out=$(node tests/attack-fixes-nov1.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 1 November (milestone payout counted by the repair, dashboard refunds counted once, transfers after a pull-back, late-refund queue, ended inquiries)"; out=$(node tests/attack-check-nov1.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 2 November (a won chargeback's re-payment never divided, paid at once; a second chargeback no longer freezes; hourly retries that never settle hold up nobody)"; out=$(node tests/attack-check-nov2.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== fixes of 2 November, payments coming in (two pages for one Order never both charged; a top-up's missing line added and its chargeback recognised; notes and history lines after a lost answer; a second equal price increase payable; a card fee that can't be known noted)"; out=$(node tests/attack-fixes-nov2-in.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== fixes of 2 November, payouts and decisions (Orders in parts that hold nothing close, a decision not on record waits for the admin, plan 1 re-payments counted, old chargeback notices, the hourly retry lists)"; out=$(node tests/attack-fixes-nov2-out.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== fixes of 2 November, funds segregation (a payout never paid twice after a lost answer, re-payments never the decision's share, the sweep never takes money still owed and reaches every closed Order, a smaller rest after a dashboard refund, refusals named, the fee work within 30 seconds)"; out=$(node tests/attack-fixes-nov2-fs.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 6 November (a re-payment Stripe made is counted before a cancel or decision; a half-finished second chargeback finished; a chargeback already won never recorded; stuck decisions; the decision note; preview only when true; the smaller points)"; out=$(node tests/attack-check-nov6.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 7 November (a payout pulled back before it was counted is never paid again; failed refunds made again and their notices; a price increase paid on two pages; stuck decisions and chargebacks; what a cancel or decision records; decisions told once; inquiry notes; partly refunded chargebacks)"; out=$(node tests/attack-check-nov7.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 7 November, the database (the evidence only while there is something to decide; the admin log keeps no one's words; the admin's list at the new prices; marking a note as handled)"; out=$(node tests/attack-check-nov7-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 8 November (failed refunds made again counted once, also before v56; decisions told only once carried out; a top-up never takes another one's line; a payout counted before a chargeback; parts marked; a cancel or decision refused when its first count fails)"; out=$(node tests/attack-check-nov8.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 8 November, the database and the page (the admin log: the admin's own name and job flags, review moderation, messages to someone; the evidence's rule and button; the Mark-as-handled window; admin amounts)"; out=$(node tests/attack-check-nov8-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== re-check of 8 November (a chargeback never frozen by its first count; a cancel or decision under review when the books need a check; failed refund notes once; every waiting part looked at; a database without v56)"; out=$(node tests/attack-recheck-nov8.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== re-check of 8 November, the database and the page (a job warning keeps no job title in the admin log; under review explained to the admin)"; out=$(node tests/attack-recheck-nov8-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== second re-check of 8 November (a passing error at a chargeback's first count fails the notice, and Stripe sends it again; the note \"payouts not in the books\" stays until handled)"; out=$(node tests/attack-recheck2-nov8.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== second re-check of 8 November, the database (only the job warning itself is logged without its words)"; out=$(node tests/attack-recheck2-nov8-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== fixes of 9 November (a chargeback decided for Cuvori on an Order whose books can't take a payout: every notice answered, the re-payment worked out, the Order says what can't be counted)"; out=$(node tests/attack-fixes-nov9.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== re-check of 9 November (the note \"payouts not in the books\" stays until handled; what the freelancer was not paid back after a won chargeback is said, follows Stripe and is paid by Cuvori once the money is back; a note that can't be saved fails the step)"; out=$(node tests/attack-recheck-nov9.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== re-check of 9 November, the database (the admin log's job-warning rule with standard_conforming_strings off, and only for the warn action's own call)"; out=$(node tests/attack-recheck-nov9-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== check of 11 November (a chargeback at today's prices on an Order whose books can't take a payout: every notice answered, the pull-back written down and made once, decided either way)"; out=$(node tests/attack-check-nov11.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== the payment code for the new prices (5% on payouts, no client fees, the ledger lines of schema v56, failures at every write)"; out=$(node tests/attack-plan2.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== roles & tampering"; out=$(node tests/attack-roles.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== Stripe accounts per mode"; out=$(node tests/attack-connect.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== webhook formats";  out=$(node tests/attack-webhook-format.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== error texts";      out=$(node tests/attack-error-text.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== retry keys";       out=$(node tests/attack-idempotency.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== payment races";    out=$(node tests/attack-payment-race.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== first payment's ledger line"; out=$(node tests/attack-first-payment.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== payout ledger lines"; out=$(node tests/attack-payout-lines.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== payment lock (database)"; out=$(node tests/attack-payment-lock.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== account deletion (database)"; out=$(node tests/attack-account-delete.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== account files (database)"; out=$(node tests/attack-account-files.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== unpaid Orders and old functions (database)"; out=$(node tests/attack-order-leftovers.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== accepting an Order (database)"; out=$(node tests/attack-accept.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== kept Orders and the Table Editor (database)"; out=$(node tests/attack-kept-orders.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== what an Order is linked to (database)"; out=$(node tests/attack-order-links.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== nothing new with a deleted person (database)"; out=$(node tests/attack-deleted-person.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== who reads bank details (database)"; out=$(node tests/attack-payout-info.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== milestones while the Order is open (database)"; out=$(node tests/attack-milestone-dispute.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== chats with a deleted person (database)"; out=$(node tests/attack-deleted-chat.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== emptying whole tables (database)"; out=$(node tests/attack-truncate.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== deleting a profile by hand (database)"; out=$(node tests/attack-profile-delete.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== 200 portfolio files (database)"; out=$(node tests/attack-portfolio-limit.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== old agreed texts (database)"; out=$(node tests/attack-old-agreed-text.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== chargeback flags (database)"; out=$(node tests/attack-chargeback-flag.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== payout fee line";  out=$(node tests/attack-connect-fee.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== Stripe switches during a payment (database)"; out=$(node tests/attack-stripe-switch.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== Supabase's Delete user (database)"; out=$(node tests/attack-dashboard-delete.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== card-fee floor (database)"; out=$(node tests/attack-fee-floor.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== address settings";  out=$(node tests/attack-settings.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== refusals in the person's language"; out=$(node tests/attack-error-codes.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== Order notes kept until handled"; out=$(node tests/attack-order-notes.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== marking an Order note as handled (database)"; out=$(node tests/attack-note-handled.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== late payments"; out=$(node tests/attack-late-payments.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== the bank asks about an Order's payment (inquiries)"; out=$(node tests/attack-inquiries.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== the new prices (database)"; out=$(node tests/attack-pricing.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== the new prices' ledger checked by the database (tests/ledger-db-check.mjs)"; out=$(node tests/attack-ledger-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== the payment code for the new prices, checked by the real database (every Order of attack-plan2 through v56's rules)"; out=$(node tests/attack-plan2-db.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== release, refunds and disputes against the owner's policy (approval, day 14, disputes at the deadline, chargebacks kept apart, decisions on record, outages, the 30-second limit)"; out=$(node tests/attack-release-policy.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== the admin log (database)"; out=$(node tests/attack-admin-audit.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== funds segregation, prepared and off (money held apart at Stripe, payouts linked to each payment, standalone fees, chargebacks, top-ups, failures)"; out=$(node tests/attack-funds-segregation.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== chat cards after money moved"; out=$(node tests/attack-chat-card.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== limit on tries";   out=$(node tests/attack-rate.mjs 2>/dev/null | tail -1); echo "$out"; echo "$out" | grep -q "^0 vulnerable" || r=1
echo "== limits match";     out=$(node tests/limits-match.mjs | tail -1); echo "$out"; echo "$out" | grep -q " 0 failed" || r=1
echo "== deploy skip rule"; out=$(bash tests/netlify-skip.sh | tail -1); echo "$out"; echo "$out" | grep -q "all .* checks passed" || r=1
echo "== setup deploy steps"; out=$(node tests/setup-deploys.mjs | tail -1); echo "$out"; echo "$out" | grep -q "all .* checks passed" || r=1
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
echo "== the new prices on the page"; page pricing-page.js
echo "== Orders at the new prices on the page (Order screen, admin panel)"; page tests/plan2-page.js
[ $r = 0 ] && echo "ALL CHECKS PASSED" || echo "SOMETHING FAILED"
exit $r
