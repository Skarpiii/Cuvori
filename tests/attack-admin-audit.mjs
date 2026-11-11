// The admin log (schema v56, section 11): every change an admin makes through the site is written by the database itself,
// and nobody can change or delete a line.
//   A1 an admin's changes are written, each with the admin, the time, what and on which row, the values before and after:
//      a ban (profiles), a flag and its removal (user_flags), a site setting (site_settings), an Order's note marked as
//      handled (contracts), a message to someone (messages, conversations)
//   A2 nobody else's changes are written: the client's own dispute, a person's own profile, the payment code
//   A3 nobody can change, delete or empty the log: an admin (from the site), the payment code, not even the database owner
//   A4 who reads it: an admin reads every line; the client reads none; someone signed out can't read it at all
//   A5 the payment code writes Cuvori's decision on a dispute into it (stripe-resolve), and an admin reads it
//   A6 a long text is written cut to 300 characters
//   E1 what Cuvori reviews in a dispute (admin_order_evidence): the agreed text, the work, the history and the two sides'
//      chat, for an admin; the look is in the admin log
//   E2 nobody else reads it: the client, someone signed out; an admin who is on the Order; an Order with nothing to decide
//      (no dispute, no chargeback): the chat stays private
// Every check is rolled back.
// Run: node tests/attack-admin-audit.mjs   (needs the local Postgres of tests/db; it is started here)
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
spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
execFileSync("bash", [path.join(root, "tests/db/load.sh")], { env: { ...process.env, EXTRA, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });
for (const f of ["tests/db/10_harness.sql", "tests/db/20_seed.sql", ...MIGRATE.split(/\s+/).filter(Boolean).map(m => `supabase/${m}`)])
  execFileSync("psql", [...PSQL, "-q", "-f", path.join(root, f)], { env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });

const env = { ...process.env, PGOPTIONS: "-c client_min_messages=warning" };
const run = (sql) => { const r = spawnSync("psql", [...PSQL], { input: sql, encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const U = (n) => `t.u('${n}')`;
const as = (who) => who === "anon" ? "set local role anon; select set_config('request.jwt.claim.sub', '', true);"
  : `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const svc = "set local role service_role; select set_config('request.jwt.claim.sub', '', true); select set_config('request.headers', '{\"x-cuvori-pricing\": \"2\"}', true);";
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
const O = "'30000000-0000-0000-0000-000000000003'";            // a paid Order: client 101, freelancer 202
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /ERROR/.test(x)) || r.err).replace(/^.*ERROR:\s*/, "").slice(0, 120)); };
const errOf = (r) => (r.err.split("\n").find(x => /ERROR/.test(x)) || "").replace(/^.*ERROR:\s*/, "");
const tx = (body) => run(`begin;\n${body}\nrollback;\n`);
// the log's lines written in this check, as the owner reads them
const LOG = (label = "log") => `${owner} select '${label}: ' || coalesce(string_agg(concat_ws('|', case when actor = ${U("401")} then 'admin' else coalesce(actor::text, 'nobody') end, action, target_table,
  case when target_id = ${U("501")}::text then '501' when target_id = ${U("101")}::text then '101' when target_id = ${O}::text then 'O' else 'other' end), ';' order by id), 'none') from public.admin_audit where at >= now();`;
const ok = (r) => r.ok && !/error/.test(r.out);

const there = pick(run(`select 'there: ' || (to_regclass('public.admin_audit') is not null);`), "there") === "true";
if (!there) vuln(true, "A0 there is no admin log (public.admin_audit is missing): what an admin changes through the site leaves no record");
else {
  { // A1 an admin's changes are written
    const ban = tx(`${as("401")} select 'r: ' || public.admin_set_ban(${U("501")}, true, 'spam links'); ${LOG()}
      select 'd: ' || (detail -> 'banned' ->> 'from') || '>' || (detail -> 'banned' ->> 'to') from public.admin_audit where at >= now() and target_table = 'profiles';`);
    const flag = tx(`${as("401")} select 'r: ' || public.admin_flag_user(${U("101")}, 'other', 'rude in chat', null); ${owner}
      select set_config('t.flag', (select id::text from public.user_flags where user_id = ${U("101")} and reason = 'rude in chat'), true);
      ${as("401")} select 'r2: ' || public.admin_unflag(current_setting('t.flag')::uuid); ${LOG()}`);
    const setting = tx(`${as("401")} select 'r: ' || public.admin_set_setting('review_window_days', '21'::jsonb); ${LOG()}`);
    const note = tx(`update public.contracts set money_error = 'top-up pi_3Audit1 may not be recorded — check by hand' where id = ${O};
      ${as("401")} select 'r: ' || public.admin_clear_order_note(${O}, 'top-up pi_3Audit1 may not be recorded — check by hand'); ${LOG()}
      select 'd: ' || coalesce(detail -> 'money_error' ->> 'from', '?') || '>' || coalesce(detail -> 'money_error' ->> 'to', 'null') from public.admin_audit where at >= now() and target_table = 'contracts';`);
    const msg = tx(`${as("401")} select 'r: ' || public.admin_message_user(${U("501")}, 'Please add a profile photo.'); ${LOG()}`);
    const wrote = (r, re) => pick(r, "r") === "ok" && re.test(pick(r, "log"));
    vuln(!wrote(ban, /^admin\|update\|profiles\|501$/) || pick(ban, "d") !== "false>true" || pick(flag, "r2") !== "ok" || !/^admin\|insert\|user_flags\|other;admin\|delete\|user_flags\|other$/.test(pick(flag, "log"))
         || !wrote(setting, /^admin\|insert\|site_settings\|other$|^admin\|update\|site_settings\|other$/) || !wrote(note, /^admin\|update\|contracts\|O$/) || !/check by hand>null/.test(pick(note, "d"))
         || !wrote(msg, /admin\|insert\|messages\|other/),
      `A1 an admin bans someone -> ${pick(ban, "log")} (${pick(ban, "d")}); flags and unflags someone -> ${pick(flag, "log")}; changes a setting -> ${pick(setting, "log")}; marks an Order's note as handled -> ${pick(note, "log")} (${pick(note, "d").slice(-30)}); messages someone -> ${pick(msg, "log")} (must each be written, naming the admin, the row, before and after)`);
  }
  { // A2 nobody else's changes are written
    const dispute = tx(`${as("101")} select 'r: ' || public.order_action(${O}, 'dispute', 'not as agreed', null, null); ${LOG()}`);
    const own = tx(`${as("101")} update public.profiles set first_name = 'Lina' where id = ${U("101")}; select 'r: ok'; ${LOG()}`);
    const code = tx(`${svc} update public.contracts set money_error = 'Money step stopped (settlement): x' where id = ${O}; select 'r: ok'; ${LOG()}`);
    vuln(pick(dispute, "log") !== "none" || pick(own, "log") !== "none" || pick(code, "log") !== "none" || pick(dispute, "r") !== "ok",
      `A2 the client opens a dispute (${pick(dispute, "r")}) -> ${pick(dispute, "log")}; changes their own profile -> ${pick(own, "log")}; the payment code writes a note -> ${pick(code, "log")} (must be none each time)`);
  }
  { // A3 nobody can change, delete or empty the log
    const line = `${as("401")} select public.admin_set_ban(${U("501")}, true, 'spam links'); ${owner}`;
    const admUpd = tx(`${line} ${as("401")} update public.admin_audit set action = 'nothing';`);
    const admDel = tx(`${line} ${as("401")} delete from public.admin_audit;`);
    const svcUpd = tx(`${line} ${svc} update public.admin_audit set action = 'nothing';`);
    const svcDel = tx(`${line} ${svc} delete from public.admin_audit;`);
    const ownUpd = tx(`${line} update public.admin_audit set detail = '{}'::jsonb;`);
    const ownDel = tx(`${line} delete from public.admin_audit;`);
    const ownTrunc = tx(`${line} truncate public.admin_audit;`);
    const refused = [admUpd, admDel, svcUpd, svcDel, ownUpd, ownDel, ownTrunc].map(r => r.ok ? "CHANGED" : /admin_audit_frozen|permission denied/.test(errOf(r)) ? "refused" : errOf(r).slice(0, 40));
    vuln(refused.some(x => x !== "refused"),
      `A3 the log changed or emptied by an admin (update, delete), the payment code (update, delete), the database owner (update, delete, truncate) -> ${refused.join(", ")} (must all be refused)`);
  }
  { // A4 who reads it
    const line = `${as("401")} select public.admin_set_ban(${U("501")}, true, 'spam links'); ${owner}`;
    const adm = tx(`${line} ${as("401")} select 'n: ' || count(*) from public.admin_audit where at >= now();`);
    const cl = tx(`${line} ${as("101")} select 'n: ' || count(*) from public.admin_audit;`);
    const anon = tx(`${line} ${as("anon")} select 'n: ' || count(*) from public.admin_audit;`);
    vuln(pick(adm, "n") !== "1" || pick(cl, "n") !== "0" || anon.ok,
      `A4 the admin reads -> ${pick(adm, "n")} line; the client -> ${pick(cl, "n")}; someone signed out -> ${anon.ok ? "READ " + pick(anon, "n") : errOf(anon).slice(0, 40)} (must be 1, 0, refused)`);
  }
  { // A5 the payment code writes Cuvori's decision
    const r = tx(`select set_config('t.adm', ${U("401")}::text, true); ${svc} insert into public.admin_audit (actor, action, target_table, target_id, detail) values (current_setting('t.adm')::uuid, 'order.decide', 'contracts', ${O}::text, '{"decision":"refund","refund_cents":10000,"note":"Cuvori looked at the chat"}'); ${owner}
      ${as("401")} select 'got: ' || action || '/' || (detail ->> 'decision') || '/' || (detail ->> 'refund_cents') from public.admin_audit where at >= now();`);
    vuln(pick(r, "got") !== "order.decide/refund/10000", `A5 the payment code records Cuvori's decision -> ${pick(r, "got")} (must be order.decide/refund/10000, read by an admin)`);
  }
  { // A6 a long text is cut
    const long = "x".repeat(1000);
    const r = tx(`${as("401")} select public.admin_set_ban(${U("501")}, true, '${long.slice(0, 500)}'); ${owner}
      select 'len: ' || length(detail -> 'ban_reason' ->> 'to') from public.admin_audit where at >= now() and target_table = 'profiles';`);
    vuln(pick(r, "len") !== "301", `A6 a 500-character ban reason -> written as ${pick(r, "len")} characters (must be 300 and "…")`);
  }
  { // E1 / E2 what Cuvori reviews in a dispute
    const evThere = pick(run(`select 'fn: ' || (to_regprocedure('public.admin_order_evidence(uuid)') is not null);`), "fn") === "true";
    if (!evThere) vuln(true, "E1 there is no way for an admin to read what a dispute is about (admin_order_evidence is missing): the agreed text, the work and the two sides' chat, which the dispute clause says Cuvori reviews");
    else {
      const chat = `insert into public.messages (conversation_id, sender, kind, body) values ((select conversation_id from public.contracts where id = ${O}), ${U("101")}, 'text', 'The video is 2 minutes, we agreed on 5.');`;
      const disputed = `${chat} ${as("101")} select public.order_action(${O}, 'dispute', 'not as agreed', null, null); ${owner}`;
      const EV = (who, label = "ev") => `${as(who)} select '${label}: ' || coalesce(public.admin_order_evidence(${O}) ->> 'error', 'read:' || (public.admin_order_evidence(${O}) -> 'messages' @> '[{"body": "The video is 2 minutes, we agreed on 5."}]')::text
        || '/' || (public.admin_order_evidence(${O}) -> 'history' @> '[{"event": "disputed", "by": "client"}]')::text || '/' || (public.admin_order_evidence(${O}) -> 'order' ? 'terms_doc')::text); ${owner}`;
      const adm = tx(`${disputed} ${EV("401")} select 'n: ' || count(*) from public.admin_audit where at >= now() and action = 'order.evidence';`);
      const cl = tx(`${disputed} ${EV("101")}`), anon = tx(`${disputed} ${as("anon")} select 'ev: ' || (public.admin_order_evidence(${O}) ->> 'error');`);
      const quiet = tx(`${chat} ${EV("401")}`);
      const party = tx(`${disputed} update public.contracts set client = ${U("401")} where id = ${O}; ${EV("401")}`);
      vuln(pick(adm, "ev") !== "read:true/true/true" || Number(pick(adm, "n")) < 1,
        `E1 an admin reads a disputed Order's evidence -> ${pick(adm, "ev")} (the chat, the history, the agreed text); in the admin log: ${pick(adm, "n")} (must be read:true/true/true, logged)`);
      vuln(pick(cl, "ev") !== "forbidden" || anon.ok || pick(quiet, "ev") !== "nothing_to_decide" || !["your_order", "error: " + errOf(party).slice(0, 120)].includes(pick(party, "ev")) || pick(party, "ev") !== "your_order",
        `E2 the client -> ${pick(cl, "ev")}; someone signed out -> ${anon.ok ? "READ" : errOf(anon).slice(0, 40)}; an Order nobody disputed -> ${pick(quiet, "ev")}; an admin who is the Order's client -> ${pick(party, "ev")} (must be forbidden, refused, nothing_to_decide, your_order)`);
    }
  }
}
console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
