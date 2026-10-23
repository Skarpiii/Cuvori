// Switching Stripe mode or Stripe account waits for a payment being taken right now (schema v51).
// stripe_set_mode (test <-> live) and stripe_platform_switch (another Stripe account) refuse while an Order still holds
// money (orders_with_money_on_the_way): that money can only move with the keys it came in with. They counted Orders by
// status only, and the moment a card is charged lies before the status changes: the payment step holds a fresh
// "lock:<order>" row in money_keys while it charges the card and then records the payment. A switch in that moment went
// through, the record was then refused (contracts_paid_mode: stripe_mode_changed) and the money went back minus Stripe's
// fee (the client lost the card fee on real money), or, for the account switch, the Order was recorded as funded while its
// money sat on the old Stripe account where the new keys can't reach it. Also, stripe_platform_switch did not wait for the
// card-fee refunds still owed to clients, which stripe_set_mode does: after the switch those refunds fail every hour and
// never arrive (about EUR 1.80 per EUR 100).
// Now both switches count a payment being taken right now as money on the way (the same lock row has_money_held already
// looks at), and the account switch handles waiting card-fee refunds like the mode switch: refused in live mode, closed as
// "nothing refunded" in test mode (test money).
// S1 the mode switch during a payment, S2 the account switch during a payment, S3 the account switch with a card-fee refund
// waiting, S4 what still works (normal), S5 running v51. Every check is rolled back.
// Run: node tests/attack-stripe-switch.mjs   (needs the local Postgres of tests/db; it is started here)
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
const SERVICE = "set local role service_role; select set_config('request.jwt.claim.sub', '', true);";
const owner = "reset role;";
// 8b51 the client and 8b52 the freelancer: an agreed EUR 100 protected Order whose card is being charged right now (the
// payment functions hold lock:<order> while they charge and record it). Every other Order is finished first.
const CV = "'1b510000-0000-0000-0000-000000000001'", O = "'3b510000-0000-0000-0000-000000000001'";
const SETUP = `
  update public.contracts set status = 'completed' where payment_mode = 'escrow' and status in ('funded','delivered','disputed','releasing','resolving');
  update public.order_payments set fee_refund_cents = 0 where fee_refund_cents is null;
  insert into auth.users (id, email, raw_user_meta_data) values (t.u('8b51'), 'pia8b51@t.com', '{"first_name":"Pia"}'), (t.u('8b52'), 'quin8b52@t.com', '{"first_name":"Quin"}');
  update public.profiles set role = 'editor' where id = t.u('8b52');
  insert into public.payout_details (id, methods, stripe_account_id, stripe_payouts_enabled) values (t.u('8b52'), '[]', 'acct_1TestQuinAAAAAAA', true);
  insert into public.conversations (id, user_a, user_b) values (${CV}, t.u('8b51'), t.u('8b52'));
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, accepted_at)
    values (${O}, ${CV}, t.u('8b52'), t.u('8b51'), t.u('8b52'), 'Launch film', 100, 'accepted', 'escrow', 10000, now());
`;
const LOCK = `insert into public.money_keys (scope, key) values ('lock:' || ${O}::text, 'held');`;
const RECORD = `update public.contracts set status = 'funded', funded_cents = 10000, funded_at = now(), paid_mode = public.stripe_mode(), stripe_payment_intent = 'pi_sw8b51' where id = ${O} and status = 'accepted';`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ok';`); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'recorded', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const short = (s) => s.replace(/^not switched: /, "refused: ").replace(/\. .*$/, "").slice(0, 110);

{ // S1 live -> test while a real card is being charged
  const r = tx(`update public.site_settings set value = '"live"' where key = 'stripe_mode'; ${LOCK}
    ${SERVICE} select 'switch: ' || public.stripe_set_mode('test'); ${TRY("record", RECORD)} ${owner}
    select 'order: ' || status || ', ' || coalesce(paid_mode, '-') from public.contracts where id = ${O};`);
  vuln(!pick(r, "switch").startsWith("not switched") || pick(r, "record") !== "recorded" || pick(r, "order") !== "funded, live",
    `S1 the owner switches live -> test while a client's real card is being charged -> ${short(pick(r, "switch"))}; then the payment functions record the payment -> ${pick(r, "record").slice(0, 60)}; the Order: ${pick(r, "order")} (the switch must wait: otherwise the payment is refused and refunded minus the card fee)`);
}
{ // S2 the account switch while a card is being charged
  const r = tx(`${LOCK} ${SERVICE} select 'switch: ' || public.stripe_platform_switch(); ${TRY("record", RECORD)} ${owner}
    select 'order: ' || status || ', freelancer account ' || coalesce((select stripe_account_id from public.payout_details where id = t.u('8b52')), 'gone') from public.contracts where id = ${O};`);
  vuln(!pick(r, "switch").startsWith("not switched") || pick(r, "order") !== "funded, freelancer account acct_1TestQuinAAAAAAA",
    `S2 the owner moves Cuvori to another Stripe account while a card is being charged -> ${short(pick(r, "switch"))}; the Order: ${pick(r, "order")} (must wait: the money would land on the old account, out of reach of the new keys)`);
}
{ // S3 the account switch with a card-fee refund still owed to a client: live mode waits, test mode closes it (test money)
  const line = `insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status) values ('30000000-0000-0000-0000-000000000003', 'fund', 10000, 362, 'stripe', 'pi_feeOwed8b5', 'succeeded');`;
  const live = tx(`update public.site_settings set value = '"live"' where key = 'stripe_mode'; ${line} ${SERVICE} select 'switch: ' || public.stripe_platform_switch(); ${owner}
    select 'refund: ' || coalesce(fee_refund_cents::text, 'still waiting') || ', freelancer account ' || coalesce((select stripe_account_id from public.payout_details where id = t.u('8b52')), 'gone') from public.order_payments where provider_ref = 'pi_feeOwed8b5';`);
  const test = tx(`${line} ${SERVICE} select 'switch: ' || public.stripe_platform_switch(); ${owner}
    select 'refund: ' || coalesce(fee_refund_cents::text, 'still waiting') from public.order_payments where provider_ref = 'pi_feeOwed8b5';`);
  vuln(!pick(live, "switch").startsWith("not switched") || pick(live, "refund") !== "still waiting, freelancer account acct_1TestQuinAAAAAAA",
    `S3a in live mode, a client is still owed a card-fee refund; the owner moves to another Stripe account -> ${short(pick(live, "switch"))}; the refund: ${pick(live, "refund")} (must wait: after the move that refund can never be made)`);
  vuln(!pick(test, "switch").startsWith("switched") || pick(test, "refund") !== "0",
    `S3b the same in test mode -> ${short(pick(test, "switch"))}; the refund line: ${pick(test, "refund")} (normal: test money, closed as "nothing refunded" like the mode switch does)`);
}
{ // S4 what still works: no payment running -> both switches go through; a lock gone stale (a crashed step) no longer counts
  const r = tx(`${SERVICE} select 'mode: ' || public.stripe_set_mode('live'); ${owner} update public.site_settings set value = '"test"' where key = 'stripe_mode';
    insert into public.money_keys (scope, key, created_at) values ('lock:' || ${O}::text, 'stale', now() - interval '2 minutes');
    ${SERVICE} select 'account: ' || public.stripe_platform_switch(); ${owner}`);
  vuln(pick(r, "mode") !== "switched to live mode" || !/^switched: \d+ freelancer/.test(pick(r, "account")),
    `S4 nothing being paid right now (one lock left by a crashed step 2 minutes ago): the mode switch -> ${short(pick(r, "mode"))}; the account switch -> ${short(pick(r, "account"))} (normal: both go through)`);
}
{ // S5 running v51 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v51.sql");
  if (!fs.existsSync(f)) vuln(true, "S5 supabase/schema_v51.sql is missing, so the live database still lets a switch through while a card is being charged");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
      ${LOCK} ${SERVICE} select 'switch: ' || public.stripe_set_mode('live'); ${owner}`);
    const rows = r.out.split("\n").filter(l => /^v51 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v51 applied/.test(l)) || !pick(r, "switch").startsWith("not switched"),
      `S5 running v51 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then a switch during a payment: ${short(pick(r, "switch"))}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
