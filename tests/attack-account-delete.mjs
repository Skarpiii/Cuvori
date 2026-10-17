// Deleting an account keeps the records of its Orders (schema v35). A chargeback can come months after an Order is
// finished, and a fee surplus or a re-payment after a won chargeback can still be on its way. The payment functions find
// all of that only through the Order and its payment lines. When either person deleted their account, those rows used to
// go with it: the chargeback was then taken from Cuvori's balance with nothing pulled back from the freelancer, and a
// re-payment still owed to a freelancer was never made. The privacy notice already says contract and payment records are
// kept when an account is closed.
// Now: an Order that was agreed or took money through Cuvori stays, with its payment lines and history; the person's
// sign-in, name, e-mail, bank details, profile, posts, messages and reviews go. Deleting is refused while money is still
// on its way for one of their Orders: held, a chargeback the bank is deciding, a re-payment still owed, or a payment
// being taken right now.
// A1–A2 a finished Order after the client / the freelancer deleted their account, A3–A4 when deleting must wait, A5 an
// account with nothing agreed, A6 what goes and what stays, A7 a deletion from Supabase's own dashboard, A8 the admin lists,
// A9–A10 a chargeback after both people deleted their accounts (the payment functions), A11 a chargeback with no Order.
// Run: node tests/attack-account-delete.mjs   (needs the local Postgres of tests/db; it is started here)
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

const run = (sql) => { const r = spawnSync("psql", [...PSQL, "-c", sql], { encoding: "utf8" }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const U = (n) => `t.u('${n}')`;
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 701 client and 702 freelancer with a finished protected Order between them (paid €103.62, €100 to the freelancer), their
// chat, her job post, his public profile, a service and bank details, a flag and an identity check; 701 also has a
// draft Order with 703 that was never agreed. Everything is rolled back after each check.
const O = "'37000000-0000-0000-0000-000000000001'", DRAFT = "'37000000-0000-0000-0000-000000000002'";
const CONV = "'17000000-0000-0000-0000-000000000001'", CONV2 = "'17000000-0000-0000-0000-000000000002'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("701")}, 'ana@t.com', '{"first_name":"Ana"}'), (${U("702")}, 'ben@t.com', '{"first_name":"Ben"}'), (${U("703")}, 'cid@t.com', '{"first_name":"Cid"}');
  update public.profiles set role = 'editor' where id in (${U("702")}, ${U("703")});
  insert into public.editor_profiles (id, display_name, is_public) values (${U("702")}, 'Ben Edits', true);
  insert into public.services (profile_id, profession_slug) select ${U("702")}, slug from public.professions limit 1;
  insert into public.payout_details (id, methods, note, stripe_account_id, stripe_payouts_enabled) values (${U("702")}, '[{"type":"bank","details":"LT12 1000 0111 0100 1000"}]', 'Ben, Vilnius', 'acct_1BenStripeAcct00', true);
  insert into public.identity_verifications (user_id, status) values (${U("701")}, 'verified');
  insert into public.user_flags (user_id, kind, reason) values (${U("701")}, 'other', 'a note about Ana');
  insert into public.jobs (id, owner, title, status) values ('67000000-0000-0000-0000-000000000001', ${U("701")}, 'Ana''s job', 'open');
  insert into public.conversations (id, user_a, user_b) values (${CONV}, ${U("701")}, ${U("702")}), (${CONV2}, ${U("701")}, ${U("703")});
  insert into public.messages (conversation_id, sender, kind, body) values (${CONV}, ${U("701")}, 'text', 'from Ana'), (${CONV}, ${U("702")}, 'text', 'from Ben'), (${CONV2}, ${U("701")}, 'text', 'Ana to Cid');
  insert into public.reviews (editor, client, stars, body) values (${U("702")}, ${U("701")}, 5, 'old review');
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents,
                                accepted_at, funded_at, completed_at, stripe_payment_intent, stripe_charge_id, stripe_transfer_id)
    values (${O}, ${CONV}, ${U("702")}, ${U("701")}, ${U("702")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '9 days',
            now() - interval '9 days', now() - interval '1 day', 'pi_acct701', 'ch_acct701', 'tr_acct701');
  insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider_ref, charge_ref) values (${O}, 'fund', 10000, 362, 'pi_acct701', 'ch_acct701');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${O}, 'release', 10000, 'tr_acct701');
  insert into public.order_events (order_id, event) values (${O}, 'funded'), (${O}, 'released');
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents)
    values (${DRAFT}, ${CONV2}, ${U("703")}, ${U("701")}, ${U("703")}, 'Draft', 50, 'proposed', 'escrow', 5000);
`;
const tx = (body) => run(`begin; ${SETUP} ${body}; rollback;`);
// the value printed after a label ("label: value") by the statement that prints it
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^ERROR/.test(x)) || "").replace(/^ERROR:\s*/, "")); };
const del = (who) => `${as(who)} select 'answer: ' || public.delete_my_account(); ${owner}`;
// what the payment functions look up for a chargeback (contractByPi): the Order by its payment, or its fund line
const KEPT = `select 'order: ' || (select count(*) from public.contracts where id = ${O}) || ' lines ' || (select count(*) from public.order_payments where order_id = ${O})
                 || ' history ' || (select count(*) from public.order_events where order_id = ${O})
                 || ' found by payment ' || ((select count(*) from public.contracts where stripe_payment_intent = 'pi_acct701') + (select count(*) from public.order_payments where provider_ref = 'pi_acct701' and kind = 'fund'));`;
const PERSON = (n) => `select 'person: ' || 'sign-in ' || (select count(*) from auth.users where id = ${U(n)}) || ', profile ' || coalesce((select coalesce(email, '-') || ' / ' || coalesce(first_name, '-') || ' / ' || case when deleted_at is null then 'not marked' else 'marked deleted' end from public.profiles where id = ${U(n)}), 'gone');`;

{ // A1 the client deletes her account the day after a finished, paid Order
  const r = tx(`${del("701")} ${KEPT} ${PERSON("701")} ${as("702")} select 'freelancer sees: ' || (select count(*) from public.contracts where id = ${O}) || ' order, ' || (select count(*) from public.order_payments where order_id = ${O}) || ' payment lines'`);
  const ans = pick(r, "answer"), kept = pick(r, "order"), person = pick(r, "person"), sees = pick(r, "freelancer sees");
  vuln(ans !== "ok" || kept !== "1 lines 2 history 2 found by payment 2" || person !== "sign-in 0, profile - / - / marked deleted" || sees !== "1 order, 2 payment lines",
    `A1 the client deletes her account a day after a paid, finished Order -> ${ans}; Order ${kept}; Ana: ${person}; the freelancer still sees ${sees} (the Order, its payment lines and history must stay, found by its payment; her sign-in, e-mail and name must go)`);
}
{ // A2 the freelancer deletes his account
  const r = tx(`${del("702")} ${KEPT} ${PERSON("702")} select 'payout: ' || coalesce((select coalesce(stripe_account_id, '-') || ' / methods ' || jsonb_array_length(methods) || ' / note "' || coalesce(note, '') || '"' from public.payout_details where id = ${U("702")}), 'gone');
     select 'public profile: ' || (select count(*) from public.editor_profiles where id = ${U("702")}) || ', services ' || (select count(*) from public.services where profile_id = ${U("702")});
     ${as("701")} select 'client sees: ' || (select count(*) from public.contracts where id = ${O}) || ' order'`);
  const ans = pick(r, "answer"), kept = pick(r, "order"), person = pick(r, "person"), payout = pick(r, "payout"), pub = pick(r, "public profile"), sees = pick(r, "client sees");
  vuln(ans !== "ok" || kept !== "1 lines 2 history 2 found by payment 2" || person !== "sign-in 0, profile - / - / marked deleted" || payout !== `acct_1BenStripeAcct00 / methods 0 / note ""` || pub !== "0, services 0" || sees !== "1 order",
    `A2 the freelancer deletes his account after the same Order -> ${ans}; Order ${kept}; Ben: ${person}; payout ${payout}; ${pub}; the client still sees ${sees} (his Stripe account stays for a re-payment after a won chargeback; his bank details, note, profile and services must go)`);
}
{ // A3 a won chargeback whose re-payment to the freelancer is still owed: nobody can delete their way out of it
  const owed = `update public.contracts set released_cents = 0, chargeback_id = 'dp_acct701', chargeback_status = 'won', chargeback_cents = 10362,
                  money_error = 'chargeback won, re-payment failed: the freelancer''s Stripe account cannot receive money yet' where id = ${O};`;
  for (const [who, label] of [["701", "the client"], ["702", "the freelancer"]]) {
    const r = tx(`${owed} ${del(who)} ${KEPT}`);
    vuln(pick(r, "answer") !== "active_payments" || pick(r, "order") !== "1 lines 2 history 2 found by payment 2",
      `A3 ${label} deletes their account while the freelancer is still owed €100 after a won chargeback -> ${pick(r, "answer")}; Order ${pick(r, "order")} (must wait: active_payments)`);
  }
  const r = tx(`${owed} ${as("401")} select 'answer: ' || public.admin_delete_user(${U("701")}); ${owner} ${KEPT}`);
  vuln(pick(r, "answer") !== "active_payments", `A3 an admin deletes the client in the same moment -> ${pick(r, "answer")} (must wait: active_payments)`);
}
{ // A4 a payment step is running on one of her Orders right now (the payment lock is held); a lock left by a step that died does not count
  for (const [age, want, label] of [["5 seconds", "active_payments", "a payment is being taken right now"], ["2 minutes", "ok", "a lock left 2 minutes ago by a step that died"]]) {
    const r = tx(`insert into public.money_keys (scope, key, created_at) values ('lock:' || ${O}, 'claim:x', now() - interval '${age}'); ${del("701")}`);
    vuln(pick(r, "answer") !== want, `A4 the client deletes her account while ${label} -> ${pick(r, "answer")} (must be ${want})`);
  }
}
{ // A5 an account with nothing agreed: everything goes, as before (no record is left behind). The finished Order is removed
  // first, on purpose, the way the owner removes a test Order (v39 refuses it otherwise)
  const r = tx(`select set_config('cuvori.remove_kept_order', 'yes', true); delete from public.contracts where id = ${O}; ${del("701")} ${PERSON("701")}
     select 'left: ' || (select count(*) from public.contracts where id = ${DRAFT}) || ' draft, ' || (select count(*) from public.conversations where user_a = ${U("701")} or user_b = ${U("701")}) || ' chats'`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "person") !== "sign-in 0, profile gone" || pick(r, "left") !== "0 draft, 0 chats",
    `A5 a client with only a draft Order deletes her account -> ${pick(r, "answer")}; ${pick(r, "person")}; ${pick(r, "left")} (everything must go, profile included)`);
}
{ // A6 what goes and what stays when the client deletes her account
  const r = tx(`${del("701")}
     select 'gone: ' || (select count(*) from public.messages where sender = ${U("701")}) || ' messages, ' || (select count(*) from public.jobs where owner = ${U("701")}) || ' jobs, '
       || (select count(*) from public.reviews where client = ${U("701")}) || ' reviews, ' || (select count(*) from public.user_flags where user_id = ${U("701")}) || ' flags, '
       || (select count(*) from public.identity_verifications where user_id = ${U("701")}) || ' identity, ' || (select count(*) from public.user_identifiers where user_id = ${U("701")}) || ' identifiers, '
       || (select count(*) from public.contracts where id = ${DRAFT}) || ' draft, ' || (select count(*) from public.conversations where id = ${CONV2}) || ' chat without a kept Order';
     select 'stays: ' || (select count(*) from public.conversations where id = ${CONV}) || ' chat of the kept Order, ' || (select count(*) from public.messages where conversation_id = ${CONV} and sender = ${U("702")}) || ' message from the freelancer'`);
  vuln(pick(r, "gone") !== "0 messages, 0 jobs, 0 reviews, 0 flags, 0 identity, 0 identifiers, 0 draft, 0 chat without a kept Order" || pick(r, "stays") !== "1 chat of the kept Order, 1 message from the freelancer",
    `A6 what goes with her account -> ${pick(r, "gone")}; what stays -> ${pick(r, "stays")} (her messages, posts, reviews, flags, checks and the draft must go; the kept Order's chat stays for the freelancer)`);
}
{ // A7 an account deleted from Supabase's own dashboard (Authentication -> Users -> Delete user) gets the same treatment
  const r = tx(`delete from auth.users where id = ${U("701")}; ${KEPT} ${PERSON("701")} select 'gone: ' || (select count(*) from public.messages where sender = ${U("701")}) || ' messages, ' || (select count(*) from public.jobs where owner = ${U("701")}) || ' jobs'`);
  vuln(pick(r, "order") !== "1 lines 2 history 2 found by payment 2" || pick(r, "person") !== "sign-in 0, profile - / - / marked deleted" || pick(r, "gone") !== "0 messages, 0 jobs",
    `A7 the owner deletes the client in Supabase's dashboard -> Order ${pick(r, "order")}; Ana: ${pick(r, "person")}; ${pick(r, "gone")} (the same as a deletion from Cuvori)`);
}
{ // A8 the admin panel lists people, not records kept for the books
  const r = tx(`${del("701")} ${as("401")} select 'listed: ' || (select count(*) from public.admin_list_users() where id = ${U("701")}) || ' in users, ' || (select count(*) from public.admin_list_bad_actors() where id = ${U("701")}) || ' in flagged'`);
  vuln(pick(r, "listed") !== "0 in users, 0 in flagged", `A8 after the client deleted her account, the admin lists -> ${pick(r, "listed")} (a deleted account is not a user any more)`);
}

// ---------- the payment functions with what a deletion leaves (their own test copy of the database and of Stripe) ----------
{
  const H = await import("./fn-harness.mjs");
  const { DB, STRIPE, users, hooks, req, signed, call, mk, fund, moneyOut, reset, fns } = H;
  const logs = []; const e0 = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
  const fx = await fns();
  const euro = (c) => `€${((c || 0) / 100).toFixed(2)}`;
  const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
  const dispute = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: ch.amount, status: extra.status || "needs_response", ...extra } } });
  const paidOut = async () => { const c = mk(); const f = await fund(fx, c); c.status = "delivered"; await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } })); return { c, f }; };
  // what purge_user_data leaves for a person on a kept Order (schema v35): an empty profile marked deleted; a freelancer
  // keeps the Stripe account id, without bank details or note
  const deleted = (u) => { const p = DB.profiles.find(x => x.id === u.id); Object.assign(p, { email: null, first_name: null, deleted_at: new Date().toISOString() });
                           const d = DB.payout_details.find(x => x.id === u.id); if (d) Object.assign(d, { methods: [], note: "" }); };
  const pulledBack = (c) => STRIPE.reversals.filter(r => STRIPE.transfers.some(t => t.id === r.transfer && t.contract === c.id)).reduce((a, r) => a + r.amount, 0);
  { // A9 a chargeback after the client and the freelancer both deleted their accounts: the Order is still there
    const { c, f } = await paidOut();
    deleted(users.cl); deleted(users.ed);
    const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
    const w = await call(fx.webhook, req("POST", "x", dispute("charge.dispute.created", ch)));
    vuln(w.status !== 200 || pulledBack(c) !== 10000 || c.chargeback_status !== "open",
      `A9 a chargeback of ${euro(ch.amount)} after both people deleted their accounts -> webhook ${w.status}; pulled back from the freelancer ${euro(pulledBack(c))}; chargeback ${c.chargeback_status} (the Order is kept, so the money comes back from the freelancer as for any chargeback)`);
    // A10 the bank sides with Cuvori: the freelancer is paid again, to the Stripe account kept with the deleted account
    STRIPE.disputes[ch.id] = { status: "won" };
    const w2 = await call(fx.webhook, req("POST", "x", dispute("charge.dispute.closed", ch, { status: "won" })));
    vuln(w2.status !== 200 || moneyOut(c).transferred !== 10000 || c.chargeback_status !== "won",
      `A10 the bank then sides with Cuvori -> webhook ${w2.status}; the freelancer has ${euro(moneyOut(c).transferred)} again (must be €100.00); chargeback ${c.chargeback_status}`);
    reset();
    Object.assign(DB.profiles.find(x => x.id === users.cl.id), { email: users.cl.email, first_name: "cl", deleted_at: null });
    Object.assign(DB.profiles.find(x => x.id === users.ed.id), { email: users.ed.email, first_name: "ed", deleted_at: null });
  }
  { // A11 a chargeback on a payment with no Order on record (an Order deleted before v35): the log says so
    const { c, f } = await paidOut();
    for (const t of ["contracts", "order_payments", "order_events"]) DB[t] = DB[t].filter(r => (t === "contracts" ? r.id : r.order_id) !== c.id);
    const ch = chargeOf(f.session.payment_intent); STRIPE.disputes[ch.id] = { status: "needs_response" };
    const l0 = logs.length;
    const w = await call(fx.webhook, req("POST", "x", dispute("charge.dispute.created", ch, { id: "dp_noorder" })));
    const line = logs.slice(l0).find(l => /no Order on record/.test(l) && l.includes("dp_noorder"));
    vuln(w.status !== 200 || !line, `A11 a chargeback on a payment whose Order was deleted before this fix -> webhook ${w.status}; Netlify log: ${line ? JSON.stringify(line.slice(0, 120)) : "nothing"} (must say which dispute to answer in Stripe's dashboard)`);
    reset();
  }
  console.error = e0;
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
