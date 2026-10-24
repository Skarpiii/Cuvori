// SETUP.md, the steps that change a value in Netlify (a Stripe key, a webhook secret, the Supabase key): the payment
// functions only get a new value when they are built again, and the page and Stripe's payment notices run on `main`, a
// branch deploy. So every such step must point to the one how-to that rebuilds `main` (Part 3, item 8), and that how-to
// must name Netlify's buttons exactly and pick the retry the deploy rule (tools/netlify-skip-build.sh) never cancels.
// "Trigger deploy" builds the production branch only, and a plain "Retry with latest branch commit" is cancelled by the
// deploy rule when only notes or tests changed since the last build. The hourly job runs on production, which keeps the keys
// it was built with: going live and moving to another Stripe account must update production too (section 4).
// Run: node tests/setup-deploys.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
check(/plain \*\*Retry with latest branch commit\*\*[^.]*cancel/i.test(h), "the how-to says why the plain retry is not the one to use");
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
check(rule(built, notes) === 0, "a plain retry after a notes-only upload is cancelled by the deploy rule (so the how-to must not use it)");
check(rule(notes, notes) === 1, "a retry without cache (Netlify then gives the same commit twice) always builds");
fs.rmSync(T, { recursive: true, force: true });

// 4. the hourly job runs on production and keeps the keys it was built with: going live and moving to another Stripe account
// must update production too (Part 3, item 7), and for the move before stripe_platform_switch() — otherwise the hourly job,
// still on the old keys, remembers the old account again (every payment on main stays paused) or is paused itself
const PROD = "Part 3, item 7";
const item7 = steps.find(p => /^7\.\s/.test(p) && /production branch/.test(p)) || "";
check(/value in Netlify was changed[^]*production gets it only[^]*\*\*Deploy project without cache\*\*/.test(item7), "item 7 says how production gets a changed value (its next production deploy)");
const live = steps.find(p => /^9\.\s+Go live/.test(p)) || "";
check(live.includes(PROD) && /hourly job/.test(live) && /live keys/.test(live.slice(live.indexOf(PROD) - 300, live.indexOf(PROD) + 300)) && live.indexOf(PROD) > live.indexOf("(3)"),
  `going live (Part 5, step 9) updates production with the live keys after (3), pointing to ${PROD}`);
const move = steps.find(p => /^10\.\s+Moving to another Stripe account/.test(p)) || "";
check(move.includes(PROD) && /hourly job/.test(move) && move.indexOf(PROD) < move.indexOf("stripe_platform_switch()"),
  `moving to another Stripe account (Part 5, step 10) updates production before stripe_platform_switch(), pointing to ${PROD}`);

console.log(`\nsetup deploy steps: ${failed ? `${failed} of ${n} checks FAILED` : `all ${n} checks passed`}`);
process.exit(failed ? 1 : 0);
