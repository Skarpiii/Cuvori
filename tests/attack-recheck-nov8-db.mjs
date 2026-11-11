// Re-check of 8 November, the database and the page (schema v56): regression checks for what the fresh reviewers proved.
// T1 the job "warn" (the only caller of admin_message_user) wrote the client's job title into the admin log, which can never
//    be deleted, also after their account was deleted. Now the log says a job warning went to them (its reason is in the
//    moderation log, as for every job action), never the title.
// T2 a cancel or a decision refused because the Order's books need a check by hand (code under_review): the admin is shown
//    why, the freelancer the words in their language.
// Every check is rolled back.
// Run: node tests/attack-recheck-nov8-db.mjs   (needs the local Postgres of tests/db; it is started here).
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

{ // T1 the job warning keeps no job title in the admin log
  const r = tx(`insert into public.jobs (id, owner, title, description, status) values ('70000000-0000-0000-0000-0000000000c1', ${U("501")}, 'Hochzeit von Cleo Mustermann TITLE-WORDS', 'we need an editor', 'open');
    ${as("401")} select 'warn: ' || public.admin_job_action('70000000-0000-0000-0000-0000000000c1', 'warn', 'Please remove the phone number'); ${owner}
    select 'copies: ' || count(*) from public.admin_audit where detail::text like '%TITLE-WORDS%';
    select 'line: ' || count(*) from public.admin_audit where action = 'message_user' and target_id = ${U("501")}::text;
    select 'reason: ' || count(*) from public.moderation_actions where job_id = '70000000-0000-0000-0000-0000000000c1' and action = 'warn' and reason = 'Please remove the phone number';
    select 'sent: ' || count(*) from public.messages where sender = ${U("401")} and body like 'About your job "Hochzeit von Cleo Mustermann TITLE-WORDS": Please remove the phone number';
    ${as("401")} select 'deleted: ' || public.admin_delete_user(${U("501")}); ${owner}
    select 'after: ' || count(*) from public.admin_audit where detail::text like '%TITLE-WORDS%';`);
  const direct = tx(`${as("401")} select 'r: ' || public.admin_message_user(${U("501")}, 'Your payout details are missing'); ${owner}
    select 'kept: ' || count(*) from public.admin_audit where action = 'message_user' and detail ->> 'text' = 'Your payout details are missing';`);
  vuln(pick(r, "warn") !== "ok" || pick(r, "copies") !== "0" || pick(r, "after") !== "0" || pick(r, "line") !== "1" || pick(r, "reason") !== "1" || pick(r, "sent") !== "1" || pick(direct, "kept") !== "1",
    `T1 a job warning -> ${pick(r, "warn")}: the job title in the admin log ${pick(r, "copies")} time(s), after the poster's account is deleted ${pick(r, "after")}; the log line of the warning ${pick(r, "line")}; its reason in the moderation log ${pick(r, "reason")}; the message sent with the title ${pick(r, "sent")}; an admin's own message written with its words ${pick(direct, "kept")} (must be 0, 0, 1, 1, 1, 1)`);
}

{ // T2 the page: "under review" says why to the admin, and to the freelancer in their language
  const page = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const start = page.indexOf("  function fnPlain(e,pay){"), end = page.indexOf("\n  }\n", start) + 4;
  let f = null;
  try { const src = page.slice(start, end); f = (admin) => new Function("t", "fill", "isAdmin", `${src}; return fnPlain;`)(k => k, s => s, () => admin); } catch {}
  const why = "This Order's books need a check by hand";
  const asAdmin = f ? f(true)({ code: "under_review", reason: why }, false) : null, asFreelancer = f ? f(false)({ code: "under_review", reason: why }, false) : null;
  vuln(!f || asAdmin !== "fn_underReview — Admin: " + why || asFreelancer !== "fn_underReview",
    `T2 the page's words for "under review": the admin -> "${asAdmin}", the freelancer -> "${asFreelancer}" (must be the person's words, and for the admin also why)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
