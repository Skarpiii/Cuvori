// A person removed by deleting their profile row by hand (schema v46).
// Deleting an account properly (the person on Settings, an admin on the admin page, or Authentication -> Users -> Delete
// user in Supabase) goes through purge_user_data(): the sign-in goes too, kept Orders stay (v35), and for someone who was
// banned or flagged, their e-mail, bank and card details are copied to the list a new account is checked against.
// Deleting the row in public.profiles by hand (the Table Editor's Delete row, or SQL) skipped all of that for someone with
// no kept Orders (v39 already refuses it when they have one): the sign-in stayed, so the person could still sign in to a
// broken account, and a banned person's details were wiped instead of kept, so a later sign-up with them was no longer
// caught.
// Now a profile row can only go through the proper deletion; by hand it is refused, with the way to do it. Emptying the
// whole table (TRUNCATE) is refused the same way. An empty row left for a kept Order, after its Orders went on purpose, can
// still be removed.
// P1 a banned person's row deleted by hand, P2 the other ways in, P3 the proper ways (normal), P4 what is left after a
// proper deletion, P5 running v46. Every check is rolled back.
// Run: node tests/attack-profile-delete.mjs   (needs the local Postgres of tests/db; it is started here)
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
const as = (who) => who === "service" ? "set local role service_role; select set_config('request.jwt.claim.sub', '', true);"
  : `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 8d1 a banned person with no Orders, 8d2 an ordinary person with no Orders; 8d3 and 8d4 with a finished, paid Order (kept)
const CV = "'1d500000-0000-0000-0000-000000000001'", DONE = "'3d500000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8d1")}, 'gus8d1@t.com', '{"first_name":"Gus"}'), (${U("8d2")}, 'hal8d2@t.com', '{"first_name":"Hal"}'),
    (${U("8d3")}, 'ivy8d3@t.com', '{"first_name":"Ivy"}'), (${U("8d4")}, 'jon8d4@t.com', '{"first_name":"Jon"}');
  update public.profiles set banned = true, ban_reason = 'scam' where id = ${U("8d1")};
  update public.profiles set role = 'editor' where id = ${U("8d4")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8d3")}, ${U("8d4")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent)
    values (${DONE}, ${CV}, ${U("8d4")}, ${U("8d3")}, ${U("8d4")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '9 days', now() - interval '9 days', now() - interval '1 day', 'pi_prof8d3');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${DONE}, 'fund', 10000, 'pi_prof8d3'), (${DONE}, 'release', 10000, 'tr_prof8d3');
  create temp table t_ids on commit drop as select user_id, value_hash from public.user_identifiers where user_id in (${U("8d1")}, ${U("8d2")}, ${U("8d3")}, ${U("8d4")});
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// a statement that may be refused: the answer (or the refusal) is kept, and the checks after it still run
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'done', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const said = (s) => s.startsWith("refused: ") ? (/Authentication -> Users -> Delete user/.test(s) ? "refused (use the proper deletion)" : s) : s;
// what is left of a person: their sign-in, their profile, and (for a banned person) their details on the list new accounts are checked against
const LEFT = (who) => `select '${who}: ' || 'sign-in ' || case when exists (select 1 from auth.users where id = ${U(who)}) then 'there' else 'gone' end
  || ', profile ' || coalesce((select case when deleted_at is null then 'there' else 'emptied' end from public.profiles where id = ${U(who)}), 'gone')
  || ', on the banned list ' || (select count(*) from public.deleted_user_identifiers d where d.value_hash in (select value_hash from t_ids where user_id = ${U(who)}));`;

{ // P1 a banned person's profile row deleted by hand (the Table Editor's Delete row)
  const r = tx(`${TRY("call", `delete from public.profiles where id = t.u('8d1')`)} ${LEFT("8d1")}`);
  vuln(!said(pick(r, "call")).startsWith("refused (use the proper deletion)") || pick(r, "8d1") !== "sign-in there, profile there, on the banned list 0",
    `P1 the owner deletes a banned person's row in public.profiles by hand -> ${said(pick(r, "call"))}; then: ${pick(r, "8d1")} (must be refused: done this way the sign-in stays, and the ban details are wiped instead of kept)`);
}
{ // P2 the other ways in: an ordinary person, the payment functions' key, and emptying the whole table
  const plain = tx(`${TRY("call", `delete from public.profiles where id = t.u('8d2')`)} ${LEFT("8d2")}`);
  const svc = tx(`select set_config('t.who', ${U("8d2")}::text, true); ${as("service")} ${TRY("call", `delete from public.profiles where id = current_setting('t.who')::uuid`)} ${owner} ${LEFT("8d2")}`);
  const all = tx(`select set_config('cuvori.remove_kept_order', 'yes', true); ${TRY("call", "truncate public.profiles cascade")} select 'people: ' || count(*) from public.profiles;`);
  vuln(!said(pick(plain, "call")).startsWith("refused (use the proper deletion)") || !pick(plain, "8d2").startsWith("sign-in there, profile there"),
    `P2a an ordinary person's row deleted by hand -> ${said(pick(plain, "call"))}; then: ${pick(plain, "8d2")} (must be refused: the sign-in would stay)`);
  vuln(!said(pick(svc, "call")).startsWith("refused (use the proper deletion)") || !pick(svc, "8d2").startsWith("sign-in there, profile there"),
    `P2b the same with the payment functions' key -> ${said(pick(svc, "call"))}; then: ${pick(svc, "8d2")} (must be refused)`);
  vuln(!said(pick(all, "call")).startsWith("refused (use the proper deletion)") || pick(all, "people") === "0",
    `P2c "truncate profiles cascade" (even with v39's way out for kept Orders said) -> ${said(pick(all, "call"))}; people left: ${pick(all, "people")} (must be refused)`);
}
{ // P3 the proper ways (normal): Supabase's Delete user, the person on Settings, an admin on the admin page
  const dash = tx(`delete from auth.users where id = ${U("8d1")}; ${LEFT("8d1")} select 'listed: ' || count(*) from public.deleted_user_identifiers d where d.value_hash in (select value_hash from t_ids where user_id = t.u('8d1'));`);
  const self = tx(`${as("8d2")} select 'answer: ' || public.delete_my_account(); ${owner} ${LEFT("8d2")}`);
  const admin = tx(`${as("401")} select 'answer: ' || public.admin_delete_user(${U("8d2")}); ${owner} ${LEFT("8d2")}`);
  const kept = tx(`delete from auth.users where id = ${U("8d4")}; ${LEFT("8d4")} select 'order: ' || (select status from public.contracts where id = ${DONE});`);
  vuln(!pick(dash, "8d1").startsWith("sign-in gone, profile gone") || !(Number(pick(dash, "listed")) >= 1),
    `P3a Authentication -> Users -> Delete user for the banned person -> ${pick(dash, "8d1")}; ban details kept on the list: ${pick(dash, "listed")} (normal: everything goes, the ban details stay)`);
  vuln(pick(self, "answer") !== "ok" || pick(self, "8d2") !== "sign-in gone, profile gone, on the banned list 0" || pick(admin, "answer") !== "ok" || pick(admin, "8d2") !== "sign-in gone, profile gone, on the banned list 0",
    `P3b the person deletes their own account; an admin deletes it -> ${pick(self, "answer")} (${pick(self, "8d2")}); ${pick(admin, "answer")} (${pick(admin, "8d2")}) (normal)`);
  vuln(pick(kept, "8d4") !== "sign-in gone, profile emptied, on the banned list 0" || pick(kept, "order") !== "completed",
    `P3c the freelancer of a kept Order is deleted in Supabase -> ${pick(kept, "8d4")}; the Order: ${pick(kept, "order")} (normal: an empty row stays for the Order)`);
}
{ // P4 what is left after a proper deletion: the empty row of a kept Order, once its Orders went on purpose; a profile whose
  // sign-in is already gone, through the way the refusal points to
  const left = tx(`delete from auth.users where id = ${U("8d4")};
                   select set_config('cuvori.remove_kept_order', 'yes', true); delete from public.contracts where id = ${DONE}; select set_config('cuvori.remove_kept_order', '', true);
                   ${TRY("call", `delete from public.profiles where id = t.u('8d4')`)} ${LEFT("8d4")}`);
  const orphan = tx(`alter table auth.users disable trigger on_auth_user_deleted; delete from auth.users where id = ${U("8d1")}; alter table auth.users enable trigger on_auth_user_deleted;
                     ${TRY("call", `select public.purge_user_data(t.u('8d1'))`)} ${LEFT("8d1")} select 'listed: ' || count(*) from public.deleted_user_identifiers d where d.value_hash in (select value_hash from t_ids where user_id = t.u('8d1'));`);
  vuln(pick(left, "call") !== "done" || pick(left, "8d4") !== "sign-in gone, profile gone, on the banned list 0",
    `P4a the empty row left for a kept Order, after the owner removed that Order on purpose, deleted by hand -> ${said(pick(left, "call"))}; ${pick(left, "8d4")} (normal: the person was already deleted properly)`);
  vuln(pick(orphan, "call") !== "done" || !pick(orphan, "8d1").startsWith("sign-in gone, profile gone") || !(Number(pick(orphan, "listed")) >= 1),
    `P4b a banned person's sign-in is already gone, the profile left: the owner runs purge_user_data, as the refusal says -> ${said(pick(orphan, "call"))}; ${pick(orphan, "8d1")}; ban details kept: ${pick(orphan, "listed")} (normal)`);
}
{ // P5 running v46 (twice: the SQL editor may be run again), with an account a profile was already deleted from by hand
  const f = path.join(root, "supabase/schema_v46.sql");
  if (!fs.existsSync(f)) vuln(true, "P5 supabase/schema_v46.sql is missing, so the live database still lets a profile row be deleted by hand");
  else {
    const r = tx(`alter table public.profiles disable trigger user; delete from public.profiles where id = ${U("8d2")}; alter table public.profiles enable trigger user;
\\i ${f}
\\i ${f}
                  ${TRY("call", `delete from public.profiles where id = t.u('8d1')`)}`);
    const rows = r.out.split("\n").filter(l => /^v46 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v46 applied/.test(l)) || !rows.every(l => /Sign-ins left without a profile: 1\b/.test(l)) || !said(pick(r, "call")).startsWith("refused (use the proper deletion)"),
      `P5 running v46 twice, with one sign-in whose profile was deleted by hand before -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then a delete by hand: ${said(pick(r, "call"))}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
