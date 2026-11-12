// Re-check of 9 November, the database (schema v56): regression checks for what the fresh reviewers proved.
// V2 the admin log's rule for a job warning (a pattern on Postgres's call stack) had backslashes: in a session with
//    standard_conforming_strings off, every admin message and every job warning failed, and kept failing in that session.
// V3 the pattern also matched the text of a statement in the call stack, or a function whose name only contains
//    "function admin_job_action(": such a message was logged as a job warning without its words. Only the warn action's own
//    statement and admin_job_action(uuid,text,text) itself, as the second and third lines of the call stack, count now
//    (check of 11 November: a statement over several lines, a function named admin_job_action_note, one in another schema,
//    and an admin_job_action with other arguments were still taken for a job warning, and the check did not notice).
// V4 a real job warning is still one, also called through another function or the way PostgREST calls it.
// Every check is rolled back.
// Run: node tests/attack-recheck-nov9-db.mjs   (needs the local Postgres of tests/db; it is started here). To check a copy
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


const WARNED = "a job warning (its reason is in the moderation log)";

{ // V2 a session with standard_conforming_strings off
  const r = run(`begin; set local standard_conforming_strings = off;
    ${as("401")} select 'msg: ' || public.admin_message_user(${U("202")}, 'WORDS-V2 your payout details are missing'); ${owner}
    select 'text: ' || coalesce(string_agg(detail ->> 'text', ' | '), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("202")}::text;
    rollback;
    begin;
    insert into public.jobs (id, owner, title, description, status) values ('70000000-0000-0000-0000-0000000000c3', ${U("501")}, 'Hochzeit von Cleo TITLE-V2', 'we need an editor', 'open');
    set local standard_conforming_strings = off;
    ${as("401")} select 'warn: ' || public.admin_job_action('70000000-0000-0000-0000-0000000000c3', 'warn', 'Please remove the phone number'); ${owner}
    select 'warned: ' || coalesce(string_agg(detail ->> 'text', ' | '), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("501")}::text;
    select 'title: ' || count(*) from public.admin_audit where detail::text like '%TITLE-V2%';
    rollback;
    begin; ${as("401")} select 'next: ' || public.admin_message_user(${U("202")}, 'WORDS-V2b'); rollback;`);
  vuln(pick(r, "msg") !== "ok" || pick(r, "text") !== "WORDS-V2 your payout details are missing" || pick(r, "warn") !== "ok" || pick(r, "warned") !== WARNED || pick(r, "title") !== "0" || pick(r, "next") !== "ok",
    `V2 standard_conforming_strings off: an admin's message -> ${pick(r, "msg")}, logged as "${pick(r, "text")}"; a job warning -> ${pick(r, "warn")}, logged as "${pick(r, "warned")}", the title ${pick(r, "title")} time(s); the next message in that session -> ${pick(r, "next")} (must be: both work, the message with its words, the warning without the title)`);
}

{ // V3 only the call-stack line naming admin_job_action counts (the functions here are made by the owner for the check)
  const r = tx(`create function public.zz_v3_dynamic(p uuid) returns text language plpgsql security definer set search_path = public as $f$
      declare r text; begin execute 'select public.admin_message_user($1, $2) /* PL/pgSQL function admin_job_action( */' into r using p, 'WORDS-V3 dynamic'; return r; end $f$;
    create function public."zz function admin_job_action("(p uuid) returns text language plpgsql security definer set search_path = public as $f$
      begin return public.admin_message_user(p, 'WORDS-V3 quoted'); end $f$;
    grant execute on function public.zz_v3_dynamic(uuid) to authenticated; grant execute on function public."zz function admin_job_action("(uuid) to authenticated;
    ${as("401")} select 'dyn: ' || public.zz_v3_dynamic(${U("202")}); select 'quoted: ' || public."zz function admin_job_action("(${U("202")}); ${owner}
    select 'text: ' || coalesce(string_agg(detail ->> 'text', ' | ' order by id), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("202")}::text;`);
  vuln(pick(r, "dyn") !== "ok" || pick(r, "quoted") !== "ok" || pick(r, "text") !== "WORDS-V3 dynamic | WORDS-V3 quoted",
    `V3 a message sent through a statement whose text says "PL/pgSQL function admin_job_action(" (${pick(r, "dyn")}) and through a function whose name contains it (${pick(r, "quoted")}): the admin log keeps "${pick(r, "text")}" (must be the words of both)`);
}

{ // V3b statements and functions made to look like the warn action's (made by the owner for the check, rolled back)
  const body = (label) => `declare j record; begin select p as owner, 'Demo' as title into j; perform public.admin_message_user(j.owner, 'About your job "' || left(j.title, 80) || '": ' || 'WORDS-V3b ${label}'); return 'ok'; end`;
  const r = tx(`create function public.zz_v3b_lines(p uuid) returns text language plpgsql security definer set search_path = public as $f$
      declare r text; begin execute 'select public.admin_message_user($1, $2) /*' || chr(10) || 'PL/pgSQL function admin_job_action(uuid,text,text) line 1 at PERFORM' || chr(10) || '*/' into r using p, 'WORDS-V3b lines'; return r; end $f$;
    create function public.admin_job_action_note(p uuid, a text, b text) returns text language plpgsql security definer set search_path = public as $f$ ${body("named like it")} $f$;
    create schema zz_other; create function zz_other.admin_job_action(p uuid, a text, b text) returns text language plpgsql security definer set search_path = public as $f$ ${body("another schema")} $f$;
    create function public.admin_job_action(p uuid) returns text language plpgsql security definer set search_path = public as $f$ ${body("other arguments")} $f$;
    grant usage on schema zz_other to authenticated;
    grant execute on function public.zz_v3b_lines(uuid), public.admin_job_action_note(uuid, text, text), zz_other.admin_job_action(uuid, text, text), public.admin_job_action(uuid) to authenticated;
    ${as("401")} select 'a: ' || public.zz_v3b_lines(${U("202")}); select 'b: ' || public.admin_job_action_note(${U("202")}, 'x', 'y');
    select 'c: ' || zz_other.admin_job_action(${U("202")}, 'x', 'y'); select 'd: ' || public.admin_job_action(${U("202")}); ${owner}
    select 'text: ' || coalesce(string_agg(detail ->> 'text', ' | ' order by id), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("202")}::text;`);
  const want = ['WORDS-V3b lines', 'About your job "Demo": WORDS-V3b named like it', 'About your job "Demo": WORDS-V3b another schema', 'About your job "Demo": WORDS-V3b other arguments'].join(" | ");
  vuln(["a", "b", "c", "d"].some(k => pick(r, k) !== "ok") || pick(r, "text") !== want,
    `V3b messages sent through a statement over two lines whose second line names admin_job_action (${pick(r, "a")}), and with the warn action's own statement from admin_job_action_note (${pick(r, "b")}), from an admin_job_action in another schema (${pick(r, "c")}) and from one with other arguments (${pick(r, "d")}): the admin log keeps "${pick(r, "text")}" (must be the words of all four)`);
}

{ // V4 a real job warning stays one, also through a wrapper and called the way PostgREST does
  const r = tx(`insert into public.jobs (id, owner, title, description, status) values ('70000000-0000-0000-0000-0000000000c4', ${U("501")}, 'Hochzeit TITLE-V4', 'we need an editor', 'open');
    create function public.zz_v4_wrap(j uuid) returns text language sql security definer set search_path = public as $f$ select public.admin_job_action(j, 'warn', 'Wrapped reason') $f$;
    grant execute on function public.zz_v4_wrap(uuid) to authenticated;
    ${as("401")} with pgrst_source as (select public.admin_job_action(p_job := '70000000-0000-0000-0000-0000000000c4', p_action := 'warn', p_reason := 'Please remove the phone number') as r) select 'rest: ' || r from pgrst_source;
    select 'wrap: ' || public.zz_v4_wrap('70000000-0000-0000-0000-0000000000c4'); ${owner}
    select 'warned: ' || coalesce(string_agg(detail ->> 'text', ' | ' order by id), '(none)') from public.admin_audit where action = 'message_user' and target_id = ${U("501")}::text;
    select 'title: ' || count(*) from public.admin_audit where detail::text like '%TITLE-V4%';`);
  vuln(pick(r, "rest") !== "ok" || pick(r, "wrap") !== "ok" || pick(r, "warned") !== WARNED + " | " + WARNED || pick(r, "title") !== "0",
    `V4 a job warning called the way PostgREST does (${pick(r, "rest")}) and through another function (${pick(r, "wrap")}): logged as "${pick(r, "warned")}", the title ${pick(r, "title")} time(s) (must be: two job warnings, no title)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
