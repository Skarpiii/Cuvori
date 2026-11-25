// SETUP.md, the steps that change a value in Netlify (a Stripe key, a webhook secret, the Supabase key): the payment
// functions only get a new value when they are built again, and the page and Stripe's payment notices run on `main`, a
// branch deploy. So every such step must point to the one how-to that rebuilds `main` (Part 3, item 8), and that how-to
// must name Netlify's buttons exactly. "Trigger deploy" builds the production branch only. The deploy rule
// (tools/netlify-skip-build.sh) builds every upload since the check of 19 November (a skip had left the webhook fix of
// 18 November unbuilt), so item 7 says so and says how to see that an upload was built. The hourly job runs on production, which keeps the keys
// it was built with: going live and moving to another Stripe account must update production too (section 4).
// Run: node tests/setup-deploys.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // the copy under test (TARGET), else this one
const text = fs.readFileSync(path.join(root, "SETUP.md"), "utf8");
let n = 0, failed = 0;
const check = (ok, what) => { n++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${what}`); };

// SETUP.md in its paragraphs: a numbered step with its indented lines, or a plain paragraph
const paras = [];
for (const line of text.split("\n")) {
  if (/^\s*$/.test(line) || /^#/.test(line)) { paras.push(""); continue; }
  if (/^\d+\.\s/.test(line) || !paras.length || paras[paras.length - 1] === "") paras.push(line);
  else paras[paras.length - 1] += "\n" + line;
}
const steps = paras.filter(Boolean);
const POINTER = "Part 3, item 8";

// 1. the how-to exists, with Netlify's exact labels (as they read in October 2026)
const howto = steps.find(p => /^8\.\s/.test(p) && /rebuild `main`/.test(p) && /Environment variables/.test(p));
check(!!howto, "SETUP.md has the how-to for a changed value in Netlify (Part 3, item 8)");
const h = howto || "";
for (const label of ["**Deploys**", "**Search by branch name or deploy ID**", "**Branch Deploy: main@", "**Options**", "**Retry without cache with latest branch commit**", "**Completed**", "**Canceled**", "**Branch deploys**", "**Production**", "**Published**"])
  check(h.includes(label), `the how-to names ${label.replace(/\*/g, "")}`);
check(/\*\*Trigger deploy\*\*[^.]*production/.test(h), "the how-to says Trigger deploy builds production only");
check(!/Retry with latest branch commit\*\*[^.]*cancel/i.test(h), "the how-to no longer says a plain retry is cancelled (every upload is built since the check of 19 November)");
check(/\*\*Publish deploy\*\*/.test(h), "the how-to names the Publish deploy button next to Options");
check(new RegExp(`main--cuvori\\.netlify\\.app/\\.netlify/functions/stripe-status`).test(h), "the how-to says how to check the result (stripe-status on the main address)");

// 2. every step that changes a value in Netlify points to it, and none sends you to Trigger deploy or "deploy" alone
const changes = steps.filter(p => p !== howto && /(Environment variables|(keys?|secrets?)\b[^.]{0,80}\b(in|into) Netlify|in Netlify as)/i.test(p));
check(changes.length >= 7, `the steps that change a value in Netlify were found (${changes.length}, at least 7: Part 5 steps 6, 9 and 10, Part 15 items 2, 3 and 5, the note in Part 18)`);
for (const p of changes) {
  const name = p.replace(/\s+/g, " ").replace(/\*\*/g, "").slice(0, 70);
  check(p.includes(POINTER), `points to ${POINTER}: "${name}…"`);
  check(!/Trigger deploy|trigger a deploy|Trigger a deploy|deploy again|one more deploy|in Netlify and deploy|and publish it/.test(p), `does not send you to "Trigger deploy" or a bare "deploy": "${name}…"`);
}

// 3. what the how-to says about the deploy rule is what the rule does (the real script, in a throwaway repository)
const T = fs.mkdtempSync(path.join(os.tmpdir(), "setup-deploys-"));
const git = (...a) => execFileSync("git", ["-C", T, ...a], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const commit = (file) => { fs.mkdirSync(path.dirname(path.join(T, file)), { recursive: true }); fs.appendFileSync(path.join(T, file), Math.random() + "\n"); git("add", "-A"); git("commit", "-q", "-m", "x"); return git("rev-parse", "HEAD"); };
git("init", "-q"); git("config", "user.email", "t@t"); git("config", "user.name", "t");
const built = commit("netlify/lib/cuvori.mjs");                        // the last build of main
const notes = commit("SETUP.md");                                       // since then only a note was uploaded
const rule = (base, head) => spawnSync("bash", [path.join(root, "tools/netlify-skip-build.sh")], { cwd: T, env: { ...process.env, CONTEXT: "branch-deploy", CACHED_COMMIT_REF: base, COMMIT_REF: head } }).status;
check(rule(built, notes) === 1, "a retry after a notes-only upload builds (every upload is built)");
const fix = commit("netlify/functions/stripe-webhook.mjs"), tests = commit("tests/run-all.sh");   // 18 November: the fix overtaken by a test-only upload
check(rule(fix, tests) === 1, "a test-only upload after a payment-code upload Netlify skipped (it counts it as built) builds");
check(rule(notes, notes) === 1, "a retry without cache (Netlify then gives the same commit twice) always builds");
fs.rmSync(T, { recursive: true, force: true });

// 4. the hourly job runs on production and keeps the keys it was built with: going live and moving to another Stripe account
// must update production too (Part 3, item 7), and for the move before stripe_platform_switch() — otherwise the hourly job,
// still on the old keys, remembers the old account again (every payment on main stays paused) or is paused itself
const PROD = "Part 3, item 7";
const item7 = steps.find(p => /^7\.\s/.test(p) && /production branch/.test(p)) || "";
check(/Every upload to `main` is built/.test(item7) && /\*\*Branch Deploy: main@…\*\* must say \*\*Completed\*\*/.test(item7) && /\*\*Failed\*\* means ask for help/.test(item7),
  "item 7 says every upload to main is built, and how to see that a payment-code upload was (Deploys: Completed; Failed means ask)");
check(/value in Netlify was changed[^]*production gets it only[^]*\*\*Deploy project without cache\*\*/.test(item7), "item 7 says how production gets a changed value (its next production deploy)");
const live = steps.find(p => /^9\.\s+Go live/.test(p)) || "";
check(live.includes(PROD) && /hourly job/.test(live) && /live keys/.test(live.slice(live.indexOf(PROD) - 300, live.indexOf(PROD) + 300)) && live.indexOf(PROD) > live.indexOf("(3)"),
  `going live (Part 5, step 9) updates production with the live keys after (3), pointing to ${PROD}`);
const move = steps.find(p => /^10\.\s+Moving to another Stripe account/.test(p)) || "";
check(move.includes(PROD) && /hourly job/.test(move) && move.indexOf(PROD) < move.indexOf("stripe_platform_switch()"),
  `moving to another Stripe account (Part 5, step 10) updates production before stripe_platform_switch(), pointing to ${PROD}`);

// and before any key changes for the move, nothing may still be owed through the old account: card-fee refunds owed to
// clients can only be sent with the old keys, and in live mode stripe_platform_switch() waits for them — with the new keys
// on both deploys they would never be sent, the switch would refuse for good, and every payment would stay paused
const keysAt = move.indexOf("put the new account's keys");
check(/orders_with_money_on_the_way\(\)/.test(move) && /fee_refund_cents is null/.test(move) && move.indexOf("fee_refund_cents is null") < keysAt && keysAt > 0,
  "moving to another Stripe account: the check that nothing is held and no card-fee refund is owed comes before the new keys");
// Supabase's own Delete user (v52): the dashboard shows only its own words; where the reason is
const v52 = steps.find(p => /\(v52\)/.test(p)) || "";
check(/Database error deleting user/.test(v52) && /Logs → Postgres/.test(v52) && /has_money_held/.test(v52),
  "v52: SETUP says what the dashboard shows when Delete user is refused, and where the reason is (Logs → Postgres, has_money_held)");

// the account move, safe end to end: new payments paused first (the fee table's ANY card row set to payer = platform, which
// pauses every payment), a wait for payment pages still open (up to 90 minutes), enough Netlify credits for the production
// deploy in the middle, what to do with a refund that can never be sent, and the way back if the switch still refuses
// The checks that need no pause come first (the SQL check, the fee row still saving, no unpaid agreed increase), so a
// problem is found while payments still work; the pause comes after them, with a check that it worked, and the SQL check
// is run again after the wait; credits for the move and for undoing it (45); the new account set up before anything moves.
const pauseAt = move.search(/payer[^.]{0,40}\*\*platform/), firstCheck = move.indexOf("orders_with_money_on_the_way()");
check(pauseAt > 0 && firstCheck > 0 && firstCheck < pauseAt && move.indexOf("press **Save** without changing anything") < pauseAt && move.indexOf("press **Save** without changing anything") > 0
      && /price increase[^.]*unpaid[^.]*now/.test(move.slice(0, pauseAt)) && /again[^.]{0,80}both are 0/.test(move.slice(pauseAt)) && /2 hours/.test(move) && /45 credits/.test(move),
  "moving to another Stripe account: the checks come before the pause (the SQL check, Save on the unchanged row, unpaid increases), the SQL check again after the wait, 45 credits");
check(/Payments are paused at the moment/.test(move.slice(pauseAt)) && /stripe · ANY · any · card/.test(move) && /never[^.]{0,30}connect/.test(move),
  "moving to another Stripe account: says how to see that the pause worked, which rows to pause, and never the connect row");
check(/set \*\*payer\*\* back to \*\*client[^.]*try (again )?another/.test(move) && /Don.t refund Orders early/.test(move) && /webhook destinations/.test(move.slice(0, pauseAt)),
  "moving to another Stripe account: a way out while waiting (payer back to client, try another time), no early refunds, the new account set up first");
check(/order_id, provider_ref/.test(move) && /old keys back/.test(move) && /payer[^.]{0,60}back to \*\*client/.test(move),
  "moving to another Stripe account: says how to find a refund that can never be sent, the way back, and to set payer back to client at the end");
// going live: the live Connect webhook secret too (step 3)
check(/\(3\)[^]*STRIPE_CONNECT_WEBHOOK_SECRET[^]*\(4\)/.test(live), "going live (Part 5, step 9) puts the live Connect webhook's signing secret in STRIPE_CONNECT_WEBHOOK_SECRET in step (3)");
// the list of Netlify settings names SITE_URL, and the short ways of writing an address leave a reminder note
const vars = steps.find(p => /^6\.\s+Netlify → \*\*Project configuration\*\* → \*\*Environment variables\*\* → add:/.test(p)) || "";
check(/`SITE_URL`\s*=\s*`?https:\/\/cuvori\.io/.test(vars) && /reminder/.test(vars), "Part 5, step 6 lists SITE_URL = https://cuvori.io, and says a short address leaves a reminder note");
// which deploy runs the hourly job: Netlify's Deploys page says, not a commit written into these notes long ago
check(!/main@e2120de/.test(howto) && /top of the Deploys page|top of the \*\*Deploys\*\* page/.test(howto), "the how-to sends you to the top of the Deploys page to see which deploy runs the hourly job (no old deploy name)");

// the go-live checklist (Part 15) sends you to Part 5, step 9, all four steps, instead of an older, shorter copy of it
const p15 = steps.find(p => /^5\.\s+\*\*Test in test mode\*\*/.test(p)) || "";
check(/Part 5, step 9/.test(p15) && /all four/.test(p15) && /Part 3, item 7/.test(p15) && !/stripe_set_mode/.test(p15), "the go-live checklist (Part 15, item 5) points to all four steps of Part 5, step 9, production included");
// short addresses only work with today's code: until production has it, write them in full
check(/in full[^.]*until production|until production[^.]*in full/.test(vars), "Part 5, step 6: addresses in full until production has today's code");
// Part 13: the rows the floor leaves alone are named rightly (the payout-fee row is quoted, as its own line)
check(!/Rows the checkout never quotes with/.test(text) && /never decide the card fee/.test(text), "Part 13: the rows the card-fee floor leaves alone are described rightly");

// Production kept back (check of 25 November): its 13 October hourly job clears an Order's whole note when it pays an Order
// or a part out automatically, not only when it finishes a step that had stopped; it lets go (or sends back) a price
// increase paid just before such a payout and not recorded yet, as that code doesn't know the payout-fee line; and it does
// not wait for the bank's inquiry, a note pricing-v2's own hourly run waits for. SETUP.md says all of it where it says what
// that hourly job does not do (Part 3, item 7), in the v55 paragraph, and where pricing-v2 goes live without production.
const kept = steps.find(p => /^7\.\s+\*\*Netlify: two branches, and credits/.test(p)) || "";
check(/pays an Order or a part of it out automatically[^.]*whole note/.test(kept), "Part 3, item 7: production's older hourly job clears the whole note when it pays an Order or a part out automatically");
check(/price increase[^.]*paid[^.]*before[^.]*(let go|sent back)[^.]*payout fee/i.test(kept), "Part 3, item 7: a price increase paid just before production's automatic payout is let go or sent back (that code doesn't know the payout fee)");
check(/does not wait for the bank's (question|inquiry)/.test(kept), "Part 3, item 7: production's older hourly job pays out during the bank's inquiry");
const v55 = steps.find(p => /^7\.\s+Run `supabase\/schema_v5\.sql`/.test(p)) || "";
check(/or pays an Order or a part of it out automatically, it clears the Order's whole note/.test(v55), "the v55 paragraph: production's hourly job also clears the whole note on an automatic payout, not only when it finishes a stopped step");
const goLive = steps.find(p => /^5\.\s+Then put the page of this update live/.test(p));
check(!goLive || /until production has (it|this code)[^.]*(note|notes)[^.]*Part 3, item 7/i.test(goLive), "Part 20, step 5: pricing-v2's protections kept in an Order's note don't stop production's older hourly job until production has the code");

// netlify.toml (check of 14 December): no redirect rule from a /.netlify address. Netlify refuses one on every build
// ("path" field must not start with "/.netlify") and ignores it: the rule that stood there from 17 September, to keep the
// payment functions away from the page's catch-all rule, protected nothing and put a warning in every deploy log. The
// function calls reach the functions without it (on cuvori.io stripe-status answered, and Admin panel → Payment costs said
// "Protected payments: ON"). The page's own rules stay, and the comment says why no such rule can be written.
const toml = fs.readFileSync(path.join(root, "netlify.toml"), "utf8");
const tomlRules = toml.split("\n").filter(l => !/^\s*#/.test(l)).join("\n");          // comment lines left out
const froms = [...tomlRules.matchAll(/\bfrom\s*=\s*(["'])(.*?)\1/g)].map(m => m[2]);   // "…" or '…', also in { from = … }
const redirectsFile = fs.existsSync(path.join(root, "_redirects")) ? fs.readFileSync(path.join(root, "_redirects"), "utf8") : "";
const fileFroms = redirectsFile.split("\n").map(l => l.trim().split(/\s+/)[0]).filter(f => f && !f.startsWith("#"));
check(froms.length > 0 && ![...froms, ...fileFroms].some(f => f.startsWith("/.netlify")), `netlify.toml (and _redirects): no redirect rule from a /.netlify address, which Netlify refuses and ignores; rules from: ${JSON.stringify([...froms, ...fileFroms])}`);
check(froms.includes("/") && froms.includes("/*"), "netlify.toml: the page's own rules stay (\"/\" and every other unknown address go to index.html)");
check(/Netlify refuses a redirect rule for a \/\.netlify address/.test(toml) && !/must not be caught by the page redirect/.test(toml), "netlify.toml says why no rule can keep the functions from the page rule (Netlify refuses one), and no longer promises that protection");

// The webhook's seventh event (check of 25 November 2026, the calendar date). pricing-v2 notices a refund that fails at
// Stripe afterwards (the client's card account closed) only through `charge.refund.updated`, and the destination made with
// today's SETUP.md has six events: without the seventh, the Order keeps saying the money went back to the client, who never
// got it, and nobody is told. So the step that puts this update live (Running v56, step 5) says to add it to the
// destination already there; and every event the webhook acts on for Cuvori's own account, on the API version Cuvori uses,
// is named where a destination is made (Part 5 step 4, Part 15 step 3).
{
  const hook = fs.readFileSync(path.join(root, "netlify/functions/stripe-webhook.mjs"), "utf8");
  const listed = /const HANDLED = \[([^\]]*)\]/.exec(hook);
  const handled = listed ? [...listed[1].matchAll(/"([a-z_.]+)"/g)].map(m => m[1]) : [];
  // account.updated comes from the freelancers' accounts (its own destination); refund.updated and refund.failed only on
  // newer API versions than the one Cuvori's destinations keep
  const own = handled.filter(e => !["account.updated", "refund.updated", "refund.failed"].includes(e));
  const goLive = steps.find(s => /^5\. /.test(s) && s.includes("compare/main...")) || "";
  check(own.includes("charge.refund.updated") && goLive.includes("`charge.refund.updated`") && /\*\*Edit destination\*\* → \*\*Select events\*\*/.test(goLive) && /Your account/.test(goLive),
    "Running v56, step 5 (the merge that puts this update live): add `charge.refund.updated` to the Stripe destination already there (Your account → Edit destination → Select events)");
  // the merge itself: from merge-ready (main with pricing-v2 joined into it and tested), as pricing-v2 can no longer be merged
  // into main without conflicts (check of 25 November 2026)
  check(goLive.includes("compare/main...merge-ready") && !goLive.includes("compare/main...pricing-v2") && /can't be merged into `main`/.test(goLive),
    "Running v56, step 5 merges the prepared branch merge-ready (main with pricing-v2 joined and tested), never pricing-v2 itself");
  check(/(no harm|harmless)[^.]*received/.test(goLive), "…and it says that adding it before the merge does no harm (today's code answers an event it does not act on as received)");
  const part5 = steps.find(s => /^4\. Stripe → \*\*Developers\*\*/.test(s)) || "", part15 = steps.find(s => /^3\. \*\*Webhook\*\*/.test(s)) || "";
  check(own.length === 7 && [part5, part15].every(s => own.every(e => s.includes("`" + e + "`")) && /\bseven\b/.test(s)),
    `every event the webhook acts on for Cuvori's own account (${own.length}: ${own.join(", ")}) is named where a destination is made (Part 5 step 4, Part 15 step 3)`);
}

console.log(`\nsetup deploy steps: ${failed ? `${failed} of ${n} checks FAILED` : `all ${n} checks passed`}`);
process.exit(failed ? 1 : 0);
