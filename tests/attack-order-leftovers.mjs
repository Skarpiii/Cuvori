// Orders that could still take money they should not (schema v37).
// 1. One of the two people on an Order deletes their account after both agreed, before the client paid. The Order was kept
//    (v35 keeps agreed Orders) and stayed open: the deleted freelancer's Stripe account and its "ready" mark stay, so the
//    client's page still showed Fund and the payment went through, into an Order nobody would ever deliver. The only way
//    back was a dispute and Cuvori's refund, and the client lost Stripe's card fee. Now a deletion closes the person's
//    agreed Orders that no money went into yet, and v37 closes the ones earlier deletions left open.
// 2. Two old contract functions the page no longer calls were still open to everyone: adjust_contract changed an Order's
//    price without its milestones (the client then paid €20 for €10 of milestones, and once they were released the Order
//    closed with €10 of the client's money left with Cuvori), and propose_contract skipped the newer checks. Now nobody
//    signed in, and no visitor, may call them. The page uses order_create and order_update.
// U1–U4 a deletion closes the agreed, unpaid Order (the person, the other side, the dashboard, an admin), U5 what must stay
// as it was, U6 a deletion that has to wait changes nothing, U7 the old functions, U8 v37 closes the Orders earlier
// deletions left open. Every check is rolled back.
// Run: node tests/attack-order-leftovers.mjs   (needs the local Postgres of tests/db; it is started here)
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
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 831 client, 832 freelancer (Stripe account ready), 833 another freelancer, 834 a third freelancer
const CV = (n) => `'1a000000-0000-0000-0000-00000000000${n}'`, OR = (n) => `'3a000000-0000-0000-0000-00000000000${n}'`;
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("831")}, 'ana831@t.com', '{"first_name":"Ana"}'), (${U("832")}, 'ben832@t.com', '{"first_name":"Ben"}'),
    (${U("833")}, 'cid833@t.com', '{"first_name":"Cid"}'), (${U("834")}, 'dov834@t.com', '{"first_name":"Dov"}');
  update public.profiles set role = 'editor' where id in (${U("832")}, ${U("833")}, ${U("834")});
  insert into public.payout_details (id, methods, stripe_account_id, stripe_payouts_enabled) values (${U("832")}, '[]', 'acct_1TestBenAAAAAAA', true);
  insert into public.conversations (id, user_a, user_b) values (${CV(1)}, ${U("831")}, ${U("832")}), (${CV(2)}, ${U("831")}, ${U("833")}), (${CV(3)}, ${U("831")}, ${U("834")});
  -- the Order both agreed on, not paid yet
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, accepted_at, payment_mode, amount_cents, funded_cents)
    values (${OR(1)}, ${CV(1)}, ${U("832")}, ${U("831")}, ${U("832")}, 'Wedding film', 100, 'accepted', now(), 'escrow', 10000, 0);
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const STATE = (o = 1) => `select 'order: ' || coalesce((select status || case when closed_at is not null then ', closed' else '' end from public.contracts where id = ${OR(o)}), 'gone')
  || ', history: ' || coalesce((select string_agg(event || coalesce(' (' || (data->>'reason') || ')', ''), ', ' order by id) from public.order_events where order_id = ${OR(o)}), 'none');`;
const CLOSED = "cancelled, closed, history: cancelled (account_deleted)";

{ // U1 the freelancer deletes the account
  const r = tx(`${as("832")} select 'answer: ' || public.delete_my_account(); ${owner} ${STATE()}`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "order") !== CLOSED,
    `U1 the freelancer deletes the account while the client has not paid the agreed €100 yet -> ${pick(r, "answer")}; Order ${pick(r, "order")} (must close: nobody can deliver it, so nobody may pay into it)`);
}
{ // U2 the client deletes the account
  const r = tx(`${as("831")} select 'answer: ' || public.delete_my_account(); ${owner} ${STATE()}`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "order") !== CLOSED,
    `U2 the client deletes the account before paying -> ${pick(r, "answer")}; Order ${pick(r, "order")} (must close: the freelancer is not left waiting for a payment that can never come)`);
}
{ // U3 Supabase's dashboard, U4 an admin
  const r = tx(`delete from auth.users where id = ${U("832")}; ${STATE()}`);
  vuln(pick(r, "order") !== CLOSED, `U3 the owner deletes the freelancer in Supabase's dashboard -> Order ${pick(r, "order")} (must close the same way)`);
  const r2 = tx(`${as("401")} select 'answer: ' || public.admin_delete_user(${U("832")}); ${owner} ${STATE()}`);
  vuln(pick(r2, "answer") !== "ok" || pick(r2, "order") !== CLOSED, `U4 an admin deletes the freelancer -> ${pick(r2, "answer")}; Order ${pick(r2, "order")} (must close the same way)`);
}
{ // U5 what must stay as it was
  const r = tx(`insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, accepted_at, completed_at, payment_mode, amount_cents, funded_cents, released_cents)
                  values (${OR(2)}, ${CV(1)}, ${U("832")}, ${U("831")}, ${U("832")}, 'Done', 50, 'completed', now(), now(), 'escrow', 5000, 5000, 5000),
                         (${OR(3)}, ${CV(1)}, ${U("832")}, ${U("831")}, ${U("832")}, 'Paid outside', 70, 'paid', now(), null, 'direct', 7000, 7000, 0),
                         (${OR(4)}, ${CV(2)}, ${U("833")}, ${U("831")}, ${U("833")}, 'Other freelancer', 90, 'accepted', now(), null, 'escrow', 9000, 0, 0);
                insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents)
                  values (${OR(5)}, ${CV(1)}, ${U("832")}, ${U("831")}, ${U("832")}, 'Never agreed', 30, 'proposed', 'escrow', 3000);
                insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${OR(2)}, 'fund', 5000, 'pi_u5done'), (${OR(2)}, 'release', 5000, 'tr_u5done');
                ${as("832")} select 'answer: ' || public.delete_my_account(); ${owner}
                select 'kept: ' || (select status from public.contracts where id = ${OR(2)}) || ' with ' || (select count(*) from public.order_payments where order_id = ${OR(2)}) || ' payment lines, '
                  || (select status from public.contracts where id = ${OR(3)}) || ', ' || (select status from public.contracts where id = ${OR(4)}) || ', never agreed: ' || coalesce((select status from public.contracts where id = ${OR(5)}), 'gone');`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "kept") !== "completed with 2 payment lines, paid, accepted, never agreed: gone",
    `U5 the same deletion leaves the rest as it was -> ${pick(r, "answer")}; ${pick(r, "kept")} (must be: the finished Order completed with its 2 payment lines, the Order paid outside Cuvori still paid, another freelancer's Order still accepted, the Order never agreed gone as before)`);
}
{ // U6 a deletion that has to wait changes nothing
  const r = tx(`insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, accepted_at, payment_mode, amount_cents, funded_cents)
                  values (${OR(6)}, ${CV(3)}, ${U("834")}, ${U("831")}, ${U("834")}, 'Held', 60, 'funded', now(), 'escrow', 6000, 6000);
                ${as("831")} select 'answer: ' || public.delete_my_account(); ${owner} ${STATE()}`);
  vuln(pick(r, "answer") !== "active_payments" || !pick(r, "order").startsWith("accepted"),
    `U6 the client deletes the account while €60 is held for another Order -> ${pick(r, "answer")}; the unpaid Order ${pick(r, "order")} (must answer active_payments and leave it open)`);
}
{ // U7 the old contract functions
  const ms = `insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, has_milestones, terms_version, client_accepted_version)
                values (${OR(7)}, ${CV(2)}, ${U("833")}, ${U("831")}, ${U("831")}, 'Two parts', 10, 'proposed', 'escrow', 1000, true, 1, 1);
              insert into public.order_milestones (order_id, position, title, amount_cents) values (${OR(7)}, 1, 'a', 500), (${OR(7)}, 2, 'b', 500);`;
  const price = `select 'price: €' || (amount_cents / 100) || ', milestones €' || (select sum(amount_cents) / 100 from public.order_milestones where order_id = ${OR(7)}) from public.contracts where id = ${OR(7)};`;
  const r = tx(`${ms} ${as("833")} select 'call: ' || public.adjust_contract(${OR(7)}, 'Two parts', '', 20, 'project', null, 2, 'fixed', 'XX', 'en', '{}'); ${owner} ${price}`);
  vuln(!/permission denied/.test(pick(r, "call")), `U7a the freelancer changes the price of an Order with milestones through the old adjust_contract -> ${pick(r, "call")} (must be refused: it left the milestones at €10 for a €20 price)`);
  const r2 = tx(`${as("831")} select 'call: ' || public.propose_contract(${CV(2)}, 'Old way', '', 30, 'project', null, 2, 'escrow'); ${owner}`);
  vuln(!/permission denied/.test(pick(r2, "call")), `U7b a signed-in person creates an Order through the old propose_contract -> ${pick(r2, "call").replace(/^[0-9a-f-]{36}$/, "created")} (must be refused)`);
  // every version of the two functions, for visitors and signed-in people (a right given to everyone counts too)
  const r4 = run(`select 'rights: ' || coalesce(string_agg(p.proname || ' for ' || r.r, ', '), 'none') from pg_proc p cross join (values ('anon'), ('authenticated')) r(r)
                  where p.pronamespace = 'public'::regnamespace and p.proname in ('adjust_contract', 'propose_contract') and has_function_privilege(r.r, p.oid, 'execute');`);
  vuln(pick(r4, "rights") !== "none", `U7d who may still call the old functions -> ${pick(r4, "rights")} (must be none)`);
  const r3 = tx(`${ms} ${as("833")} select 'call: ' || public.order_update(${OR(7)}, '{"title":"Two parts","price_cents":"2000","mode":"escrow","milestones":[{"title":"a","amount_cents":"1000"},{"title":"b","amount_cents":"1000"}]}'); ${owner} ${price}`);
  vuln(pick(r3, "call") !== "ok" || pick(r3, "price") !== "€20, milestones €20",
    `U7c the page's way, order_update, still changes the price and the milestones together -> ${pick(r3, "call")}; ${pick(r3, "price")} (normal)`);
}
{ // U8 v37 closes the Orders earlier deletions left open
  const f = path.join(root, "supabase/schema_v37.sql");
  if (!fs.existsSync(f)) vuln(true, "U8 supabase/schema_v37.sql is missing, so the Orders earlier deletions left open stay open");
  else {
    // what v35/v36 left: the freelancer's profile emptied and marked deleted, the agreed Order still open
    const r = tx(`update public.profiles set email = null, first_name = null, visibility = 'hidden', deleted_at = now() where id = ${U("832")};
                  delete from auth.users where id = ${U("832")};
                  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, accepted_at, payment_mode, amount_cents, funded_cents)
                    values (${OR(4)}, ${CV(2)}, ${U("833")}, ${U("831")}, ${U("833")}, 'Two people still here', 90, 'accepted', now(), 'escrow', 9000, 0);
                  select 'before: ' || status from public.contracts where id = ${OR(1)};
\\i ${f}
                  ${STATE()} select 'other: ' || status from public.contracts where id = ${OR(4)};`);
    const result = (r.out.split("\n").find(l => /^v37 /.test(l)) || "no result row");
    vuln(pick(r, "before") !== "accepted" || pick(r, "order") !== CLOSED || pick(r, "other") !== "accepted" || !/^v37 applied/.test(result),
      `U8 running v37 over an Order a deletion left open before -> before ${pick(r, "before")}; after ${pick(r, "order")}; an Order between two people still here: ${pick(r, "other")}; result row "${result}"`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
