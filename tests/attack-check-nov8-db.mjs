// Check of 8 November, the database and the page (schema v56): regression checks for what the re-check of the fixes of 7 November proved.
// E1 the admin log: an admin's own profile (their name) and the flags the site puts on their own job posts (copying the
//    title) kept their words for good; an admin hiding a review about themselves was written as "(text)" instead of
//    "visible -> hidden" and the reason; an admin's message to someone was written as "(text)" (before 7 November, with its
//    words). Now: the admin's own profile and job flags without words; a review's moderation as it is; the admin's message
//    with its words on its own line (the chat line by its length, as every message).
// E2 the evidence: the database took the bank's inquiry anywhere in a note (the page, "Mark as handled" and the payment
//    code: where a note part starts); the page hid the button while an admin's own decision was under way on an Order
//    nobody disputed (the admin's list did not say who decided: it does now).
// E3 the page: the "Mark as handled" window said the bank's inquiry stays, which is true only once v56 has run; the evidence's
//    refusal said "Nobody has disputed this Order" also for a decided dispute; the admin panel showed "€99.9".
// Every check is rolled back.
// Run: node tests/attack-check-nov8-db.mjs   (needs the local Postgres of tests/db; it is started here).
// of the code, copy this file into that copy's tests folder and run it there: the database is built from that copy.
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const PGDIR = process.env.PGDIR || "/tmp/cuvori-pgtest";
const PSQL = ["-h", PGDIR, "-p", "5499", "-U", "postgres", "-d", "cuvori", "-At", "-v", "ON_ERROR_STOP=1"];
// the database as the test runner builds it: the same files, in the same order
const runAll = fs.readFileSync(path.join(root, "tests/run-all.sh"), "utf8");
const EXTRA = (runAll.match(/EXTRA="([^"]+)"/) || [])[1] || "";
const MIGRATE = (runAll.match(/MIGRATE="([^"]+)"/) || [])[1] || "";
const SUPA = path.join(root, "supabase");
spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
execFileSync("bash", [path.join(root, "tests/db/load.sh")], { env: { ...process.env, EXTRA, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });
for (const f of ["tests/db/10_harness.sql", "tests/db/20_seed.sql"].map(x => path.join(root, x)).concat(MIGRATE.split(/\s+/).filter(Boolean).map(m => path.join(SUPA, m)).filter(f => fs.existsSync(f))))
  execFileSync("psql", [...PSQL, "-q", "-f", f], { env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });

const env = { ...process.env, PGOPTIONS: "-c client_min_messages=warning" };
const run = (sql) => { const r = spawnSync("psql", [...PSQL], { input: sql, encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const U = (n) => `t.u('${n}')`;
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
const O = "'30000000-0000-0000-0000-000000000003'";            // a paid Order: client 101, freelancer 202
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /ERROR/.test(x)) || r.err).replace(/^.*ERROR:\s*/, "").slice(0, 120)); };
const tx = (body) => run(`begin;\n${body}\nrollback;\n`);

{ // E1 the admin log
  const profile = tx(`${as("401")} update public.profiles set first_name = 'Ona Petraite-PRIVATE' where id = ${U("401")};
    select 'set: ' || public.admin_set_role(${U("401")}, (select case when role = 'editor' then 'client' else 'editor' end from public.profiles where id = ${U("401")})); ${owner}
    select 'lines: ' || count(*) from public.admin_audit where target_table = 'profiles' and at >= now() and detail ? 'first_name';
    select 'words: ' || count(*) from public.admin_audit where detail::text like '%PRIVATE%';
    select 'role: ' || count(*) from public.admin_audit where target_table = 'profiles' and detail -> 'role' ->> 'to' in ('client', 'editor');`);
  const jobs = tx(`${as("401")} insert into public.jobs (owner, title, description, status) values (${U("401")}, 'Ona''s wedding in Kaunas PRIVATE', 'first', 'open');
    insert into public.jobs (owner, title, description, status) values (${U("401")}, 'Ona''s wedding in Kaunas PRIVATE', 'first', 'open'); ${owner}
    select 'flags: ' || count(*) from public.admin_audit where target_table = 'job_flags' and at >= now();
    select 'words: ' || count(*) from public.admin_audit where detail::text like '%PRIVATE%';`);
  const review = (reviewee, n) => tx(`insert into public.conversations (id, user_a, user_b) values ('10000000-0000-0000-0000-0000000000e${n}', least(${U("203")}, ${U(reviewee)}), greatest(${U("203")}, ${U(reviewee)}));
    insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, description, price, currency, pricing, amount_cents, payment_mode, status, accepted_at, completed_at, closed_at)
    values ('30000000-0000-0000-0000-0000000000e${n}', '10000000-0000-0000-0000-0000000000e${n}', ${U("203")}, ${U(reviewee)}, ${U("203")}, 'Order', 'x', 100, 'EUR', 'project', 10000, 'direct', 'completed', now(), now(), now());
    insert into public.order_reviews (id, order_id, reviewer, reviewee, reviewer_role, rating, comment, low_reason, reveal_due) values
     ('90000000-0000-0000-0000-0000000000e${n}', '30000000-0000-0000-0000-0000000000e${n}', ${U("203")}, ${U(reviewee)}, 'freelancer', 1, 'REVIEW-WORDS rude', 'poor_communication', now() + interval '14 days');
    ${as("401")} select 'hide: ' || public.admin_moderate_review('90000000-0000-0000-0000-0000000000e${n}', 'hidden', 'insulting words'); ${owner}
    select 'line: ' || detail::text from public.admin_audit where target_table = 'order_reviews' and at >= now();
    select 'words: ' || count(*) from public.admin_audit where detail::text like '%REVIEW-WORDS%';`);
  const own = review("401", "1"), other = review("101", "2");
  const msg = tx(`${as("401")} select 'r: ' || public.admin_message_user(${U("501")}, 'Please remove the phone number from your job post'); ${owner}
    select 'said: ' || count(*) from public.admin_audit where action = 'message_user' and detail ->> 'text' = 'Please remove the phone number from your job post' and target_id = ${U("501")}::text;
    select 'chat: ' || coalesce(max(detail ->> 'body'), '-') from public.admin_audit where target_table = 'messages' and at >= now();`);
  const user = tx(`${as("101")} select 'r: ' || coalesce(public.touch_activity()::text, 'done');
    insert into public.messages (conversation_id, sender, kind, body) values ('10000000-0000-0000-0000-000000000003', ${U("101")}, 'text', 'USER-WORDS hello'); ${owner}
    select 'lines: ' || count(*) from public.admin_audit where at >= now();`);
  vuln(pick(profile, "lines") !== "1" || pick(profile, "words") !== "0" || pick(profile, "role") !== "1",
    `E1a the admin changes their own name and role -> log lines ${pick(profile, "lines")}, with the name ${pick(profile, "words")}, with the role ${pick(profile, "role")} (must be 1, 0, 1)`);
  vuln(pick(jobs, "flags") === "0" || pick(jobs, "words") !== "0",
    `E1b the admin posts the same job twice (the site flags it as a duplicate, copying the title) -> flag lines ${pick(jobs, "flags")}, with the title ${pick(jobs, "words")} (must be 1 or more, 0)`);
  const shown = (r) => { const l = pick(r, "line"); return /"moderation_status": \{"to": "hidden", "from": "visible"\}/.test(l) && /insulting words/.test(l); };
  vuln(pick(own, "hide") !== "ok" || !shown(own) || pick(own, "words") !== "0" || !shown(other),
    `E1c an admin hides a review about themselves -> ${pick(own, "hide")}: ${pick(own, "line").slice(0, 160)}; the review's words ${pick(own, "words")}; on someone else's review: ${shown(other)} (must say visible -> hidden and the reason both times, never the review's words)`);
  vuln(pick(msg, "r") !== "ok" || pick(msg, "said") !== "1" || !/^text, \d+ characters$/.test(pick(msg, "chat")),
    `E1d an admin's message to someone -> ${pick(msg, "r")}: its words in the log ${pick(msg, "said")} time(s); its chat line ${pick(msg, "chat")} (must be once, and the chat line by its length)`);
  vuln(pick(user, "lines") !== "0",
    `E1e a user's own use of Cuvori (seen online, a chat message) -> log lines ${pick(user, "lines")} (must be 0: not an admin change)`);
}

{ // E2 the evidence
  const EV = (label) => `${as("401")} select '${label}: ' || coalesce(public.admin_order_evidence(${O}) ->> 'error', 'read'); ${owner}`;
  const r = tx(`update public.contracts set money_error = 'refund made outside Cuvori: see the client''s bank asked about payment pi_9 in the chat' where id = ${O}; ${EV("inside")}
    update public.contracts set money_error = 'top-up pi_8 may not be recorded — check by hand · Also: the client''s bank asked about payment pi_9 (1.00 EUR): no automatic release' where id = ${O}; ${EV("starts")}
    update public.contracts set money_error = null, status = 'resolving', resolution = 'refund', resolved_by = ${U("401")}, resolved_at = now(), disputed_at = null where id = ${O}; ${EV("admin_refund")}
    update public.contracts set resolved_by = editor where id = ${O}; ${EV("own_cancel")}
    update public.contracts set resolved_by = ${U("402")} where id = ${O};
    ${as("401")} select 'listed: ' || coalesce((select (resolved_by = ${U("402")})::text from public.admin_list_contracts() where id = ${O}), 'missing'); ${owner}`);
  vuln(pick(r, "inside") !== "nothing_to_decide" || pick(r, "starts") !== "read" || pick(r, "admin_refund") !== "read" || pick(r, "own_cancel") !== "nothing_to_decide" || pick(r, "listed") !== "true",
    `E2 the evidence: the inquiry's words inside another note -> ${pick(r, "inside")}; an inquiry note part -> ${pick(r, "starts")}; an admin's 'refund' under way, nobody disputed -> ${pick(r, "admin_refund")}; the freelancer's own cancel -> ${pick(r, "own_cancel")}; the admin's list says who decided -> ${pick(r, "listed")} (must be nothing_to_decide, read, read, nothing_to_decide, true)`);
  const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const btn = (page.match(/\$\{([^`]*)\?`<button class="link-btn" data-evidence="1">Evidence<\/button>`/) || [])[1] || "";
  let rule = null; try { rule = new Function("r", `return (${btn});`); } catch {}
  const R = (x) => ({ status: "resolving", resolution: "refund", chargeback_status: null, disputed_at: null, money_error: null, editor: "ed", ...x });
  const cases = rule ? [rule(R({ resolved_by: "adm" })), rule(R({ resolved_by: "ed" })), rule(R({})), rule(R({ status: "completed", resolved_by: "adm" })),
    rule(R({ status: "completed", money_error: "refund made outside Cuvori: see the client's bank asked about payment pi_9" }))].map(Boolean) : [];
  vuln(!rule || cases.join() !== "true,false,false,false,false",
    `E2b the page's Evidence button: an admin's 'refund' under way nobody disputed, the freelancer's own cancel, one from a list without who decided (before v56), the same decided, the inquiry's words inside another note -> ${rule ? cases.join(", ") : "rule not found"} (must be true, false, false, false, false)`);
}

{ // E3 the page's words and amounts
  const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const modal = (page.match(/openModal\("Mark as handled", `<p class="muted">([^<]*)<\/p>/) || [])[1] || "";
  vuln(!/v56/.test(modal) || !/before that, the whole note goes/.test(modal),
    `E3a the "Mark as handled" window: "${modal.slice(0, 160)}" (must say the bank's inquiry stays only once v56 has run, and that before it the whole note goes)`);
  const said = (page.match(/nothing_to_decide:"([^"]*)"/) || [])[1] || "";
  vuln(/^Nobody has disputed/.test(said) || !said,
    `E3b the evidence's refusal: "${said}" (must not say nobody disputed: a decided dispute gets it too)`);
  const lineOf = (re) => page.split("\n").find(l => re.test(l)) || "";
  let money = null; try { money = new Function("escapeHtml", lineOf(/^\s*function money\(n,cur\)/) + "\nreturn money;")(x => x); } catch {}
  const got = money ? [money(99.9), money(100), money(0.05), money(1234.5), money(12.5, "USD")] : [];
  vuln(!money || got.join("|") !== "€99.90|€100|€0.05|€1,234.50|USD 12.50",
    `E3c the admin panel's amounts: 99.9, 100, 0.05, 1234.5, USD 12.5 -> ${got.join(", ") || "not found"} (must be €99.90, €100, €0.05, €1,234.50, USD 12.50)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
