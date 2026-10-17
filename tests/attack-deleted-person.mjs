// Nothing new starts with a person who deleted their account (schema v41).
// When one of two people deletes their account, an Order they agreed is kept, and so is its chat (v35). The other person
// could then start a new Order in that chat with the deleted person. Nobody can ever accept it, so no money can go into
// it, but it waits for an answer that never comes: the page shows it as waiting for the other person, and while it is
// open no other Order can be started in that chat. A change (amendment) could be proposed to the deleted person too, and
// it would also wait forever.
// Now a new Order or change with a deleted person is refused ("This person can't be contacted right now."), and v41
// closes the Orders started with a deleted person before it, the way v37 closes them at deletion.
// D1–D2 a new Order after the freelancer / the client deleted the account, D3 an amendment, D4 the other ways in,
// D5 two people still here (normal), D6 a new chat, D7 Orders started before v41 and running it. Every check is rolled back.
// Run: node tests/attack-deleted-person.mjs   (needs the local Postgres of tests/db; it is started here)
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
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 881 the client and 882 the freelancer (Stripe account ready) with a finished €100 protected Order in their chat
// (it is kept when either deletes the account); 883 and 884 two people still here, in their own chat
const CV = "'1f000000-0000-0000-0000-000000000001'", CV2 = "'1f000000-0000-0000-0000-000000000002'", DONE = "'3f000000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("881")}, 'tea881@t.com', '{"first_name":"Tea"}'), (${U("882")}, 'udo882@t.com', '{"first_name":"Udo"}'),
    (${U("883")}, 'val883@t.com', '{"first_name":"Val"}'), (${U("884")}, 'wes884@t.com', '{"first_name":"Wes"}');
  update public.profiles set role = 'editor' where id in (${U("882")}, ${U("884")});
  insert into public.payout_details (id, methods, stripe_account_id, stripe_payouts_enabled) values (${U("882")}, '[]', 'acct_1TestUdoAAAAAAA', true), (${U("884")}, '[]', 'acct_1TestWesAAAAAAA', true);
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("881")}, ${U("882")}), (${CV2}, ${U("883")}, ${U("884")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent)
    values (${DONE}, ${CV}, ${U("882")}, ${U("881")}, ${U("882")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '9 days', now() - interval '9 days', now() - interval '1 day', 'pi_del881');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${DONE}, 'fund', 10000, 'pi_del881'), (${DONE}, 'release', 10000, 'tr_del881');
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// a call that may be refused: its answer (or the refusal) is kept, and the checks after it still run
const TRY = (label, sql) => `do $$ begin perform set_config('t.${label}', coalesce((${sql})::text, 'null'), true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const ORDER = (mode = "escrow") => `'${JSON.stringify({ title: "Second film", scope: "One more edit", price_cents: 20000, deadline: "2099-12-01", revisions: 2, rights: "full", mode, language: "en", law: "DE", milestones: [] })}'`;
const NEWEST = (cv) => `(select id from public.contracts where conversation_id = ${cv} order by created_at desc limit 1)`;
const DELETE = (who) => `${as(who)} select 'deleted: ' || public.delete_my_account(); ${owner}`;
const COUNT = `select 'orders: ' || count(*) from public.contracts where conversation_id = ${CV};`;
const said = (s) => s.startsWith("refused: not_available") ? "refused: not available" : s.replace(/^[0-9a-f-]{36}$/, "created");

{ // D1 the freelancer deleted the account; the client starts a new Order in their chat and pays into it
  const r = tx(`${DELETE("882")} ${as("881")} ${TRY("call", `public.order_create(${CV}, ${ORDER()})`)} ${owner} ${COUNT}
                select 'freelancer: ' || coalesce((select p.role || ', profile ' || case when p.deleted_at is not null then 'deleted' else 'here' end || ', Stripe ready ' || d.stripe_payouts_enabled from public.profiles p left join public.payout_details d on d.id = p.id where p.id = ${U("882")}), 'gone');`);
  vuln(pick(r, "deleted") !== "ok" || !pick(r, "call").startsWith("refused: not_available") || pick(r, "orders") !== "1",
    `D1 the freelancer has deleted the account; the client starts a new €200 protected Order in their old chat -> ${said(pick(r, "call"))}; Orders in the chat: ${pick(r, "orders")} (the freelancer: ${pick(r, "freelancer")}) (must be refused: nobody can ever accept it, and it would block the chat)`);
}
{ // D2 the client deleted the account; the freelancer starts one
  const r = tx(`${DELETE("881")} ${as("882")} ${TRY("call", `public.order_create(${CV}, ${ORDER()})`)} ${owner} ${COUNT}`);
  vuln(pick(r, "deleted") !== "ok" || !pick(r, "call").startsWith("refused: not_available") || pick(r, "orders") !== "1",
    `D2 the client has deleted the account; the freelancer sends a new Order in their old chat -> ${said(pick(r, "call"))}; Orders in the chat: ${pick(r, "orders")} (must be refused: nobody can accept it)`);
}
{ // D3 an amendment proposed to a deleted freelancer, on an Order paid outside Cuvori that stays
  const r = tx(`insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, accepted_at, paid_at)
                  values ('3f000000-0000-0000-0000-000000000002', ${CV}, ${U("882")}, ${U("881")}, ${U("882")}, 'Paid outside', 50, 'paid', 'direct', 5000, 5000, now(), now());
                ${DELETE("882")} ${as("881")} ${TRY("call", `public.order_amend('3f000000-0000-0000-0000-000000000002', '{"note":"More footage","price_delta_cents":2000}')`)} ${owner}
                select 'open: ' || count(*) from public.order_amendments where order_id = '3f000000-0000-0000-0000-000000000002' and status = 'proposed';`);
  vuln(pick(r, "deleted") !== "ok" || !pick(r, "call").startsWith("refused: not_available") || pick(r, "open") !== "0",
    `D3 the client proposes €20 more to the deleted freelancer on an Order paid outside Cuvori -> ${said(pick(r, "call"))}; changes waiting for an answer: ${pick(r, "open")} (must be refused: nobody will ever answer it)`);
}
{ // D4 the other ways in: an Order written straight into the table, and an account deleted in Supabase's dashboard
  const r = tx(`${DELETE("882")} do $$ begin insert into public.contracts (conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents)
                  values (${CV}, ${U("882")}, ${U("881")}, ${U("881")}, 'Direct row', 30, 'proposed', 'escrow', 3000); perform set_config('t.call', 'saved', true);
                  exception when others then perform set_config('t.call', 'refused: ' || sqlerrm, true); end $$; select 'call: ' || current_setting('t.call'); ${COUNT}`);
  vuln(!pick(r, "call").startsWith("refused") || pick(r, "orders") !== "1", `D4a an Order with the deleted freelancer written straight into the table -> ${said(pick(r, "call"))}; Orders in the chat: ${pick(r, "orders")} (must be refused too)`);
  const r2 = tx(`delete from auth.users where id = ${U("882")}; ${as("881")} ${TRY("call", `public.order_create(${CV}, ${ORDER("direct")})`)} ${owner} ${COUNT}`);
  vuln(!pick(r2, "call").startsWith("refused: not_available") || pick(r2, "orders") !== "1", `D4b the freelancer was deleted in Supabase's dashboard; the client starts an Order paid outside Cuvori -> ${said(pick(r2, "call"))}; Orders in the chat: ${pick(r2, "orders")} (must be refused)`);
}
{ // D5 two people still here (normal): a new Order and an amendment go through; account deletion works as before
  const r = tx(`${as("883")} ${TRY("call", `public.order_create(${CV2}, ${ORDER("direct")})`)} ${owner}
                ${as("884")} select 'accepted: ' || public.order_action(p_order => ${NEWEST(CV2)}, p_action => 'accept', p_version => 1); ${owner}
                ${as("883")} ${TRY("amend", `public.order_amend(${NEWEST(CV2)}, '{"note":"More footage","price_delta_cents":2000}')`)} ${owner}`);
  vuln(!/^[0-9a-f-]{36}$/.test(pick(r, "call")) || pick(r, "accepted") !== "ok" || !/^[0-9a-f-]{36}$/.test(pick(r, "amend")),
    `D5 two people still here: a new Order, its acceptance and a change -> ${said(pick(r, "call"))}, accepted ${pick(r, "accepted")}, change ${said(pick(r, "amend"))} (normal)`);
  const r2 = tx(`${DELETE("881")} select 'kept: ' || (select status from public.contracts where id = ${DONE});`);
  vuln(pick(r2, "deleted") !== "ok" || pick(r2, "kept") !== "completed", `D5b the client deletes her account -> ${pick(r2, "deleted")}; the finished Order: ${pick(r2, "kept")} (normal: kept)`);
}
{ // D6 a new chat with a deleted person
  const r = tx(`${DELETE("882")} ${as("883")} ${TRY("call", `public.open_conversation(${U("882")})`)} ${owner}`);
  vuln(!pick(r, "call").startsWith("refused"), `D6 someone else opens a new chat with the deleted freelancer -> ${said(pick(r, "call"))} (must be refused)`);
}
{ // D7 Orders started with a deleted person before v41, and running it (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v41.sql");
  if (!fs.existsSync(f)) vuln(true, "D7 supabase/schema_v41.sql is missing, so the live database still lets a new Order start with a deleted person");
  else {
    const r = tx(`${DELETE("882")} alter table public.contracts disable trigger user;
                  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, client_accepted_version, client_accepted_at)
                    values ('3f000000-0000-0000-0000-000000000003', ${CV}, ${U("882")}, ${U("881")}, ${U("881")}, 'Started after', 200, 'proposed', 'escrow', 20000, 1, now());
                  alter table public.contracts enable trigger user;
\\i ${f}
\\i ${f}
                  select 'now: ' || status || coalesce(' (' || (select data->>'reason' from public.order_events e where e.order_id = c.id and e.event = 'cancelled' limit 1) || ')', '') from public.contracts c where id = '3f000000-0000-0000-0000-000000000003';`);
    const rows = r.out.split("\n").filter(l => /^v41 /.test(l));
    vuln(!r.ok || pick(r, "now") !== "cancelled (account_deleted)" || rows.length !== 2 || !/closed now: 1\./.test(rows[0] || "") || !/closed now: 0\./.test(rows[1] || ""),
      `D7 a €200 Order the client started with the freelancer after he deleted the account, before v41; then v41 runs twice -> the Order: ${pick(r, "now")}; ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))} (must be closed, so the chat is free again)`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
