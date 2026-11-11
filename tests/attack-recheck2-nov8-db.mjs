// Second re-check of 8 November, the database (schema v56): regression checks for what the fresh reviewers proved.
// V1 the admin log took any admin message sent after a job action in the same database transaction for a job warning (the
//    marker of a job action lasts until the transaction ends), and kept "a job warning" instead of the message's words.
//    Now only the warning sent by the job "warn" action itself is written that way; every other message keeps its words.
// Every check is rolled back.
// Run: node tests/attack-recheck2-nov8-db.mjs   (needs the local Postgres of tests/db; it is started here). To check a copy
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

const J1 = "'60000000-0000-0000-0000-000000000001'", J3 = "'60000000-0000-0000-0000-000000000003'";   // seeded job posts
const WARNED = "a job warning (its reason is in the moderation log)";

{ // V1 a message sent after a job action in the same transaction keeps its words
  const cases = [
    ["after a job approved", `select 'step: ' || public.admin_job_action(${J1}, 'approve', '');`],
    ["after a job hidden", `select 'step: ' || public.admin_job_action(${J1}, 'hide', 'spam');`],
    ["after a job reported", `select 'step: ' || public.report_job(${J3}, 'spam', '');`],
  ];
  for (const [what, step] of cases) {
    const r = tx(`${as("401")} ${step} select 'msg: ' || public.admin_message_user(${U("202")}, 'WORDS-V1 your payout details are missing'); ${owner}
      select 'text: ' || coalesce(string_agg(detail ->> 'text', ' | '), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("202")}::text;`);
    vuln(pick(r, "step") !== "ok" || pick(r, "msg") !== "ok" || pick(r, "text") !== "WORDS-V1 your payout details are missing",
      `V1 an admin's message ${what} in the same transaction (${pick(r, "step")}, ${pick(r, "msg")}): the admin log keeps "${pick(r, "text")}" (must be its words)`);
  }
  // a job warning, then a message of the admin's own in the same transaction: the warning without its words, the message with
  const w = tx(`insert into public.jobs (id, owner, title, description, status) values ('70000000-0000-0000-0000-0000000000c2', ${U("501")}, 'Hochzeit von Cleo TITLE-V1', 'we need an editor', 'open');
    ${as("401")} select 'warn: ' || public.admin_job_action('70000000-0000-0000-0000-0000000000c2', 'warn', 'Please remove the phone number');
    select 'msg: ' || public.admin_message_user(${U("202")}, 'WORDS-V1b see you'); ${owner}
    select 'warned: ' || coalesce(string_agg(detail ->> 'text', ' | '), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("501")}::text;
    select 'other: ' || coalesce(string_agg(detail ->> 'text', ' | '), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("202")}::text;
    select 'title: ' || count(*) from public.admin_audit where detail::text like '%TITLE-V1%';`);
  vuln(pick(w, "warn") !== "ok" || pick(w, "msg") !== "ok" || pick(w, "warned") !== WARNED || pick(w, "other") !== "WORDS-V1b see you" || pick(w, "title") !== "0",
    `V1 a job warning, then an admin's message in the same transaction (${pick(w, "warn")}, ${pick(w, "msg")}): the warning is logged as "${pick(w, "warned")}", the message as "${pick(w, "other")}"; the job title in the log ${pick(w, "title")} time(s) (must be: "${WARNED}", the message's words, no title)`);
  // a message of the admin's own that looks like a warning keeps its words (only the "warn" action's own message is a warning)
  const like = tx(`${as("401")} select 'msg: ' || public.admin_message_user(${U("202")}, 'About your job "Demo job": WORDS-V1c'); ${owner}
    select 'text: ' || coalesce(string_agg(detail ->> 'text', ' | '), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("202")}::text;`);
  vuln(pick(like, "msg") !== "ok" || pick(like, "text") !== 'About your job "Demo job": WORDS-V1c',
    `V1 an admin's own message worded like a job warning (${pick(like, "msg")}): the admin log keeps "${pick(like, "text")}" (must be its words)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
