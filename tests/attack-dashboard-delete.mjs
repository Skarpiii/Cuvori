// Supabase's own "Delete user" waits for money still on the way (schema v52).
// The proper ways to remove a person (Settings → delete_my_account, the admin page → admin_delete_user) refuse while
// money is still on the way on one of their Orders (has_money_held, answer "active_payments"): held for work, being paid
// right now, a chargeback the bank is deciding, or a re-payment still owed. Supabase's own dashboard button
// (Authentication → Users → Delete user) deletes the sign-in row straight away; the trigger behind it then purged the
// person's data without that check, so a client or freelancer with EUR 100 held could be removed in the middle of it.
// Now a trigger before that delete refuses it with a message saying what to finish first. The owner can still delete on
// purpose, in one SQL-editor run, with set_config('cuvori.delete_with_money_held', 'yes', true) before the delete.
// D1 the client of a funded Order, D2 the freelancer, D3 a chargeback being decided and a card being charged right now,
// D4 what still works (normal), D5 deleting on purpose, D6 the proper ways are unchanged (normal), D7 running v52.
// Every check is rolled back.
// Run: node tests/attack-dashboard-delete.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 8c61 the client and 8c62 the freelancer of a EUR 100 protected Order that is funded (the money is held for the work);
// 8c63 a client whose only Order is finished
const CV = "'1c610000-0000-0000-0000-000000000001'", O = "'3c610000-0000-0000-0000-000000000001'";
const CV2 = "'1c630000-0000-0000-0000-000000000001'", O2 = "'3c630000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8c61")}, 'rita8c61@t.com', '{"first_name":"Rita"}'), (${U("8c62")}, 'sven8c62@t.com', '{"first_name":"Sven"}'), (${U("8c63")}, 'tom8c63@t.com', '{"first_name":"Tom"}');
  update public.profiles set role = 'editor' where id = ${U("8c62")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8c61")}, ${U("8c62")}), (${CV2}, ${U("8c62")}, ${U("8c63")});   -- user_a < user_b
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, accepted_at, funded_at, stripe_payment_intent, paid_mode)
    values (${O}, ${CV}, ${U("8c62")}, ${U("8c61")}, ${U("8c62")}, 'Brand film', 100, 'funded', 'escrow', 10000, 10000, now() - interval '2 days', now() - interval '1 day', 'pi_dd8c61', 'test');
  insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, fee_refund_cents) values (${O}, 'fund', 10000, 370, 'stripe', 'pi_dd8c61', 'succeeded', 0);
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent, paid_mode)
    values (${O2}, ${CV2}, ${U("8c62")}, ${U("8c63")}, ${U("8c62")}, 'Old film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '30 days', now() - interval '29 days', now() - interval '20 days', 'pi_dd8c63', 'test');
  insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, fee_refund_cents) values (${O2}, 'fund', 10000, 370, 'stripe', 'pi_dd8c63', 'succeeded', 0), (${O2}, 'release', 10000, 0, 'stripe', 'tr_dd8c63', 'succeeded', 0);
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ok';`); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// what Supabase's dashboard does: the sign-in row is deleted, as the database owner, in its own statement
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'deleted', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const DEL = (who, label = "delete") => TRY(label, `delete from auth.users where id = ${U(who)}`);
const STATE = (who, label = "after") => `select '${label}: ' || case when exists (select 1 from auth.users where id = ${U(who)}) then 'sign-in kept' else 'sign-in gone' end
  || ', profile ' || coalesce((select case when deleted_at is null then 'as it was' else 'emptied' end from public.profiles where id = ${U(who)}), 'gone')
  || ', Order ' || coalesce((select status || ' holding ' || (coalesce(funded_cents, 0) - coalesce(released_cents, 0) - coalesce(refunded_cents, 0)) from public.contracts where id = ${O}), 'gone');`;
const short = (s) => s.replace(/\. .*$/, "").slice(0, 120);
const saidMoney = (s) => s.startsWith("refused") && /money/i.test(s);

{ // D1 the client of a funded Order is deleted in Supabase's dashboard
  const r = tx(`${DEL("8c61")} ${STATE("8c61")}`);
  vuln(!saidMoney(pick(r, "delete")) || pick(r, "after") !== "sign-in kept, profile as it was, Order funded holding 10000",
    `D1 the owner clicks Delete user on the client of a EUR 100 Order that is funded -> ${short(pick(r, "delete"))}; afterwards: ${pick(r, "after")} (must be refused, with the money named; nothing changed)`);
}
{ // D2 the freelancer of that Order
  const r = tx(`${DEL("8c62")} ${STATE("8c62")}`);
  vuln(!saidMoney(pick(r, "delete")) || pick(r, "after") !== "sign-in kept, profile as it was, Order funded holding 10000",
    `D2 the same on the freelancer who is owed that EUR 100 -> ${short(pick(r, "delete"))}; afterwards: ${pick(r, "after")} (must be refused)`);
}
{ // D3 money on the way without a held balance: a chargeback the bank is deciding on a finished Order; a card being charged right now
  const cb = tx(`update public.contracts set chargeback_id = 'dp_dd8c63', chargeback_status = 'open', chargeback_cents = 10000 where id = ${O2}; ${DEL("8c63", "chargeback")}
    update public.contracts set chargeback_status = 'lost' where id = ${O2}; ${DEL("8c63", "decided")}`);
  // 8c65: a client whose only Order is agreed and being paid at this very moment
  const O3 = "'3c650000-0000-0000-0000-000000000001'";
  const paying = tx(`insert into auth.users (id, email, raw_user_meta_data) values (${U("8c65")}, 'vera8c65@t.com', '{"first_name":"Vera"}');
    insert into public.conversations (id, user_a, user_b) values ('1c650000-0000-0000-0000-000000000001', ${U("8c62")}, ${U("8c65")});
    insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, accepted_at)
      values (${O3}, '1c650000-0000-0000-0000-000000000001', ${U("8c62")}, ${U("8c65")}, ${U("8c62")}, 'Teaser', 100, 'accepted', 'escrow', 10000, now());
    insert into public.money_keys (scope, key) values ('lock:' || ${O3}::text, 'charging'); ${DEL("8c65", "paying")}
    update public.money_keys set created_at = now() - interval '2 minutes' where scope = 'lock:' || ${O3}::text; ${DEL("8c65", "stale")}`);
  vuln(!saidMoney(pick(cb, "chargeback")) || pick(cb, "decided") !== "deleted",
    `D3a a client whose finished Order has a chargeback the bank is still deciding -> ${short(pick(cb, "chargeback"))}; once the bank decided -> ${pick(cb, "decided")} (must wait, then go through)`);
  vuln(!saidMoney(pick(paying, "paying")) || pick(paying, "stale") !== "deleted",
    `D3b a client whose card is being charged at this very moment (the payment functions hold the Order's lock) -> ${short(pick(paying, "paying"))}; a lock left by a crashed step 2 minutes ago -> ${pick(paying, "stale")} (must wait, then go through)`);
}
{ // D4 what still works: a person with only finished Orders, and one with no Order at all
  const r = tx(`${DEL("8c63")} select 'kept: ' || coalesce((select status || ', ' || (select count(*) from public.order_payments where order_id = ${O2}) || ' payment lines' from public.contracts where id = ${O2}), 'Order gone');
    select 'profile: ' || coalesce((select case when deleted_at is null then 'as it was' else 'emptied' end from public.profiles where id = ${U("8c63")}), 'gone');
    insert into auth.users (id, email, raw_user_meta_data) values (${U("8c64")}, 'uma8c64@t.com', '{"first_name":"Uma"}'); ${DEL("8c64", "nobody")}`);
  vuln(pick(r, "delete") !== "deleted" || pick(r, "kept") !== "completed, 2 payment lines" || pick(r, "profile") !== "emptied" || pick(r, "nobody") !== "deleted",
    `D4 Delete user on a client whose only Order is finished -> ${pick(r, "delete")}; the Order and its payment lines: ${pick(r, "kept")}; the profile: ${pick(r, "profile")}; a person with no Order -> ${pick(r, "nobody")} (normal: deleted, the Order kept as before)`);
}
{ // D5 deleting on purpose, in one SQL-editor run
  const r = tx(`select set_config('cuvori.delete_with_money_held', 'yes', true); ${DEL("8c61")} ${STATE("8c61")}`);
  vuln(pick(r, "delete") !== "deleted" || pick(r, "after") !== "sign-in gone, profile emptied, Order funded holding 10000",
    `D5 the owner deletes on purpose (set_config('cuvori.delete_with_money_held', 'yes', true) in the same run) -> ${pick(r, "delete")}; afterwards: ${pick(r, "after")} (normal: deleted; the Order and its money stay on record)`);
}
{ // D6 the proper ways answer as before
  const r = tx(`${as("8c61")} select 'self: ' || public.delete_my_account(); ${owner} ${as("401")} select 'admin: ' || public.admin_delete_user(${U("8c62")}); ${owner}
    ${as("8c63")} select 'finished: ' || public.delete_my_account(); ${owner}`);
  vuln(pick(r, "self") !== "active_payments" || pick(r, "admin") !== "active_payments" || pick(r, "finished") !== "ok",
    `D6 Settings → delete account by the client -> ${pick(r, "self")}; the admin page on the freelancer -> ${pick(r, "admin")}; the client of the finished Order -> ${pick(r, "finished")} (normal: active_payments, active_payments, ok)`);
}
{ // D7 running v52 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v52.sql");
  if (!fs.existsSync(f)) vuln(true, "D7 supabase/schema_v52.sql is missing, so Supabase's Delete user still removes a person with money on the way");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
      ${DEL("8c61")} ${STATE("8c61")}`);
    const rows = r.out.split("\n").filter(l => /^v52 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v52 applied/.test(l)) || !saidMoney(pick(r, "delete")) || pick(r, "after") !== "sign-in kept, profile as it was, Order funded holding 10000",
      `D7 running v52 twice -> ${r.ok ? rows.map(l => `"${l.slice(0, 80)}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then Delete user on the client -> ${short(pick(r, "delete"))}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
