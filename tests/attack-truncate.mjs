// Emptying a whole table at once (TRUNCATE) (schema v45).
// An Order that was agreed or took money is kept with its payment lines and history: a chargeback months later is
// answered from them (v35). v39 stops deleting such an Order (in the Table Editor or the SQL editor), and the payment
// lines and history refuse to be deleted. TRUNCATE, which empties a whole table in one go (the Table Editor's
// "Truncate table", or the word in the SQL editor), skips all of those checks: one click could wipe every kept Order with
// its payment lines, and "truncate ... cascade" on profiles, chats or job posts empties the Orders too.
// Also, visitors and signed-in people (the anon and authenticated roles) held the right to empty, link to and add
// triggers to the tables, from Supabase's defaults. The site never uses those rights, and the API has no way to use them
// today, so it is only a right nobody should hold.
// Now emptying the Orders, their payment lines or their history is refused while a kept Order exists (the same way out
// as v39: the owner says so on purpose), and those rights are taken from visitors and signed-in people, also for tables
// made later.
// T1–T2 the rights, T3–T5 emptying the kept records, T6 what still works (normal), T7 running v45. Every check is rolled back.
// Run: node tests/attack-truncate.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 8c1 the client and 8c2 the freelancer with a finished €100 protected Order, paid in and paid out (it is kept)
const CV = "'1c400000-0000-0000-0000-000000000001'", DONE = "'3c400000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8c1")}, 'eva8c1@t.com', '{"first_name":"Eva"}'), (${U("8c2")}, 'finn8c2@t.com', '{"first_name":"Finn"}');
  update public.profiles set role = 'editor' where id = ${U("8c2")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8c1")}, ${U("8c2")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent)
    values (${DONE}, ${CV}, ${U("8c2")}, ${U("8c1")}, ${U("8c2")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '9 days', now() - interval '9 days', now() - interval '1 day', 'pi_trunc8c1');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${DONE}, 'fund', 10000, 'pi_trunc8c1'), (${DONE}, 'release', 10000, 'tr_trunc8c1');
  insert into public.order_events (order_id, actor, event, data) values (${DONE}, null, 'completed', '{}');
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// a statement that may be refused: the answer (or the refusal) is kept, and the checks after it still run
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'done', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const KEPT = `select 'kept: ' || (select count(*) from public.contracts where id = ${DONE}) || ' Order, ' || (select count(*) from public.order_payments where order_id = ${DONE}) || ' payment lines, ' || (select count(*) from public.order_events where order_id = ${DONE}) || ' history lines';`;
const ALL_KEPT = "1 Order, 2 payment lines, 1 history lines";
const said = (s) => s.startsWith("refused: ") ? (/kept|answered from them|can't be emptied/.test(s) ? "refused (kept records)" : s) : s;
const RIGHTS = `select 'rights: ' || coalesce(string_agg(distinct c.relname, ', ' order by c.relname), 'none') from pg_class c cross join (values ('anon'), ('authenticated')) r(n)
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')
    and (has_table_privilege(r.n, c.oid, 'TRUNCATE') or has_table_privilege(r.n, c.oid, 'TRIGGER') or has_table_privilege(r.n, c.oid, 'REFERENCES'));`;

{ // T1 the rights visitors and signed-in people hold on the tables today
  const r = tx(RIGHTS);
  const list = pick(r, "rights"), n = list === "none" ? 0 : list.split(", ").length;
  vuln(list !== "none", `T1 tables visitors or signed-in people may empty (TRUNCATE), link to (REFERENCES) or add triggers to (TRIGGER) -> ${n ? `${n}: ${list.split(", ").slice(0, 6).join(", ")}${n > 6 ? ", …" : ""}` : "none"} (must be none: the site never uses these rights)`);
}
{ // T2 a table the owner makes later gets the normal rights, not those
  const r = tx(`create table public.t_later_v45 (id int);
                select 'later: empty ' || has_table_privilege('authenticated', 'public.t_later_v45', 'TRUNCATE') || ', triggers ' || has_table_privilege('authenticated', 'public.t_later_v45', 'TRIGGER')
                  || ', read ' || has_table_privilege('authenticated', 'public.t_later_v45', 'SELECT') || ', write ' || has_table_privilege('authenticated', 'public.t_later_v45', 'INSERT');`);
  vuln(pick(r, "later") !== "empty false, triggers false, read true, write true",
    `T2 a new table made later in the SQL editor: what signed-in people may do with it -> ${pick(r, "later")} (must be: empty false, triggers false; read and write stay, row rules decide those)`);
}
{ // T3 emptying the Orders table
  const got = [];
  for (const [who, sql] of [["the owner", "truncate public.contracts cascade"], ["the payment functions' key", "truncate public.contracts cascade"]]) {
    const r = tx(`${who === "the owner" ? owner : as("service")} ${TRY("call", sql)} ${owner} ${KEPT}`);
    got.push(`${who}: ${said(pick(r, "call"))}, ${pick(r, "kept")}`);
  }
  vuln(!got.every(g => g.includes(`refused (kept records), ${ALL_KEPT}`)),
    `T3 "truncate contracts cascade" (the Table Editor's Truncate table) while a paid Order is kept -> ${got.join("; ")} (must be refused: everything stays)`);
}
{ // T4 emptying the payment lines or the history on their own
  const got = [];
  for (const t of ["order_payments", "order_events"]) {
    const r = tx(`${TRY("call", `truncate public.${t}`)} ${KEPT}`);
    got.push(`${t}: ${said(pick(r, "call"))}, ${pick(r, "kept")}`);
  }
  vuln(!got.every(g => g.includes(`refused (kept records), ${ALL_KEPT}`)),
    `T4 emptying the payment lines, or the Order history, on their own -> ${got.join("; ")} (must be refused: they are never deleted)`);
}
{ // T5 the long way round: emptying people, chats or job posts, which cascades to the Orders
  const got = [];
  for (const t of ["profiles", "conversations", "jobs"]) {
    const r = tx(`${TRY("call", `truncate public.${t} cascade`)} ${KEPT}`);
    got.push(`${t}: ${said(pick(r, "call"))}, ${pick(r, "kept")}`);
  }
  vuln(!got.every(g => g.includes(`refused (kept records), ${ALL_KEPT}`)),
    `T5 "truncate ... cascade" on profiles, chats or job posts, which empties the Orders with them -> ${got.join("; ")} (must be refused)`);
}
{ // T6 what still works (normal): the owner on purpose, a table without Order records, and the site's own use
  const purpose = tx(`select set_config('cuvori.remove_kept_order', 'yes', true); ${TRY("call", "truncate public.contracts cascade")} ${KEPT}`);
  const other = tx(`${TRY("call", "truncate public.rate_events")}`);
  const site = tx(`${as("8c1")} ${TRY("read", "select count(*) from public.profiles")} ${TRY("write", `update public.profiles set first_name = 'Evita' where id = auth.uid()`)} ${owner}
                   select 'name: ' || first_name from public.profiles where id = ${U("8c1")};`);
  vuln(pick(purpose, "call") !== "done" || pick(purpose, "kept") !== "0 Order, 0 payment lines, 0 history lines",
    `T6a the owner empties the Orders on purpose (both lines of v39's way out) -> ${said(pick(purpose, "call"))}, ${pick(purpose, "kept")} (normal: allowed)`);
  vuln(pick(other, "call") !== "done", `T6b the owner empties a table without Order records (the limit on tries) -> ${said(pick(other, "call"))} (normal: allowed)`);
  vuln(pick(site, "read") !== "done" || pick(site, "write") !== "done" || pick(site, "name") !== "Evita",
    `T6c a signed-in person reads profiles and changes her name, as the site does -> read ${pick(site, "read")}, change ${pick(site, "write")}, name now ${pick(site, "name")} (normal)`);
}
{ // T7 running v45 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v45.sql");
  if (!fs.existsSync(f)) vuln(true, "T7 supabase/schema_v45.sql is missing, so the live database still lets one TRUNCATE wipe every kept Order");
  else {
    // the live database before v45: Supabase's default rights, and no guard on emptying
    const BEFORE = `grant truncate, trigger, references on all tables in schema public to anon, authenticated;
                    alter default privileges in schema public grant truncate, trigger, references on tables to anon, authenticated;
                    drop trigger if exists orders_keep_records_truncate on public.contracts; drop trigger if exists orders_keep_records_truncate on public.order_payments;
                    drop trigger if exists orders_keep_records_truncate on public.order_events;`;
    const r = tx(`${BEFORE}
\\i ${f}
\\i ${f}
                  ${RIGHTS} ${TRY("call", "truncate public.contracts cascade")} ${KEPT}`);
    const rows = r.out.split("\n").filter(l => /^v45 /.test(l));
    const n = (rows[0] || "").match(/rights taken from (\d+) tables/);
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v45 applied/.test(l)) || !n || Number(n[1]) < 1 || !/rights taken from 0 tables/.test(rows[1] || "")
         || pick(r, "rights") !== "none" || !said(pick(r, "call")).startsWith("refused (kept records)") || pick(r, "kept") !== ALL_KEPT,
      `T7 running v45 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then rights left: ${pick(r, "rights")}, emptying the Orders: ${said(pick(r, "call"))}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
