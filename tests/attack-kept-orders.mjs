// An agreed or paid Order can no longer be deleted by removing a row in Supabase's Table Editor (schema v39).
// Deleting an account keeps the person's agreed and paid Orders with their payment lines, history and chat (v35): a
// chargeback can come months later and the payment functions find it only through the Order. But deleting the person's
// row in the profiles table (Table Editor -> profiles -> Delete row), their chat, or the Order row itself still took all of
// that with it: the Order, its payment lines, its history, its chat and the freelancer's payout row, for the other person
// too. A chargeback after that was paid from Cuvori's balance with nothing pulled back from the freelancer.
// Now such a delete is refused with a plain message saying where people are deleted (Authentication -> Users, or the admin
// page); everything else is deleted as before, and account deletion works as before.
// K1–K3 the three rows that took a paid Order with them, K4 the rule matches account deletion for every kind of Order,
// K5–K7 account deletion as before (the person, Supabase's dashboard, an admin), K8 removing a test Order on purpose,
// K9 what a signed-in person can do, K10 running v39. Every check is rolled back.
// Run: node tests/attack-kept-orders.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 861 the client, 862 the freelancer (payout row with his Stripe account): a finished €100 protected Order in their chat,
// with its two payment lines and its history; 863 a third person with only a draft Order with 861
const CV = "'1d000000-0000-0000-0000-000000000001'", CV2 = "'1d000000-0000-0000-0000-000000000002'";
const O = "'3d000000-0000-0000-0000-000000000001'", DRAFT = "'3d000000-0000-0000-0000-000000000002'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("861")}, 'ida861@t.com', '{"first_name":"Ida"}'), (${U("862")}, 'leo862@t.com', '{"first_name":"Leo"}'), (${U("863")}, 'mia863@t.com', '{"first_name":"Mia"}');
  update public.profiles set role = 'editor' where id in (${U("862")}, ${U("863")});
  insert into public.payout_details (id, methods, stripe_account_id, stripe_payouts_enabled) values (${U("862")}, '[]', 'acct_1TestLeoAAAAAAA', true);
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("861")}, ${U("862")}), (${CV2}, ${U("861")}, ${U("863")});
  insert into public.messages (conversation_id, sender, kind, body) values (${CV}, ${U("861")}, 'text', 'Here is the footage'), (${CV}, ${U("862")}, 'text', 'Thanks');
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents,
                                accepted_at, funded_at, completed_at, stripe_payment_intent, stripe_charge_id, stripe_transfer_id)
    values (${O}, ${CV}, ${U("862")}, ${U("861")}, ${U("862")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '9 days',
            now() - interval '9 days', now() - interval '1 day', 'pi_kept861', 'ch_kept861', 'tr_kept861');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${O}, 'fund', 10000, 'pi_kept861'), (${O}, 'release', 10000, 'tr_kept861');
  insert into public.order_events (order_id, actor, event, data) values (${O}, ${U("861")}, 'completed', '{}');
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents)
    values (${DRAFT}, ${CV2}, ${U("863")}, ${U("861")}, ${U("863")}, 'Never agreed', 30, 'proposed', 'escrow', 3000);
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// a delete that may be refused: its answer (or the refusal) is kept, and the checks after it still run
const TRY = (sql) => `do $$ begin ${sql}; perform set_config('t.call', 'deleted', true); exception when others then perform set_config('t.call', 'refused: ' || sqlerrm, true); end $$; select 'call: ' || current_setting('t.call');`;
const KEPT = `select 'kept: Order ' || (select count(*) from public.contracts where id = ${O}) || ', payment lines ' || (select count(*) from public.order_payments where order_id = ${O})
  || ', history ' || (select count(*) from public.order_events where order_id = ${O}) || ', chat ' || (select count(*) from public.conversations where id = ${CV})
  || ' with ' || (select count(*) from public.messages where conversation_id = ${CV}) || ' messages, payout row ' || (select count(*) from public.payout_details where id = ${U("862")});`;
const ALL = "Order 1, payment lines 2, history 1, chat 1 with 2 messages, payout row 1";
const said = (r) => { const c = pick(r, "call"); return c.startsWith("refused") ? (/Authentication/.test(c) ? "refused, and the message says where people are deleted" : "refused: " + c.slice(9, 120)) : c; };

{ // K1–K3 the rows in the Table Editor that took a paid Order with them
  for (const [label, sql] of [["K1 the owner deletes the client's row in the profiles table", `delete from public.profiles where id = ${U("861")}`],
                              ["K2 the owner deletes the freelancer's row in the profiles table", `delete from public.profiles where id = ${U("862")}`],
                              ["K3a the owner deletes the chat (the conversations row) the Order is in", `delete from public.conversations where id = ${CV}`],
                              ["K3b the owner deletes the Order row itself", `delete from public.contracts where id = ${O}`]]) {
    const r = tx(`${TRY(sql)} ${KEPT}`);
    vuln(!pick(r, "call").startsWith("refused") || pick(r, "kept") !== ALL,
      `${label} -> ${said(r)}; ${pick(r, "kept")} (must be refused: the finished €100 Order, its 2 payment lines, its history, its chat and the payout row all stay)`);
  }
  // what nobody needs is still deleted as before: the draft Order with the third person, and her chat
  const r = tx(`${TRY(`delete from public.conversations where id = ${CV2}`)} select 'draft: ' || (select count(*) from public.contracts where id = ${DRAFT});`);
  vuln(pick(r, "call") !== "deleted" || pick(r, "draft") !== "0", `K3c the owner deletes a chat with only a draft Order in it -> ${said(r)}; draft left: ${pick(r, "draft")} (normal: deleted as before)`);
}
{ // K4 the rule is the one account deletion uses, for every kind of Order: what a deletion keeps cannot be deleted by hand
  const kinds = [
    ["a draft never agreed", "status = 'proposed'"],
    ["a declined draft", "status = 'declined', closed_at = now()"],
    ["a draft with a late payment sent back", "status = 'proposed'", "insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (O, 'refund', 100, 're_k4');"],
    ["agreed, not paid", "status = 'accepted', accepted_at = now()"],
    ["agreed, then cancelled before paying", "status = 'cancelled', accepted_at = now(), closed_at = now()"],
    ["paid outside Cuvori", "status = 'paid', accepted_at = now(), payment_mode = 'direct', funded_cents = 3000"],
    ["paid and held", "status = 'funded', accepted_at = now(), funded_cents = 3000"],
    ["refunded", "status = 'refunded', accepted_at = now(), funded_cents = 3000, refunded_cents = 3000"],
    ["charged back", "status = 'proposed', chargeback_id = 'dp_k4'"],
  ];
  const wrong = [];
  for (const [label, set, extra = ""] of kinds) {
    const prep = `update public.contracts set ${set} where id = ${DRAFT}; ${extra.replace(/\bO\b/g, DRAFT)}`;
    // what account deletion keeps: its own rule, run for the third person (the waiting while money is held is left out here)
    const keep = tx(`${prep} select 'answer: ok' from (select public.purge_user_data(${U("863")})) x; select 'kept: ' || (select count(*) from public.contracts where id = ${DRAFT});`);
    const del = tx(`${prep} ${TRY(`delete from public.contracts where id = ${DRAFT}`)}`);
    const keeps = pick(keep, "kept") === "1", refused = pick(del, "call").startsWith("refused");
    if (pick(keep, "answer") !== "ok" || keeps !== refused) wrong.push(`${label}: account deletion ${pick(keep, "answer") === "ok" ? (keeps ? "keeps it" : "removes it") : "answered " + pick(keep, "answer")}, deleting the row by hand ${refused ? "is refused" : "works"}`);
  }
  vuln(wrong.length > 0, `K4 ${kinds.length} kinds of Order: what account deletion keeps can never be deleted by hand, and what it removes still can -> ${wrong.length ? wrong.join("; ") : "the same for all " + kinds.length}`);
}
const PERSON = (n) => `select 'person: sign-in ' || (select count(*) from auth.users where id = ${U(n)}) || ', profile ' || coalesce((select case when deleted_at is not null then 'emptied' else 'still there' end from public.profiles where id = ${U(n)}), 'gone');`;
{ // K5–K7 account deletion works as before
  const r = tx(`${as("861")} select 'answer: ' || public.delete_my_account(); ${owner} ${KEPT} ${PERSON("861")} select 'draft: ' || (select count(*) from public.contracts where id = ${DRAFT});`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "kept") !== "Order 1, payment lines 2, history 1, chat 1 with 1 messages, payout row 1" || pick(r, "person") !== "sign-in 0, profile emptied" || pick(r, "draft") !== "0",
    `K5 the client deletes her account -> ${pick(r, "answer")}; ${pick(r, "kept")}; ${pick(r, "person")}; draft left ${pick(r, "draft")} (normal: the paid Order stays with its records, her own message goes, the draft goes)`);
  const r2 = tx(`${TRY(`delete from auth.users where id = ${U("862")}`)} ${KEPT} ${PERSON("862")}`);
  vuln(pick(r2, "call") !== "deleted" || !pick(r2, "kept").startsWith("Order 1, payment lines 2, history 1, chat 1") || pick(r2, "person") !== "sign-in 0, profile emptied",
    `K6 the owner deletes the freelancer under Authentication -> Users -> Delete user -> ${said(r2)}; ${pick(r2, "kept")}; ${pick(r2, "person")} (normal)`);
  const r3 = tx(`${as("401")} select 'answer: ' || public.admin_delete_user(${U("863")}); ${owner} ${PERSON("863")} select 'draft: ' || (select count(*) from public.contracts where id = ${DRAFT});`);
  vuln(pick(r3, "answer") !== "ok" || pick(r3, "person") !== "sign-in 0, profile gone" || pick(r3, "draft") !== "0",
    `K7 an admin deletes a person who has only a draft Order -> ${pick(r3, "answer")}; ${pick(r3, "person")}; draft left ${pick(r3, "draft")} (normal: everything goes, the profile row too)`);
}
{ // K8 removing a test Order on purpose, in the SQL editor (one run)
  const r = tx(`select set_config('cuvori.remove_kept_order', 'yes', true); ${TRY(`delete from public.contracts where id = ${O}`)} ${KEPT}`);
  vuln(pick(r, "call") !== "deleted" || !pick(r, "kept").startsWith("Order 0, payment lines 0, history 0"),
    `K8 the owner removes a test Order on purpose (cuvori.remove_kept_order set in the same run) -> ${said(r)}; ${pick(r, "kept")} (normal: it goes, with its records)`);
}
{ // K9 a signed-in person, even with that setting
  const r = tx(`${as("861")} select set_config('cuvori.remove_kept_order', 'yes', true); ${TRY(`delete from public.contracts where id = ${O}`)} ${TRY(`delete from public.profiles where id = ${U("861")}`)} ${owner} ${KEPT}`);
  vuln(pick(r, "kept") !== ALL, `K9 the client tries to delete the Order and her profile row through the database, with that setting -> ${pick(r, "kept")} (nothing may go)`);
}
{ // K10 running v39 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v39.sql");
  if (!fs.existsSync(f)) vuln(true, "K10 supabase/schema_v39.sql is missing, so the live database still lets a row in the Table Editor take a paid Order with it");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
                  ${TRY(`delete from public.profiles where id = ${U("861")}`)} ${KEPT}`);
    const rows = r.out.split("\n").filter(l => /^v39 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v39 applied/.test(l)) || pick(r, "kept") !== ALL,
      `K10 running v39 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then deleting the client's profile row: ${said(r)}, ${pick(r, "kept")}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
